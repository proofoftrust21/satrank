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
    if (hashes.length > 500) throw new Error('findByHashes: array exceeds 500 elements');
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

  /** Returns all agents that have scorable data (capacity, LN+ ratings, transactions, or attestations)
   *  but currently have avg_score = 0. Used for bulk scoring after crawls. */
  findUnscoredWithData(): Agent[] {
    return this.db.prepare(`
      SELECT * FROM agents
      WHERE avg_score = 0
        AND (capacity_sats > 0 OR lnplus_rank > 0 OR positive_ratings > 0
             OR total_transactions > 1 OR total_attestations_received > 0)
    `).all() as Agent[];
  }

  /** Returns all agents that have been scored (avg_score > 0) for periodic rescore. */
  findScoredAgents(): Agent[] {
    return this.db.prepare('SELECT * FROM agents WHERE avg_score > 0').all() as Agent[];
  }

  /** Count of agents with scorable data but avg_score = 0 */
  countUnscoredWithData(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM agents
      WHERE avg_score = 0
        AND (capacity_sats > 0 OR lnplus_rank > 0 OR positive_ratings > 0
             OR total_transactions > 1 OR total_attestations_received > 0)
    `).get() as { count: number };
    return row.count;
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
      INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score, capacity_sats, positive_ratings, negative_ratings, lnplus_rank, hubness_rank, betweenness_rank, hopness_rank, query_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.public_key_hash, agent.public_key, agent.alias, agent.first_seen, agent.last_seen, agent.source, agent.total_transactions, agent.total_attestations_received, agent.avg_score, agent.capacity_sats, agent.positive_ratings, agent.negative_ratings, agent.lnplus_rank, agent.hubness_rank, agent.betweenness_rank, agent.hopness_rank, agent.query_count);
  }

  maxChannels(): number {
    const row = this.db.prepare(
      "SELECT MAX(total_transactions) as max FROM agents WHERE source = 'lightning_graph'"
    ).get() as { max: number | null };
    return row.max ?? 0;
  }

  avgScore(): number {
    const row = this.db.prepare('SELECT ROUND(AVG(avg_score), 1) as avg FROM agents WHERE avg_score > 0').get() as { avg: number | null };
    return row.avg ?? 0;
  }

  /** Total channels across all lightning_graph agents */
  sumChannels(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(total_transactions), 0) as total FROM agents WHERE source = 'lightning_graph'"
    ).get() as { total: number };
    return row.total;
  }

  /** Count of agents with LN+ ratings (lnplus_rank > 0) */
  countWithRatings(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM agents WHERE lnplus_rank > 0'
    ).get() as { count: number };
    return row.count;
  }

  /** Total network capacity in BTC */
  networkCapacityBtc(): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(capacity_sats), 0) as total FROM agents WHERE capacity_sats > 0'
    ).get() as { total: number };
    return Math.round((row.total / 100_000_000) * 10) / 10;
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

  updateLightningStats(hash: string, channels: number, capacitySats: number, alias: string, lastSeen: number, uniquePeers?: number): void {
    if (uniquePeers !== undefined && uniquePeers > 0) {
      this.db.prepare(
        'UPDATE agents SET total_transactions = ?, capacity_sats = ?, alias = ?, last_seen = ?, unique_peers = ? WHERE public_key_hash = ?'
      ).run(channels, capacitySats, alias, lastSeen, uniquePeers, hash);
    } else {
      this.db.prepare(
        'UPDATE agents SET total_transactions = ?, capacity_sats = ?, alias = ?, last_seen = ? WHERE public_key_hash = ?'
      ).run(channels, capacitySats, alias, lastSeen, hash);
    }
  }

  updatePublicKey(hash: string, publicKey: string): void {
    this.db.prepare('UPDATE agents SET public_key = ? WHERE public_key_hash = ?').run(publicKey, hash);
  }

  updateLnplusRatings(hash: string, positiveRatings: number, negativeRatings: number, lnplusRank: number, hubnessRank: number, betweennessRank: number, hopnessRank: number): void {
    this.db.prepare(`
      UPDATE agents SET positive_ratings = ?, negative_ratings = ?, lnplus_rank = ?, hubness_rank = ?, betweenness_rank = ?, hopness_rank = ?
      WHERE public_key_hash = ?
    `).run(positiveRatings, negativeRatings, lnplusRank, hubnessRank, betweennessRank, hopnessRank, hash);
  }

  findLightningAgentsWithPubkey(): Agent[] {
    return this.db.prepare(
      "SELECT * FROM agents WHERE source = 'lightning_graph' AND public_key IS NOT NULL"
    ).all() as Agent[];
  }

  /** Returns LN+ crawl candidates: agents already with LN+ data OR top N by capacity.
   *  Avoids querying all 16k+ nodes — most small nodes don't have LN+ profiles. */
  findLnplusCandidates(topCapacityLimit: number): Agent[] {
    return this.db.prepare(`
      SELECT * FROM agents
      WHERE source = 'lightning_graph' AND public_key IS NOT NULL
        AND (
          lnplus_rank > 0
          OR positive_ratings > 0
          OR public_key_hash IN (
            SELECT public_key_hash FROM agents
            WHERE source = 'lightning_graph' AND capacity_sats > 0
            ORDER BY capacity_sats DESC
            LIMIT ?
          )
        )
    `).all(topCapacityLimit) as Agent[];
  }

  incrementQueryCount(hash: string): void {
    this.db.prepare('UPDATE agents SET query_count = query_count + 1 WHERE public_key_hash = ?').run(hash);
  }

  /** Atomic SQL increment — avoids read-modify-write race (C3) */
  incrementTotalTransactions(hash: string): void {
    this.db.prepare('UPDATE agents SET total_transactions = total_transactions + 1 WHERE public_key_hash = ?').run(hash);
  }

  /** H1: narrow update — only refreshes attestation count, leaves avg_score for periodic scoring */
  updateAttestationCount(hash: string, totalAttestations: number): void {
    this.db.prepare('UPDATE agents SET total_attestations_received = ? WHERE public_key_hash = ?').run(totalAttestations, hash);
  }

  /** Rank of an agent by avg_score (1-based, null if not found).
   *  C1: checks existence first to avoid returning rank 1 for nonexistent agents. */
  getRank(hash: string): number | null {
    const exists = this.db.prepare('SELECT 1 FROM agents WHERE public_key_hash = ?').get(hash);
    if (!exists) return null;
    const row = this.db.prepare(`
      SELECT COUNT(*) + 1 as rank FROM agents WHERE avg_score > (
        SELECT avg_score FROM agents WHERE public_key_hash = ?
      )
    `).get(hash) as { rank: number };
    return row.rank;
  }
}
