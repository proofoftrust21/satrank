// Data access for the probe_results table (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import type { ProbeResult } from '../types';
import { dbQueryDuration } from '../middleware/metrics';

type Queryable = Pool | PoolClient;

export class ProbeRepository {
  constructor(private db: Queryable) {}

  /** Insert a new probe result */
  async insert(result: Omit<ProbeResult, 'id'>): Promise<void> {
    await this.db.query(
      `
      INSERT INTO probe_results (target_hash, probed_at, reachable, latency_ms, hops, estimated_fee_msat, failure_reason, probe_amount_sats)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        result.target_hash,
        result.probed_at,
        result.reachable,
        result.latency_ms,
        result.hops,
        result.estimated_fee_msat,
        result.failure_reason,
        result.probe_amount_sats ?? 1000,
      ],
    );
  }

  /** Find the maximum amount (sats) for which a route exists to this target.
   *  Looks at the most recent probe per amount tier within the given window.
   *  Returns null if no probe data is available. */
  async findMaxRoutableAmount(targetHash: string, windowSec: number): Promise<number | null> {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const { rows } = await this.db.query<{ max_amount: number | null }>(
      `
      SELECT MAX(probe_amount_sats) as max_amount
      FROM (
        SELECT probe_amount_sats, reachable,
          ROW_NUMBER() OVER (PARTITION BY probe_amount_sats ORDER BY probed_at DESC) as rn
        FROM probe_results
        WHERE target_hash = $1 AND probed_at >= $2 AND probe_amount_sats IS NOT NULL
      ) sub
      WHERE rn = 1 AND reachable = 1
      `,
      [targetHash, cutoff],
    );
    return rows[0]?.max_amount ?? null;
  }

  /** Find the most recent probe result for an agent (any tier) */
  async findLatest(targetHash: string): Promise<ProbeResult | undefined> {
    const { rows } = await this.db.query<ProbeResult>(
      'SELECT * FROM probe_results WHERE target_hash = $1 ORDER BY probed_at DESC LIMIT 1',
      [targetHash],
    );
    return rows[0];
  }

  /** Latest probe at a specific tier (default: base 1k). Used for reachability
   *  decisions — a failed high-tier probe doesn't mean the node is unreachable. */
  async findLatestAtTier(targetHash: string, tier: number = 1000): Promise<ProbeResult | undefined> {
    const { rows } = await this.db.query<ProbeResult>(
      'SELECT * FROM probe_results WHERE target_hash = $1 AND probe_amount_sats = $2 ORDER BY probed_at DESC LIMIT 1',
      [targetHash, tier],
    );
    return rows[0];
  }

  /** Per-tier success rates in a window. Used by the multi-tier penalty signal.
   *  Returns { tier_sats: { success: N, total: M } } for tiers that have data. */
  async computeTierSuccessRates(targetHash: string, windowSec: number): Promise<Map<number, { success: number; total: number }>> {
    const endTimer = dbQueryDuration.startTimer({ repo: 'probe', method: 'computeTierSuccessRates' });
    try {
      const cutoff = Math.floor(Date.now() / 1000) - windowSec;
      const { rows } = await this.db.query<{ probe_amount_sats: number; success: string; total: string }>(
        `
        SELECT probe_amount_sats, SUM(CASE WHEN reachable = 1 THEN 1 ELSE 0 END)::text AS success, COUNT(*)::text AS total
        FROM probe_results
        WHERE target_hash = $1 AND probed_at >= $2 AND probe_amount_sats IS NOT NULL
        GROUP BY probe_amount_sats
        `,
        [targetHash, cutoff],
      );
      const result = new Map<number, { success: number; total: number }>();
      for (const r of rows) result.set(r.probe_amount_sats, { success: Number(r.success), total: Number(r.total) });
      return result;
    } finally {
      endTimer();
    }
  }

  /** Find all probe results for an agent, most recent first */
  async findByTarget(targetHash: string, limit: number, offset: number): Promise<ProbeResult[]> {
    const { rows } = await this.db.query<ProbeResult>(
      'SELECT * FROM probe_results WHERE target_hash = $1 ORDER BY probed_at DESC LIMIT $2 OFFSET $3',
      [targetHash, limit, offset],
    );
    return rows;
  }

  /** Count of active (non-stale) agents that have been probed at least once */
  async countProbedAgents(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(DISTINCT pr.target_hash)::text as count
      FROM probe_results pr
      JOIN agents a ON a.public_key_hash = pr.target_hash
      WHERE a.stale = 0
      `,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Count of active (non-stale) agents reachable in their most recent probe */
  async countReachable(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::text as count FROM (
        SELECT target_hash, MAX(probed_at) as latest
        FROM probe_results
        GROUP BY target_hash
      ) t
      JOIN probe_results p ON p.target_hash = t.target_hash AND p.probed_at = t.latest
      JOIN agents a ON a.public_key_hash = p.target_hash
      WHERE p.reachable = 1 AND a.stale = 0
      `,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countProbesLast24h(): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM probe_results WHERE probed_at >= $1',
      [cutoff],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Compute uptime ratio over a time window (reachable / total probes) */
  async computeUptime(targetHash: string, windowSec: number): Promise<number | null> {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const { rows } = await this.db.query<{ total: string; reachable: string }>(
      `
      SELECT COUNT(*)::text as total, SUM(CASE WHEN reachable = 1 THEN 1 ELSE 0 END)::text as reachable
      FROM probe_results WHERE target_hash = $1 AND probed_at >= $2
      `,
      [targetHash, cutoff],
    );
    const total = Number(rows[0]?.total ?? 0);
    if (total === 0) return null;
    return Number(rows[0]?.reachable ?? 0) / total;
  }

  async countByTarget(targetHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM probe_results WHERE target_hash = $1',
      [targetHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Latency distribution over a window — mean and stddev across REACHABLE probes only.
   *  Returns {count:0} when there is no usable sample. The caller decides what default
   *  to apply when count < 3 (see the multi-axis regularity formula in scoringService). */
  async getLatencyStats(targetHash: string, windowSec: number): Promise<{ count: number; mean: number; stddev: number }> {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const { rows } = await this.db.query<{ count: string; mean: number | null; mean_sq: number | null }>(
      `
      SELECT
        COUNT(*)::text AS count,
        AVG(latency_ms) AS mean,
        AVG(latency_ms * latency_ms) AS mean_sq
      FROM probe_results
      WHERE target_hash = $1 AND probed_at >= $2 AND reachable = 1 AND latency_ms IS NOT NULL
      `,
      [targetHash, cutoff],
    );
    const row = rows[0];
    const count = Number(row?.count ?? 0);
    if (!count || row?.mean === null || row?.mean_sq === null || row?.mean === undefined || row?.mean_sq === undefined) {
      return { count: 0, mean: 0, stddev: 0 };
    }
    // Population variance = E[X^2] - (E[X])^2. Guard against tiny negatives from float drift.
    const variance = Math.max(0, row.mean_sq - row.mean * row.mean);
    return { count, mean: row.mean, stddev: Math.sqrt(variance) };
  }

  /** Hop distribution over a window — same shape and caveats as getLatencyStats. */
  async getHopStats(targetHash: string, windowSec: number): Promise<{ count: number; mean: number; stddev: number }> {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const { rows } = await this.db.query<{ count: string; mean: number | null; mean_sq: number | null }>(
      `
      SELECT
        COUNT(*)::text AS count,
        AVG(hops) AS mean,
        AVG(hops * hops) AS mean_sq
      FROM probe_results
      WHERE target_hash = $1 AND probed_at >= $2 AND reachable = 1 AND hops IS NOT NULL
      `,
      [targetHash, cutoff],
    );
    const row = rows[0];
    const count = Number(row?.count ?? 0);
    if (!count || row?.mean === null || row?.mean_sq === null || row?.mean === undefined || row?.mean_sq === undefined) {
      return { count: 0, mean: 0, stddev: 0 };
    }
    const variance = Math.max(0, row.mean_sq - row.mean * row.mean);
    return { count, mean: row.mean, stddev: Math.sqrt(variance) };
  }

  /** Purge probe results older than maxAgeSec.
   *
   *  Chunked: a plain `DELETE` on a 14-day probe table can touch hundreds of
   *  thousands of rows and hold the write lock past the statement_timeout.
   *  We loop `DELETE ... WHERE id IN (SELECT id ... LIMIT 1000)` with a
   *  setImmediate yield between chunks so concurrent writers (bulk scoring,
   *  probe inserts) keep flowing.
   */
  async purgeOlderThan(maxAgeSec: number): Promise<number> {
    const CHUNK = 1000;
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    let total = 0;
    for (;;) {
      const result = await this.db.query(
        'DELETE FROM probe_results WHERE id IN (SELECT id FROM probe_results WHERE probed_at < $1 LIMIT $2)',
        [cutoff, CHUNK],
      );
      const n = result.rowCount ?? 0;
      if (n === 0) break;
      total += n;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return total;
  }
}
