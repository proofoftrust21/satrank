// Data access for the probe_results table
import type Database from 'better-sqlite3';
import type { ProbeResult } from '../types';

export class ProbeRepository {
  constructor(private db: Database.Database) {}

  /** Insert a new probe result */
  insert(result: Omit<ProbeResult, 'id'>): void {
    this.db.prepare(`
      INSERT INTO probe_results (target_hash, probed_at, reachable, latency_ms, hops, estimated_fee_msat, failure_reason, probe_amount_sats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.target_hash,
      result.probed_at,
      result.reachable,
      result.latency_ms,
      result.hops,
      result.estimated_fee_msat,
      result.failure_reason,
      result.probe_amount_sats ?? 1000,
    );
  }

  /** Find the maximum amount (sats) for which a route exists to this target.
   *  Looks at the most recent probe per amount tier within the given window.
   *  Returns null if no probe data is available. */
  findMaxRoutableAmount(targetHash: string, windowSec: number): number | null {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const row = this.db.prepare(`
      SELECT MAX(probe_amount_sats) as max_amount
      FROM (
        SELECT probe_amount_sats, reachable,
          ROW_NUMBER() OVER (PARTITION BY probe_amount_sats ORDER BY probed_at DESC) as rn
        FROM probe_results
        WHERE target_hash = ? AND probed_at >= ? AND probe_amount_sats IS NOT NULL
      )
      WHERE rn = 1 AND reachable = 1
    `).get(targetHash, cutoff) as { max_amount: number | null } | undefined;
    return row?.max_amount ?? null;
  }

  /** Find the most recent probe result for an agent */
  findLatest(targetHash: string): ProbeResult | undefined {
    return this.db.prepare(
      'SELECT * FROM probe_results WHERE target_hash = ? ORDER BY probed_at DESC LIMIT 1'
    ).get(targetHash) as ProbeResult | undefined;
  }

  /** Find all probe results for an agent, most recent first */
  findByTarget(targetHash: string, limit: number, offset: number): ProbeResult[] {
    return this.db.prepare(
      'SELECT * FROM probe_results WHERE target_hash = ? ORDER BY probed_at DESC LIMIT ? OFFSET ?'
    ).all(targetHash, limit, offset) as ProbeResult[];
  }

  /** Count of active (non-stale) agents that have been probed at least once */
  countProbedAgents(): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT pr.target_hash) as count
      FROM probe_results pr
      JOIN agents a ON a.public_key_hash = pr.target_hash
      WHERE a.stale = 0
    `).get() as { count: number };
    return row.count;
  }

  /** Count of active (non-stale) agents reachable in their most recent probe */
  countReachable(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT target_hash, MAX(probed_at) as latest
        FROM probe_results
        GROUP BY target_hash
      ) t
      JOIN probe_results p ON p.target_hash = t.target_hash AND p.probed_at = t.latest
      JOIN agents a ON a.public_key_hash = p.target_hash
      WHERE p.reachable = 1 AND a.stale = 0
    `).get() as { count: number };
    return row.count;
  }

  countProbesLast24h(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM probe_results WHERE probed_at >= ?').get(cutoff) as { count: number };
    return row.count;
  }

  /** Compute uptime ratio over a time window (reachable / total probes) */
  computeUptime(targetHash: string, windowSec: number): number | null {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const row = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN reachable = 1 THEN 1 ELSE 0 END) as reachable
      FROM probe_results WHERE target_hash = ? AND probed_at >= ?
    `).get(targetHash, cutoff) as { total: number; reachable: number };
    if (row.total === 0) return null;
    return row.reachable / row.total;
  }

  countByTarget(targetHash: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM probe_results WHERE target_hash = ?').get(targetHash) as { count: number };
    return row.count;
  }

  /** Latency distribution over a window — mean and stddev across REACHABLE probes only.
   *  Returns {count:0} when there is no usable sample. The caller decides what default
   *  to apply when count < 3 (see the multi-axis regularity formula in scoringService). */
  getLatencyStats(targetHash: string, windowSec: number): { count: number; mean: number; stddev: number } {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        AVG(latency_ms) AS mean,
        AVG(latency_ms * latency_ms) AS mean_sq
      FROM probe_results
      WHERE target_hash = ? AND probed_at >= ? AND reachable = 1 AND latency_ms IS NOT NULL
    `).get(targetHash, cutoff) as { count: number; mean: number | null; mean_sq: number | null };

    if (!row.count || row.mean === null || row.mean_sq === null) {
      return { count: 0, mean: 0, stddev: 0 };
    }
    // Population variance = E[X^2] - (E[X])^2. Guard against tiny negatives from float drift.
    const variance = Math.max(0, row.mean_sq - row.mean * row.mean);
    return { count: row.count, mean: row.mean, stddev: Math.sqrt(variance) };
  }

  /** Hop distribution over a window — same shape and caveats as getLatencyStats. */
  getHopStats(targetHash: string, windowSec: number): { count: number; mean: number; stddev: number } {
    const cutoff = Math.floor(Date.now() / 1000) - windowSec;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        AVG(hops) AS mean,
        AVG(hops * hops) AS mean_sq
      FROM probe_results
      WHERE target_hash = ? AND probed_at >= ? AND reachable = 1 AND hops IS NOT NULL
    `).get(targetHash, cutoff) as { count: number; mean: number | null; mean_sq: number | null };

    if (!row.count || row.mean === null || row.mean_sq === null) {
      return { count: 0, mean: 0, stddev: 0 };
    }
    const variance = Math.max(0, row.mean_sq - row.mean * row.mean);
    return { count: row.count, mean: row.mean, stddev: Math.sqrt(variance) };
  }

  /** Purge probe results older than maxAgeSec */
  purgeOlderThan(maxAgeSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const result = this.db.prepare('DELETE FROM probe_results WHERE probed_at < ?').run(cutoff);
    return result.changes;
  }
}
