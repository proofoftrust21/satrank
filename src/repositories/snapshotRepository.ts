// Data access for the score_snapshots table — Phase 3 C8 bayesian-only shape.
// (pg async port, Phase 12B)
//
// After the v34 migration, score_snapshots holds only bayesian-posterior state
// (p_success, ci95_low/high, n_obs, posterior_alpha/beta, window). The legacy
// `score` + `components` columns were dropped; rows written before v34 still
// exist with all bayesian fields NULL — every query filters on
// `p_success IS NOT NULL` to skip them.
//
// Postgres note: `window` is a reserved word, so the column is double-quoted
// (`"window"`) everywhere it appears in SQL.
import type { Pool, PoolClient } from 'pg';
import type { ScoreSnapshot, BayesianWindow } from '../types';
import { dbQueryDuration } from '../middleware/metrics';

type Queryable = Pool | PoolClient;

/** Narrow block shape used by TrendService / batch delta queries. Subset of
 *  ScoreSnapshot — avoids forcing callers to care about posterior_alpha/beta. */
export interface SnapshotPoint {
  p_success: number;
  n_obs: number;
  computed_at: number;
}

export class SnapshotRepository {
  constructor(private db: Queryable) {}

  async findLatestByAgent(agentHash: string): Promise<ScoreSnapshot | undefined> {
    const { rows } = await this.db.query<ScoreSnapshot>(
      'SELECT * FROM score_snapshots WHERE agent_hash = $1 AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1',
      [agentHash],
    );
    return rows[0];
  }

  async findLatestByAgents(agentHashes: string[]): Promise<Map<string, ScoreSnapshot>> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findLatestByAgents: array exceeds 500 elements');
    const endTimer = dbQueryDuration.startTimer({ repo: 'snapshot', method: 'findLatestByAgents' });
    try {
      const { rows } = await this.db.query<ScoreSnapshot>(
        `
        SELECT s.* FROM score_snapshots s
        INNER JOIN (
          SELECT agent_hash, MAX(computed_at) as max_at
          FROM score_snapshots
          WHERE agent_hash = ANY($1::text[]) AND p_success IS NOT NULL
          GROUP BY agent_hash
        ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
        `,
        [agentHashes],
      );
      const map = new Map<string, ScoreSnapshot>();
      for (const row of rows) map.set(row.agent_hash, row);
      return map;
    } finally {
      endTimer();
    }
  }

  async findHistoryByAgent(agentHash: string, limit: number, offset: number): Promise<ScoreSnapshot[]> {
    const { rows } = await this.db.query<ScoreSnapshot>(
      'SELECT * FROM score_snapshots WHERE agent_hash = $1 AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT $2 OFFSET $3',
      [agentHash, limit, offset],
    );
    return rows;
  }

  async insert(snapshot: ScoreSnapshot): Promise<void> {
    await this.db.query(
      `
      INSERT INTO score_snapshots (
        snapshot_id, agent_hash,
        p_success, ci95_low, ci95_high, n_obs,
        posterior_alpha, posterior_beta, "window",
        computed_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        snapshot.snapshot_id, snapshot.agent_hash,
        snapshot.p_success, snapshot.ci95_low, snapshot.ci95_high, snapshot.n_obs,
        snapshot.posterior_alpha, snapshot.posterior_beta, snapshot.window,
        snapshot.computed_at, snapshot.updated_at,
      ],
    );
  }

  /** Find the most recent snapshot per agent where p_success differs from the
   *  previous snapshot, filtered to snapshots computed after `since`. Used by
   *  GET /api/watchlist — surfaces only agents whose posterior has moved. */
  async findChangedSince(agentHashes: string[], since: number): Promise<Array<{
    agent_hash: string;
    p_success: number;
    previous_p_success: number | null;
    n_obs: number;
    computed_at: number;
  }>> {
    if (agentHashes.length === 0) return [];
    const { rows } = await this.db.query<{
      agent_hash: string;
      p_success: number;
      previous_p_success: number | null;
      n_obs: number;
      computed_at: number;
    }>(
      `
      SELECT cur.agent_hash, cur.p_success, prev.p_success AS previous_p_success, cur.n_obs, cur.computed_at
      FROM (
        SELECT agent_hash, p_success, n_obs, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash = ANY($1::text[]) AND computed_at > $2 AND p_success IS NOT NULL
      ) cur
      LEFT JOIN (
        SELECT agent_hash, p_success, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash = ANY($3::text[]) AND computed_at <= $4 AND p_success IS NOT NULL
      ) prev ON prev.agent_hash = cur.agent_hash AND prev.rn = 1
      WHERE cur.rn = 1 AND (prev.p_success IS NULL OR ABS(cur.p_success - prev.p_success) >= 0.005)
      `,
      [agentHashes, since, agentHashes, since],
    );
    return rows;
  }

  async countByAgent(agentHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM score_snapshots WHERE agent_hash = $1 AND p_success IS NOT NULL',
      [agentHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Purge old snapshots: keep all < 7 days, keep 1/day between 7-30 days, delete all > 30 days.
   *
   *  Chunked implementation: the prior single-transaction DELETE with window function
   *  could hold the write lock too long on a 10M-row table. We now:
   *    1. Select victim PKs into a TEMP TABLE (read-only on main table — no write lock).
   *    2. Delete in CHUNK-sized batches with a yield between each batch so other
   *       writers (scoring, probe inserts) can interleave.
   *
   *  score_snapshots uses `snapshot_id TEXT PRIMARY KEY`, so the TEMP TABLE holds
   *  snapshot_ids (no rowid in Postgres).
   */
  async purgeOldSnapshots(): Promise<number> {
    const CHUNK = 1000;
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;
    const thirtyDaysAgo = now - 30 * 86400;

    // Phase 1 — everything older than 30 days.
    await this.db.query('DROP TABLE IF EXISTS _purge_ids_30');
    await this.db.query(
      `
      CREATE TEMP TABLE _purge_ids_30 AS
      SELECT snapshot_id FROM score_snapshots WHERE computed_at < $1
      `,
      [thirtyDaysAgo],
    );
    const deleted30 = await this.deleteInChunks('_purge_ids_30', CHUNK);
    await this.db.query('DROP TABLE IF EXISTS _purge_ids_30');

    // Phase 2 — keep only the latest snapshot per agent per day in the 7-30d window.
    await this.db.query('DROP TABLE IF EXISTS _purge_ids_daily');
    await this.db.query(
      `
      CREATE TEMP TABLE _purge_ids_daily AS
      SELECT snapshot_id FROM (
        SELECT snapshot_id, ROW_NUMBER() OVER (
          PARTITION BY agent_hash, (computed_at / 86400)::bigint
          ORDER BY computed_at DESC
        ) AS rn
        FROM score_snapshots
        WHERE computed_at >= $1 AND computed_at < $2
      ) sub WHERE rn > 1
      `,
      [thirtyDaysAgo, sevenDaysAgo],
    );
    const deletedDaily = await this.deleteInChunks('_purge_ids_daily', CHUNK);
    await this.db.query('DROP TABLE IF EXISTS _purge_ids_daily');

    return deleted30 + deletedDaily;
  }

  /** Consume a TEMP TABLE of snapshot_ids, deleting from score_snapshots in CHUNK-sized
   *  batches. setImmediate yields between chunks so other writers can acquire locks. */
  private async deleteInChunks(tempTable: string, chunkSize: number): Promise<number> {
    let totalDeleted = 0;
    for (;;) {
      const { rows: countRows } = await this.db.query<{ c: string }>(
        `SELECT COUNT(*)::text as c FROM ${tempTable}`,
      );
      const remaining = Number(countRows[0]?.c ?? 0);
      if (remaining === 0) break;

      const result = await this.db.query(
        `
        WITH victims AS (
          DELETE FROM ${tempTable}
          WHERE snapshot_id IN (SELECT snapshot_id FROM ${tempTable} LIMIT $1)
          RETURNING snapshot_id
        )
        DELETE FROM score_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM victims)
        `,
        [chunkSize],
      );
      totalDeleted += result.rowCount ?? 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  }

  /** Closest p_success snapshot to a target timestamp (looking backwards). */
  async findPSuccessAt(agentHash: string, timestamp: number): Promise<number | null> {
    const { rows } = await this.db.query<{ p_success: number }>(
      'SELECT p_success FROM score_snapshots WHERE agent_hash = $1 AND computed_at <= $2 AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1',
      [agentHash, timestamp],
    );
    return rows[0]?.p_success ?? null;
  }

  /** Like findPSuccessAt, but returns the full snapshot point (p_success +
   *  n_obs + computed_at) so callers can surface diagnostics. */
  async findSnapshotAt(agentHash: string, timestamp: number): Promise<SnapshotPoint | null> {
    const { rows } = await this.db.query<SnapshotPoint>(
      'SELECT p_success, n_obs, computed_at FROM score_snapshots WHERE agent_hash = $1 AND computed_at <= $2 AND p_success IS NOT NULL ORDER BY computed_at DESC LIMIT 1',
      [agentHash, timestamp],
    );
    return rows[0] ?? null;
  }

  /** Batch: find p_success at a target timestamp for multiple agents. */
  async findPSuccessAtForAgents(agentHashes: string[], timestamp: number): Promise<Map<string, number>> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findPSuccessAtForAgents: array exceeds 500 elements');
    const { rows } = await this.db.query<{ agent_hash: string; p_success: number }>(
      `
      SELECT s.agent_hash, s.p_success FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash = ANY($1::text[]) AND computed_at <= $2 AND p_success IS NOT NULL
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      `,
      [agentHashes, timestamp],
    );
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.agent_hash, row.p_success);
    return map;
  }

  /** Batch version of findSnapshotAt — p_success + n_obs + computed_at per agent. */
  async findSnapshotsAtForAgents(agentHashes: string[], timestamp: number): Promise<Map<string, SnapshotPoint>> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findSnapshotsAtForAgents: array exceeds 500 elements');
    const { rows } = await this.db.query<{ agent_hash: string } & SnapshotPoint>(
      `
      SELECT s.agent_hash, s.p_success, s.n_obs, s.computed_at FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash = ANY($1::text[]) AND computed_at <= $2 AND p_success IS NOT NULL
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      `,
      [agentHashes, timestamp],
    );
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
  async findAvgPSuccessAt(timestamp: number): Promise<number | null> {
    const { rows } = await this.db.query<{ avg: number | null }>(
      `
      SELECT ROUND(AVG(sub.p_success)::numeric, 4)::float8 as avg FROM (
        SELECT s.agent_hash, s.p_success FROM score_snapshots s
        INNER JOIN (
          SELECT agent_hash, MAX(computed_at) as max_at
          FROM score_snapshots
          WHERE computed_at <= $1 AND p_success IS NOT NULL
          GROUP BY agent_hash
        ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      ) sub
      `,
      [timestamp],
    );
    return rows[0]?.avg ?? null;
  }

  async getLastUpdateTime(): Promise<number> {
    const { rows } = await this.db.query<{ last: number | null }>(
      'SELECT MAX(computed_at) as last FROM score_snapshots WHERE p_success IS NOT NULL',
    );
    return rows[0]?.last ?? 0;
  }
}

export type { BayesianWindow };
