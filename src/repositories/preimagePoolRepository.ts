// Accès données pour preimage_pool — table qui gate les reports anonymes.
// Le pool est alimenté par 3 voies (crawler/intent/report) et consommé
// atomiquement par reportService lors d'un report anonyme. consumed_at est
// le verrou one-shot : UPDATE ... WHERE consumed_at IS NULL garantit qu'une
// preimage ne peut être consommée qu'une seule fois.
import type Database from 'better-sqlite3';

export type PreimagePoolTier = 'high' | 'medium' | 'low';
export type PreimagePoolSource = 'crawler' | 'intent' | 'report';

export interface PreimagePoolEntry {
  payment_hash: string;
  bolt11_raw: string | null;
  first_seen: number;
  confidence_tier: PreimagePoolTier;
  source: PreimagePoolSource;
  consumed_at: number | null;
  consumer_report_id: string | null;
}

export interface PreimagePoolInsert {
  paymentHash: string;
  bolt11Raw: string | null;
  firstSeen: number;
  confidenceTier: PreimagePoolTier;
  source: PreimagePoolSource;
}

export class PreimagePoolRepository {
  constructor(private db: Database.Database) {}

  /** Insère une entrée si payment_hash absent. Retourne true si une ligne a
   *  été créée, false sinon. Idempotent par design (INSERT OR IGNORE). */
  insertIfAbsent(entry: PreimagePoolInsert): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO preimage_pool
         (payment_hash, bolt11_raw, first_seen, confidence_tier, source)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.paymentHash, entry.bolt11Raw, entry.firstSeen, entry.confidenceTier, entry.source);
    return result.changes === 1;
  }

  findByPaymentHash(paymentHash: string): PreimagePoolEntry | null {
    const row = this.db
      .prepare(
        `SELECT payment_hash, bolt11_raw, first_seen, confidence_tier, source, consumed_at, consumer_report_id
         FROM preimage_pool WHERE payment_hash = ?`,
      )
      .get(paymentHash) as PreimagePoolEntry | undefined;
    return row ?? null;
  }

  /** Consomme atomiquement une entrée du pool. Retourne true si l'UPDATE
   *  a posé le verrou (1 row), false sinon (déjà consommée ou inexistante).
   *  Le caller utilise la valeur de retour pour décider entre 200/409. */
  consumeAtomic(paymentHash: string, reportId: string, consumedAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE preimage_pool
         SET consumed_at = ?, consumer_report_id = ?
         WHERE payment_hash = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, reportId, paymentHash);
    return result.changes === 1;
  }

  countByTier(): Record<PreimagePoolTier, number> {
    const rows = this.db
      .prepare('SELECT confidence_tier, COUNT(*) as count FROM preimage_pool GROUP BY confidence_tier')
      .all() as { confidence_tier: PreimagePoolTier; count: number }[];
    const out: Record<PreimagePoolTier, number> = { high: 0, medium: 0, low: 0 };
    for (const r of rows) out[r.confidence_tier] = r.count;
    return out;
  }
}

/** Mapping confidence_tier → reporter_weight appliqué aux transactions issues
 *  d'un report anonyme consommant le pool. Les weights legacy (NIP-98/API-key)
 *  restent à 1.0 via le path reportService standard et n'utilisent pas ce
 *  mapping. */
export function tierToReporterWeight(tier: PreimagePoolTier): number {
  switch (tier) {
    case 'high':
      return 0.7;
    case 'medium':
      return 0.5;
    case 'low':
      return 0.3;
  }
}
