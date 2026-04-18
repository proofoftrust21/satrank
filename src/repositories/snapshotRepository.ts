// Data access for the score_snapshots table — Phase 3 C8 bayesian-only shape.
//
// After the v34 migration, score_snapshots holds only bayesian-posterior state
// (p_success, ci95_low/high, n_obs, posterior_alpha/beta, window). The legacy
// `score` + `components` columns were dropped; rows written before v34 still
// exist with all bayesian fields NULL — every query filters on
// `p_success IS NOT NULL` to skip them.
import type Database from 'better-sqlite3';
import type { ScoreSnapshot, BayesianWindow } from '../types';
import { dbQueryDuration } from '../middleware/metrics';

/** Narrow block shape used by TrendService / batch delta queries. Subset of
 *  ScoreSnapshot — avoids forcing callers to care about posterior_alpha/beta. */
export interface SnapshotPoint {
  p_success: number;
  n_obs: number;
  computed_at: number;
}

export class SnapshotRepository {
  constructor(private db: Database.Database) {}

  findLatestByAgent(agentHash: string): ScoreSnapshot | undefined {
    return this.db.prepare(
      'SELECT * FROM score_snapshots WHERE agent_hash = ? AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1'
    ).get(agentHash) as ScoreSnapshot | undefined;
  }

  findLatestByAgents(agentHashes: string[]): Map<string, ScoreSnapshot> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findLatestByAgents: array exceeds 500 elements');
    const endTimer = dbQueryDuration.startTimer({ repo: 'snapshot', method: 'findLatestByAgents' });
    const placeholders = agentHashes.map(() => '?').join(',');
    try {
      const rows = this.db.prepare(`
        SELECT s.* FROM score_snapshots s
        INNER JOIN (
          SELECT agent_hash, MAX(computed_at) as max_at
          FROM score_snapshots
          WHERE agent_hash IN (${placeholders}) AND p_success IS NOT NULL
          GROUP BY agent_hash
        ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      `).all(...agentHashes) as ScoreSnapshot[];
      const map = new Map<string, ScoreSnapshot>();
      for (const row of rows) map.set(row.agent_hash, row);
      return map;
    } finally {
      endTimer();
    }
  }

  findHistoryByAgent(agentHash: string, limit: number, offset: number): ScoreSnapshot[] {
    return this.db.prepare(
      'SELECT * FROM score_snapshots WHERE agent_hash = ? AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT ? OFFSET ?'
    ).all(agentHash, limit, offset) as ScoreSnapshot[];
  }

  insert(snapshot: ScoreSnapshot): void {
    this.db.prepare(`
      INSERT INTO score_snapshots (
        snapshot_id, agent_hash,
        p_success, ci95_low, ci95_high, n_obs,
        posterior_alpha, posterior_beta, window,
        computed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.snapshot_id, snapshot.agent_hash,
      snapshot.p_success, snapshot.ci95_low, snapshot.ci95_high, snapshot.n_obs,
      snapshot.posterior_alpha, snapshot.posterior_beta, snapshot.window,
      snapshot.computed_at, snapshot.updated_at,
    );
  }

  /** Find the most recent snapshot per agent where p_success differs from the
   *  previous snapshot, filtered to snapshots computed after `since`. Used by
   *  GET /api/watchlist — surfaces only agents whose posterior has moved. */
  findChangedSince(agentHashes: string[], since: number): Array<{
    agent_hash: string;
    p_success: number;
    previous_p_success: number | null;
    n_obs: number;
    computed_at: number;
  }> {
    if (agentHashes.length === 0) return [];
    const placeholders = agentHashes.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT cur.agent_hash, cur.p_success, prev.p_success AS previous_p_success, cur.n_obs, cur.computed_at
      FROM (
        SELECT agent_hash, p_success, n_obs, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at > ? AND p_success IS NOT NULL
      ) cur
      LEFT JOIN (
        SELECT agent_hash, p_success, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ? AND p_success IS NOT NULL
      ) prev ON prev.agent_hash = cur.agent_hash AND prev.rn = 1
      WHERE cur.rn = 1 AND (prev.p_success IS NULL OR ABS(cur.p_success - prev.p_success) >= 0.005)
    `).all(...agentHashes, since, ...agentHashes, since) as Array<{
      agent_hash: string;
      p_success: number;
      previous_p_success: number | null;
      n_obs: number;
      computed_at: number;
    }>;
  }

  countByAgent(agentHash: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM score_snapshots WHERE agent_hash = ? AND p_success IS NOT NULL'
    ).get(agentHash) as { count: number };
    return row.count;
  }

  /** Purge old snapshots: keep all < 7 days, keep 1/day between 7-30 days, delete all > 30 days.
   *
   *  Chunked implementation: the prior single-transaction `DELETE ... WHERE rowid IN (window fn)`
   *  could hold the SQLite write lock for 10-30s on a 10M-row table — exceeding the
   *  15s busy_timeout and causing concurrent writers (scoring, probe inserts) to fail
   *  with "database is locked". We now:
   *    1. Select victim rowids into a TEMP TABLE (read-only on main DB — no write lock).
   *    2. Delete in CHUNK-sized batches with a yield between each batch to cap the
   *       write lock to ~100ms per chunk and let other writers in.
   */
  async purgeOldSnapshots(): Promise<number> {
    const CHUNK = 1000;
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;
    const thirtyDaysAgo = now - 30 * 86400;

    // Phase 1 — everything older than 30 days.
    this.db.prepare('DROP TABLE IF EXISTS _purge_rowids_30').run();
    this.db.prepare(`
      CREATE TEMP TABLE _purge_rowids_30 AS
      SELECT rowid FROM score_snapshots WHERE computed_at < ?
    `).run(thirtyDaysAgo);
    const deleted30 = await this.deleteInChunks('_purge_rowids_30', CHUNK);
    this.db.prepare('DROP TABLE IF EXISTS _purge_rowids_30').run();

    // Phase 2 — keep only the latest snapshot per agent per day in the 7-30d window.
    this.db.prepare('DROP TABLE IF EXISTS _purge_rowids_daily').run();
    this.db.prepare(`
      CREATE TEMP TABLE _purge_rowids_daily AS
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (
          PARTITION BY agent_hash, CAST(computed_at / 86400 AS INTEGER)
          ORDER BY computed_at DESC
        ) AS rn
        FROM score_snapshots
        WHERE computed_at >= ? AND computed_at < ?
      ) WHERE rn > 1
    `).run(thirtyDaysAgo, sevenDaysAgo);
    const deletedDaily = await this.deleteInChunks('_purge_rowids_daily', CHUNK);
    this.db.prepare('DROP TABLE IF EXISTS _purge_rowids_daily').run();

    return deleted30 + deletedDaily;
  }

  /** Consume a TEMP TABLE of rowids, deleting from score_snapshots in CHUNK-sized
   *  batches. Each chunk is its own transaction; setImmediate yields between
   *  chunks so other writers (busy_timeout=15s) can acquire the lock. */
  private async deleteInChunks(tempTable: string, chunkSize: number): Promise<number> {
    const popStmt = this.db.prepare(
      `DELETE FROM score_snapshots WHERE rowid IN (SELECT rowid FROM ${tempTable} LIMIT ?)`,
    );
    const trimStmt = this.db.prepare(`DELETE FROM ${tempTable} WHERE rowid IN (SELECT rowid FROM ${tempTable} LIMIT ?)`);
    const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM ${tempTable}`);

    let totalDeleted = 0;
    for (;;) {
      const remaining = (countStmt.get() as { c: number }).c;
      if (remaining === 0) break;
      const txn = this.db.transaction(() => {
        const r = popStmt.run(chunkSize);
        trimStmt.run(chunkSize);
        return r.changes ?? 0;
      });
      totalDeleted += txn();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  }

  /** Closest p_success snapshot to a target timestamp (looking backwards). */
  findPSuccessAt(agentHash: string, timestamp: number): number | null {
    const row = this.db.prepare(
      'SELECT p_success FROM score_snapshots WHERE agent_hash = ? AND computed_at <= ? AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1'
    ).get(agentHash, timestamp) as { p_success: number } | undefined;
    return row?.p_success ?? null;
  }

  /** Like findPSuccessAt, but returns the full snapshot point (p_success +
   *  n_obs + computed_at) so callers can surface diagnostics. */
  findSnapshotAt(agentHash: string, timestamp: number): SnapshotPoint | null {
    const row = this.db.prepare(
      'SELECT p_success, n_obs, computed_at FROM score_snapshots WHERE agent_hash = ? AND computed_at <= ? AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1'
    ).get(agentHash, timestamp) as SnapshotPoint | undefined;
    return row ?? null;
  }

  /** Batch: find p_success at a target timestamp for multiple agents. */
  findPSuccessAtForAgents(agentHashes: string[], timestamp: number): Map<string, number> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findPSuccessAtForAgents: array exceeds 500 elements');
    const placeholders = agentHashes.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT s.agent_hash, s.p_success FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ? AND p_success IS NOT NULL
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
    `).all(...agentHashes, timestamp) as { agent_hash: string; p_success: number }[];
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.agent_hash, row.p_success);
    return map;
  }

  /** Batch version of findSnapshotAt — p_success + n_obs + computed_at per agent. */
  findSnapshotsAtForAgents(agentHashes: string[], timestamp: number): Map<string, SnapshotPoint> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findSnapshotsAtForAgents: array exceeds 500 elements');
    const placeholders = agentHashes.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT s.agent_hash, s.p_success, s.n_obs, s.computed_at FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ? AND p_success IS NOT NULL
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
    `).all(...agentHashes, timestamp) as Array<{ agent_hash: string } & SnapshotPoint>;
    const map = new Map<string, SnapshotPoint>();
    for (const row of rows) {
      map.set(row.agent_hash, {
        p_success: row.p_success,
        n_obs: row.n_obs,
        computed_at: row.computed_at,
      });
    }
    return map;
  }

  /** Network-wide mean p_success at a given timestamp. Averages the latest
   *  p_success per agent (one row each). */
  findAvgPSuccessAt(timestamp: number): number | null {
    const row = this.db.prepare(`
      SELECT ROUND(AVG(sub.p_success), 4) as avg FROM (
        SELECT s.agent_hash, s.p_success FROM score_snapshots s
        INNER JOIN (
          SELECT agent_hash, MAX(computed_at) as max_at
          FROM score_snapshots
          WHERE computed_at <= ? AND p_success IS NOT NULL
          GROUP BY agent_hash
        ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      ) sub
    `).get(timestamp) as { avg: number | null } | undefined;
    return row?.avg ?? null;
  }

  getLastUpdateTime(): number {
    const row = this.db.prepare(
      'SELECT MAX(computed_at) as last FROM score_snapshots WHERE p_success IS NOT NULL'
    ).get() as { last: number | null };
    return row.last ?? 0;
  }
}

export type { BayesianWindow };
