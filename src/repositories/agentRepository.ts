// Data access for the agents table
import type Database from 'better-sqlite3';
import type { Agent } from '../types';

export class AgentRepository {
  constructor(private db: Database.Database) {}

  findByHash(hash: string): Agent | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE public_key_hash = ?').get(hash) as Agent | undefined;
  }

  findAll(limit: number, offset: number): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY avg_score DESC LIMIT ? OFFSET ?').all(limit, offset) as Agent[];
  }

  findByHashes(hashes: string[]): Agent[] {
    if (hashes.length === 0) return [];
    const placeholders = hashes.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM agents WHERE public_key_hash IN (${placeholders})`).all(...hashes) as Agent[];
  }

  findTopByScore(limit: number, offset: number): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY avg_score DESC LIMIT ? OFFSET ?').all(limit, offset) as Agent[];
  }

  searchByAlias(alias: string, limit: number, offset: number): Agent[] {
    const escaped = alias.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return this.db.prepare(
      "SELECT * FROM agents WHERE alias LIKE ? ESCAPE '\\' ORDER BY avg_score DESC LIMIT ? OFFSET ?"
    ).all(`%${escaped}%`, limit, offset) as Agent[];
  }

  countByAlias(alias: string): number {
    const escaped = alias.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM agents WHERE alias LIKE ? ESCAPE '\\'"
    ).get(`%${escaped}%`) as { count: number };
    return row.count;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    return row.count;
  }

  insert(agent: Agent): void {
    this.db.prepare(`
      INSERT INTO agents (public_key_hash, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.public_key_hash, agent.alias, agent.first_seen, agent.last_seen, agent.source, agent.total_transactions, agent.total_attestations_received, agent.avg_score);
  }

  avgScore(): number {
    const row = this.db.prepare('SELECT ROUND(AVG(avg_score), 1) as avg FROM agents').get() as { avg: number | null };
    return row.avg ?? 0;
  }

  updateStats(hash: string, totalTx: number, totalAttestations: number, avgScore: number, lastSeen: number): void {
    this.db.prepare(`
      UPDATE agents SET total_transactions = ?, total_attestations_received = ?, avg_score = ?, last_seen = ?
      WHERE public_key_hash = ?
    `).run(totalTx, totalAttestations, avgScore, lastSeen, hash);
  }
}
