// Phase 4 (2026-05-01) — pool accounting.
//
// SatRank's fulfill proxy operates a "skin in the game" pool: agents pay a
// premium on every successful delivery; SatRank absorbs the cost when a
// candidate paid out but didn't deliver to the agent. Net pool balance is
//   sum(fulfill_jobs.premium_sats WHERE status='success')
//   - sum(refund_ledger.sats_absorbed)
//
// This service is the single source of truth. It's a thin read aggregator
// — no writes — with a 5s in-memory cache to avoid hammering Postgres on
// every fulfill (the circuit breaker reads on every fulfill).
//
// Solvency invariant: balance must stay above MIN_POOL_SATS or the circuit
// breaker opens. Default 10000 sats; env-overridable.
import type { Pool } from 'pg';
import { logger } from '../logger';

const POOL_CACHE_TTL_MS = 5_000;

export const FULFILL_POOL_MIN_SATS_DEFAULT = parseInt(
  process.env.FULFILL_POOL_MIN_SATS ?? '10000',
  10,
);

export interface PoolBalance {
  /** Net balance (premium_revenue - sats_absorbed) over all time. */
  balance_sats: number;
  /** Lifetime premium revenue (success-only billing). */
  premium_revenue_sats: number;
  /** Lifetime sats_absorbed via refund_ledger. */
  sats_absorbed_sats: number;
  /** Trailing-24h figures for dashboards. */
  premium_revenue_24h: number;
  sats_absorbed_24h: number;
  /** Sats this fulfill could allocate before tripping the breaker. */
  headroom_sats: number;
  /** Configured solvency floor — below this, circuit breaker opens. */
  min_pool_sats: number;
  /** True when balance < min_pool_sats. /api/fulfill returns 503 in this state. */
  circuit_breaker_open: boolean;
  /** Timestamp the snapshot was computed at. */
  computed_at: number;
}

export interface PoolAccountingDeps {
  pool: Pool;
  /** Solvency floor; defaults to FULFILL_POOL_MIN_SATS_DEFAULT. */
  minPoolSats?: number;
  /** Override for tests; defaults to Date.now()/1000. */
  now?: () => number;
}

export class PoolAccountingService {
  private readonly minPoolSats: number;
  private readonly now: () => number;
  private cache: { value: PoolBalance; cachedAtMs: number } | null = null;

  constructor(private readonly deps: PoolAccountingDeps) {
    this.minPoolSats = deps.minPoolSats ?? FULFILL_POOL_MIN_SATS_DEFAULT;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Snapshot of the pool. Caches for 5s — fulfill calls in a burst share
   *  the same balance, which is fine: a lag of seconds doesn't change
   *  whether the breaker should be open. */
  async getBalance(): Promise<PoolBalance> {
    if (this.cache && Date.now() - this.cache.cachedAtMs < POOL_CACHE_TTL_MS) {
      return this.cache.value;
    }
    const value = await this.computeBalance();
    this.cache = { value, cachedAtMs: Date.now() };
    return value;
  }

  /** Force-recompute (skip cache). Used by tests + the health probe. */
  async refresh(): Promise<PoolBalance> {
    const value = await this.computeBalance();
    this.cache = { value, cachedAtMs: Date.now() };
    return value;
  }

  private async computeBalance(): Promise<PoolBalance> {
    const nowSec = this.now();
    const yesterday = nowSec - 86400;

    // Two queries are intentionally separate (not a JOIN) so each runs
    // against its own index without a filesort.
    const [premiumLifetime, premium24h, absorbedLifetime, absorbed24h] = await Promise.all([
      this.queryNumber(
        `SELECT COALESCE(SUM(premium_sats), 0)::text AS s FROM fulfill_jobs WHERE status = 'success'`,
      ),
      this.queryNumber(
        `SELECT COALESCE(SUM(premium_sats), 0)::text AS s
           FROM fulfill_jobs WHERE status = 'success' AND settled_at >= $1`,
        [yesterday],
      ),
      this.queryNumber(
        `SELECT COALESCE(SUM(sats_absorbed), 0)::text AS s FROM refund_ledger`,
      ),
      this.queryNumber(
        `SELECT COALESCE(SUM(sats_absorbed), 0)::text AS s FROM refund_ledger WHERE ts >= $1`,
        [yesterday],
      ),
    ]);

    const balance = premiumLifetime - absorbedLifetime;
    const headroom = Math.max(0, balance - this.minPoolSats);
    const breakerOpen = balance < this.minPoolSats;

    if (breakerOpen) {
      // Loud warning every snapshot — ops should see this in logs and
      // step in. Real-world signal: either premium too low, refund cap
      // too generous, or a bad-faith operator pattern.
      logger.warn(
        {
          balance_sats: balance,
          min_pool_sats: this.minPoolSats,
          premium_revenue_sats: premiumLifetime,
          sats_absorbed_sats: absorbedLifetime,
        },
        'Pool circuit breaker is OPEN — /api/fulfill will reject new jobs',
      );
    }

    return {
      balance_sats: balance,
      premium_revenue_sats: premiumLifetime,
      sats_absorbed_sats: absorbedLifetime,
      premium_revenue_24h: premium24h,
      sats_absorbed_24h: absorbed24h,
      headroom_sats: headroom,
      min_pool_sats: this.minPoolSats,
      circuit_breaker_open: breakerOpen,
      computed_at: nowSec,
    };
  }

  private async queryNumber(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await this.deps.pool.query<{ s: string }>(sql, params);
    return Number(rows[0]?.s ?? 0);
  }
}
