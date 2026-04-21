// Tier lookup for Phase 9 engraved-rate deposits. The tier table is seeded at
// migration time (v39) and treated as read-only at runtime; this service only
// reads from it.
//
// Contract: given an amount in sats, return the tier whose min_deposit_sats
// is the largest value ≤ amount. If amount < the smallest tier floor, return
// null — the caller (deposit controller) must reject the deposit with a clear
// validation error because a rate below the floor cannot be engraved.
//
// Rate is ENGRAVED on the token_balance row at INSERT. Future schedule changes
// never alter an existing deposit's rate — rediscovering tiers at call time
// would violate that guarantee.

import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface DepositTier {
  tier_id: number;
  min_deposit_sats: number;
  rate_sats_per_request: number;
  discount_pct: number;
}

export class DepositTierService {
  private readonly pool: Queryable;

  constructor(pool: Queryable) {
    this.pool = pool;
  }

  /** Returns all tiers ordered by min_deposit_sats ascending (public schedule). */
  async listTiers(): Promise<DepositTier[]> {
    const { rows } = await this.pool.query<DepositTier>(`
      SELECT tier_id, min_deposit_sats, rate_sats_per_request, discount_pct
      FROM deposit_tiers
      ORDER BY min_deposit_sats ASC
    `);
    return rows;
  }

  /** Returns the applicable tier for an amount, or null if below the floor.
   *  "Applicable" = largest min_deposit_sats ≤ amount. */
  async lookupTierForAmount(amountSats: number): Promise<DepositTier | null> {
    if (!Number.isFinite(amountSats) || amountSats <= 0) return null;
    const { rows } = await this.pool.query<DepositTier>(
      `
      SELECT tier_id, min_deposit_sats, rate_sats_per_request, discount_pct
      FROM deposit_tiers
      WHERE min_deposit_sats <= $1
      ORDER BY min_deposit_sats DESC
      LIMIT 1
      `,
      [amountSats],
    );
    return rows[0] ?? null;
  }

  /** Credits a deposit gets = amount / rate. Float — a 500-sat deposit at
   *  rate 0.5 would be 1000 credits exactly; a 750-sat deposit at rate 0.5
   *  would be 1500. Returns 0 for a null/invalid tier. */
  computeCredits(amountSats: number, tier: DepositTier | null): number {
    if (!tier || tier.rate_sats_per_request <= 0) return 0;
    return amountSats / tier.rate_sats_per_request;
  }
}
