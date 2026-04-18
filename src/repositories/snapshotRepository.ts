// Data access for the score_snapshots table
import type Database from 'better-sqlite3';
import type { ScoreSnapshot } from '../types';
import { dbQueryDuration } from '../middleware/metrics';

export class SnapshotRepository {
  constructor(private db: Database.Database) {}

  findLatestByAgent(agentHash: string): ScoreSnapshot | undefined {
    return this.db.prepare(
      'SELECT * FROM score_snapshots WHERE agent_hash = ? ORDER BY computed_at DESC LIMIT 1'
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
          WHERE agent_hash IN (${placeholders})
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
      'SELECT * FROM score_snapshots WHERE agent_hash = ? ORDER BY computed_at DESC LIMIT ? OFFSET ?'
    ).all(agentHash, limit, offset) as ScoreSnapshot[];
  }

  insert(snapshot: ScoreSnapshot): void {
    this.db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.snapshot_id, snapshot.agent_hash, snapshot.score, snapshot.components, snapshot.computed_at);
  }

  /** Find the most recent snapshot per agent where the score differs from the previous snapshot,
   *  filtered to snapshots computed after `since`. Used by GET /api/watchlist. */
  findChangedSince(agentHashes: string[], since: number): Array<{ agent_hash: string; score: number; previous_score: number | null; components: string; computed_at: number }> {
    if (agentHashes.length === 0) return [];
    const placeholders = agentHashes.map(() => '?').join(',');
    // For each target, get the latest snapshot after `since` and compare to the one before it
    return this.db.prepare(`
      SELECT cur.agent_hash, cur.score, prev.score AS previous_score, cur.components, cur.computed_at
      FROM (
        SELECT agent_hash, score, components, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at > ?
      ) cur
      LEFT JOIN (
        SELECT agent_hash, score, computed_at,
          ROW_NUMBER() OVER (PARTITION BY agent_hash ORDER BY computed_at DESC) AS rn
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ?
      ) prev ON prev.agent_hash = cur.agent_hash AND prev.rn = 1
      WHERE cur.rn = 1 AND (prev.score IS NULL OR cur.score != prev.score)
    `).all(...agentHashes, since, ...agentHashes, since) as Array<{ agent_hash: string; score: number; previous_score: number | null; components: string; computed_at: number }>;
  }

  countByAgent(agentHash: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM score_snapshots WHERE agent_hash = ?'
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
      // Yield the event loop so concurrent writers (bulk scoring, probe inserts,
      // transaction inserts) can grab the write lock between chunks.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  }

  /** Find the closest snapshot to a target timestamp for an agent (looking backwards) */
  findScoreAt(agentHash: string, timestamp: number): number | null {
    const row = this.db.prepare(
      'SELECT score FROM score_snapshots WHERE agent_hash = ? AND computed_at <= ? ORDER BY computed_at DESC LIMIT 1'
    ).get(agentHash, timestamp) as { score: number } | undefined;
    return row?.score ?? null;
  }

  /** Like findScoreAt, but also returns the snapshot's computed_at so callers can
   *  decide whether the comparator predates a methodology cutoff. */
  findSnapshotAt(agentHash: string, timestamp: number): { score: number; computed_at: number } | null {
    const row = this.db.prepare(
      'SELECT score, computed_at FROM score_snapshots WHERE agent_hash = ? AND computed_at <= ? ORDER BY computed_at DESC LIMIT 1'
    ).get(agentHash, timestamp) as { score: number; computed_at: number } | undefined;
    return row ?? null;
  }

  /** Batch: find scores at a target timestamp for multiple agents */
  findScoresAtForAgents(agentHashes: string[], timestamp: number): Map<string, number> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findScoresAtForAgents: array exceeds 500 elements');
    const placeholders = agentHashes.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT s.agent_hash, s.score FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ?
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
    `).all(...agentHashes, timestamp) as { agent_hash: string; score: number }[];
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.agent_hash, row.score);
    return map;
  }

  /** Batch version of findSnapshotAt — returns score + computed_at per agent. */
  findSnapshotsAtForAgents(agentHashes: string[], timestamp: number): Map<string, { score: number; computed_at: number }> {
    if (agentHashes.length === 0) return new Map();
    if (agentHashes.length > 500) throw new Error('findSnapshotsAtForAgents: array exceeds 500 elements');
    const placeholders = agentHashes.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT s.agent_hash, s.score, s.computed_at FROM score_snapshots s
      INNER JOIN (
        SELECT agent_hash, MAX(computed_at) as max_at
        FROM score_snapshots
        WHERE agent_hash IN (${placeholders}) AND computed_at <= ?
        GROUP BY agent_hash
      ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
    `).all(...agentHashes, timestamp) as { agent_hash: string; score: number; computed_at: number }[];
    const map = new Map<string, { score: number; computed_at: number }>();
    for (const row of rows) map.set(row.agent_hash, { score: row.score, computed_at: row.computed_at });
    return map;
  }

  /** Network average score at a given timestamp */
  findAvgScoreAt(timestamp: number): number | null {
    const row = this.db.prepare(`
      SELECT ROUND(AVG(sub.score), 1) as avg FROM (
        SELECT s.agent_hash, s.score FROM score_snapshots s
        INNER JOIN (
          SELECT agent_hash, MAX(computed_at) as max_at
          FROM score_snapshots
          WHERE computed_at <= ?
          GROUP BY agent_hash
        ) latest ON s.agent_hash = latest.agent_hash AND s.computed_at = latest.max_at
      ) sub
    `).get(timestamp) as { avg: number | null } | undefined;
    return row?.avg ?? null;
  }

  getLastUpdateTime(): number {
    const row = this.db.prepare(
      'SELECT MAX(computed_at) as last FROM score_snapshots'
    ).get() as { last: number | null };
    return row.last ?? 0;
  }
}
