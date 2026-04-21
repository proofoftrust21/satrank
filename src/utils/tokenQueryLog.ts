// Token → target query log. Persists "token X queried target Y" facts so
// that /api/report can scope reports to targets the token has actually
// looked at.
//
// Historique (enlevé Phase 10) : la table s'appelait `decide_log` du temps
// où seul /api/decide l'alimentait. /api/decide supprimé en Phase 10 C2 ;
// renommée `token_query_log` en migration v41 pour refléter son rôle réel
// (tous les paid target-query paths la peuplent : verdict, profile, verdicts).
//
// Rate-limit / dedup / anti-spam est enforced downstream dans
// reportService.submit (per-reporter window, per-target dedup); ce fichier
// n'établit que le fait "ce token a-t-il déjà consulté cette target".
//
// Phase 12B : port better-sqlite3 → pg. L'insert est async, fire-and-logged
// (jamais raised) pour garder la même sémantique que la version SQLite :
// observabilité > consistance stricte du log.
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { logger } from '../logger';

/** Extract the L402 preimage from an Authorization header.
 *  Returns null if the header is missing, malformed, or not an L402 token. */
export function extractL402Preimage(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}

/** Insert a `(payment_hash, target_hash)` row into token_query_log. Idempotent
 *  (ON CONFLICT DO NOTHING). Safe to call on every paid target-query request —
 *  failures are logged at warn but never raised: observability matters
 *  more than strict consistency of the log. */
export async function logTokenQuery(
  pool: Pool | undefined,
  authHeader: string | undefined,
  targetHash: string,
  requestId?: string,
): Promise<void> {
  if (!pool) return;
  const preimage = extractL402Preimage(authHeader);
  if (!preimage) return;
  try {
    const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      'INSERT INTO token_query_log (payment_hash, target_hash, decided_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [paymentHash, targetHash, now],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, targetHash, requestId }, 'token_query_log insert failed');
  }
}
