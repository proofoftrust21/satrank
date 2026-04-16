// Token → target query log. Historically named `decide_log` because only
// /api/decide wrote to it; as of 2026-04-16 every paid target-query path
// populates it so any L402 token that ever looked up a target can later
// report on that target.
//
// Why widen it: report adoption was blocked because 61% of paying tokens
// never hit /api/decide (they used verdict / profile / best-route). Under
// the old rule those tokens could not submit reports even though the user
// had clearly interacted with the target.
//
// Rate-limit / dedup / anti-spam is still enforced downstream in
// reportService.submit (per-reporter window, per-target dedup); this file
// only establishes the "has this token ever looked at this target" fact.
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../logger';

/** Extract the L402 preimage from an Authorization header.
 *  Returns null if the header is missing, malformed, or not an L402 token. */
export function extractL402Preimage(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}

/** Cache of prepared statements keyed by DB instance (audit M10). The hot
 *  path fires on every paid target-query (5 endpoints); re-preparing on each
 *  call paid a per-request parse cost that's trivial individually but adds up
 *  under load. WeakMap keeps the cache tied to the DB lifetime without
 *  preventing GC when the DB is closed in tests. */
const preparedCache = new WeakMap<Database.Database, Database.Statement<[Buffer, string, number]>>();

function getStmt(db: Database.Database): Database.Statement<[Buffer, string, number]> {
  let stmt = preparedCache.get(db);
  if (!stmt) {
    stmt = db.prepare<[Buffer, string, number]>(
      'INSERT OR IGNORE INTO decide_log (payment_hash, target_hash, decided_at) VALUES (?, ?, ?)',
    );
    preparedCache.set(db, stmt);
  }
  return stmt;
}

/** Insert a `(payment_hash, target_hash)` row into decide_log. Idempotent
 *  (INSERT OR IGNORE). Safe to call on every paid target-query request —
 *  failures are logged at warn but never raised: observability matters
 *  more than strict consistency of the log. */
export function logTokenQuery(
  db: Database.Database | undefined,
  authHeader: string | undefined,
  targetHash: string,
  requestId?: string,
): void {
  if (!db) return;
  const preimage = extractL402Preimage(authHeader);
  if (!preimage) return;
  try {
    const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
    const now = Math.floor(Date.now() / 1000);
    getStmt(db).run(paymentHash, targetHash, now);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, targetHash, requestId }, 'decide_log insert failed');
  }
}
