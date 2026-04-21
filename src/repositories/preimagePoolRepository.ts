// Accès données pour preimage_pool — table qui gate les reports anonymes.
// Le pool est alimenté par 3 voies (crawler/intent/report) et consommé
// atomiquement par reportService lors d'un report anonyme. consumed_at est
// le verrou one-shot : UPDATE ... WHERE consumed_at IS NULL garantit qu'une
// preimage ne peut être consommée qu'une seule fois.
// (pg async port, Phase 12B)
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

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
  constructor(private db: Queryable) {}

  /** Insère une entrée si payment_hash absent. Retourne true si une ligne a
   *  été créée, false sinon. Idempotent par design (ON CONFLICT DO NOTHING). */
  async insertIfAbsent(entry: PreimagePoolInsert): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO preimage_pool
         (payment_hash, bolt11_raw, first_seen, confidence_tier, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payment_hash) DO NOTHING`,
      [entry.paymentHash, entry.bolt11Raw, entry.firstSeen, entry.confidenceTier, entry.source],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async findByPaymentHash(paymentHash: string): Promise<PreimagePoolEntry | null> {
    const { rows } = await this.db.query<PreimagePoolEntry>(
      `SELECT payment_hash, bolt11_raw, first_seen, confidence_tier, source, consumed_at, consumer_report_id
       FROM preimage_pool WHERE payment_hash = $1`,
      [paymentHash],
    );
    return rows[0] ?? null;
  }

  /** Consomme atomiquement une entrée du pool. Retourne true si l'UPDATE
   *  a posé le verrou (1 row), false sinon (déjà consommée ou inexistante).
   *  Le caller utilise la valeur de retour pour décider entre 200/409. */
  async consumeAtomic(paymentHash: string, reportId: string, consumedAt: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE preimage_pool
       SET consumed_at = $1, consumer_report_id = $2
       WHERE payment_hash = $3 AND consumed_at IS NULL`,
      [consumedAt, reportId, paymentHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async countByTier(): Promise<Record<PreimagePoolTier, number>> {
    const { rows } = await this.db.query<{ confidence_tier: PreimagePoolTier; count: string }>(
      'SELECT confidence_tier, COUNT(*)::text AS count FROM preimage_pool GROUP BY confidence_tier',
    );
    const out: Record<PreimagePoolTier, number> = { high: 0, medium: 0, low: 0 };
    for (const r of rows) out[r.confidence_tier] = Number(r.count);
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
