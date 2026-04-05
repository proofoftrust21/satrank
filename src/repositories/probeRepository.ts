// Data access for the probe_results table
import type Database from 'better-sqlite3';
import type { ProbeResult } from '../types';

export class ProbeRepository {
  constructor(private db: Database.Database) {}

  /** Insert a new probe result */
  insert(result: Omit<ProbeResult, 'id'>): void {
    this.db.prepare(`
      INSERT INTO probe_results (target_hash, probed_at, reachable, latency_ms, hops, estimated_fee_msat, failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.target_hash,
      result.probed_at,
      result.reachable,
      result.latency_ms,
      result.hops,
      result.estimated_fee_msat,
      result.failure_reason,
    );
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

  /** Count of agents that have been probed at least once */
  countProbedAgents(): number {
    const row = this.db.prepare(
      'SELECT COUNT(DISTINCT target_hash) as count FROM probe_results'
    ).get() as { count: number };
    return row.count;
  }

  /** Count of agents reachable in their most recent probe */
  countReachable(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT target_hash, MAX(probed_at) as latest
        FROM probe_results
        GROUP BY target_hash
      ) t
      JOIN probe_results p ON p.target_hash = t.target_hash AND p.probed_at = t.latest
      WHERE p.reachable = 1
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

  /** Purge probe results older than maxAgeSec */
  purgeOlderThan(maxAgeSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const result = this.db.prepare('DELETE FROM probe_results WHERE probed_at < ?').run(cutoff);
    return result.changes;
  }
}
