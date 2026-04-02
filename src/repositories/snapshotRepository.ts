// Data access for the score_snapshots table
import type Database from 'better-sqlite3';
import type { ScoreSnapshot } from '../types';

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
    const placeholders = agentHashes.map(() => '?').join(',');
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

  countByAgent(agentHash: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM score_snapshots WHERE agent_hash = ?'
    ).get(agentHash) as { count: number };
    return row.count;
  }

  /** Purge old snapshots: keep all < 7 days, keep 1/day between 7-30 days, delete all > 30 days */
  purgeOldSnapshots(): number {
    return this.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      const sevenDaysAgo = now - 7 * 86400;
      const thirtyDaysAgo = now - 30 * 86400;

      // Delete everything older than 30 days
      const deleted30 = this.db.prepare(
        'DELETE FROM score_snapshots WHERE computed_at < ?'
      ).run(thirtyDaysAgo);

      // Between 7 and 30 days: keep only the latest snapshot per agent per day
      // Delete duplicates within the same (agent_hash, day) window, keeping the one with max computed_at
      const deleted7 = this.db.prepare(`
        DELETE FROM score_snapshots WHERE rowid IN (
          SELECT s.rowid FROM score_snapshots s
          WHERE s.computed_at >= ? AND s.computed_at < ?
          AND s.rowid NOT IN (
            SELECT rowid FROM (
              SELECT rowid, ROW_NUMBER() OVER (
                PARTITION BY agent_hash, CAST(computed_at / 86400 AS INTEGER)
                ORDER BY computed_at DESC
              ) AS rn
              FROM score_snapshots
              WHERE computed_at >= ? AND computed_at < ?
            ) WHERE rn = 1
          )
        )
      `).run(thirtyDaysAgo, sevenDaysAgo, thirtyDaysAgo, sevenDaysAgo);

      return (deleted30.changes ?? 0) + (deleted7.changes ?? 0);
    })();
  }

  getLastUpdateTime(): number {
    const row = this.db.prepare(
      'SELECT MAX(computed_at) as last FROM score_snapshots'
    ).get() as { last: number | null };
    return row.last ?? 0;
  }
}
