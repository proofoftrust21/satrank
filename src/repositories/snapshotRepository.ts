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

  getLastUpdateTime(): number {
    const row = this.db.prepare(
      'SELECT MAX(computed_at) as last FROM score_snapshots'
    ).get() as { last: number | null };
    return row.last ?? 0;
  }
}
