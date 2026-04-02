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

  findByExactAlias(alias: string): Agent | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE alias = ? LIMIT 1').get(alias) as Agent | undefined;
  }

  findTopByScore(limit: number, offset: number): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY avg_score DESC LIMIT ? OFFSET ?').all(limit, offset) as Agent[];
  }

  findTopByActivity(limit: number): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY total_transactions DESC LIMIT ?').all(limit) as Agent[];
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
      INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score, capacity_sats, positive_ratings, negative_ratings, lnplus_rank, query_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.public_key_hash, agent.public_key, agent.alias, agent.first_seen, agent.last_seen, agent.source, agent.total_transactions, agent.total_attestations_received, agent.avg_score, agent.capacity_sats, agent.positive_ratings, agent.negative_ratings, agent.lnplus_rank, agent.query_count);
  }

  maxChannels(): number {
    const row = this.db.prepare(
      "SELECT MAX(total_transactions) as max FROM agents WHERE source = 'lightning_graph'"
    ).get() as { max: number | null };
    return row.max ?? 0;
  }

  avgScore(): number {
    const row = this.db.prepare('SELECT ROUND(AVG(avg_score), 1) as avg FROM agents').get() as { avg: number | null };
    return row.avg ?? 0;
  }

  updateAlias(hash: string, alias: string): void {
    this.db.prepare('UPDATE agents SET alias = ? WHERE public_key_hash = ?').run(alias, hash);
  }

  updateStats(hash: string, totalTx: number, totalAttestations: number, avgScore: number, firstSeen: number, lastSeen: number): void {
    this.db.prepare(`
      UPDATE agents SET total_transactions = ?, total_attestations_received = ?, avg_score = ?, first_seen = ?, last_seen = ?
      WHERE public_key_hash = ?
    `).run(totalTx, totalAttestations, avgScore, firstSeen, lastSeen, hash);
  }

  updateCapacity(hash: string, capacitySats: number, lastSeen: number): void {
    this.db.prepare(`
      UPDATE agents SET capacity_sats = ?, last_seen = MAX(last_seen, ?)
      WHERE public_key_hash = ?
    `).run(capacitySats, lastSeen, hash);
  }

  updateLightningStats(hash: string, channels: number, capacitySats: number, alias: string, lastSeen: number): void {
    this.db.prepare(`
      UPDATE agents SET total_transactions = ?, capacity_sats = ?, alias = ?, last_seen = ?
      WHERE public_key_hash = ?
    `).run(channels, capacitySats, alias, lastSeen, hash);
  }

  updatePublicKey(hash: string, publicKey: string): void {
    this.db.prepare('UPDATE agents SET public_key = ? WHERE public_key_hash = ?').run(publicKey, hash);
  }

  updateLnplusRatings(hash: string, positiveRatings: number, negativeRatings: number, lnplusRank: number): void {
    this.db.prepare(`
      UPDATE agents SET positive_ratings = ?, negative_ratings = ?, lnplus_rank = ?
      WHERE public_key_hash = ?
    `).run(positiveRatings, negativeRatings, lnplusRank, hash);
  }

  findLightningAgentsWithPubkey(): Agent[] {
    return this.db.prepare(
      "SELECT * FROM agents WHERE source = 'lightning_graph' AND public_key IS NOT NULL"
    ).all() as Agent[];
  }

  incrementQueryCount(hash: string): void {
    this.db.prepare('UPDATE agents SET query_count = query_count + 1 WHERE public_key_hash = ?').run(hash);
  }
}
