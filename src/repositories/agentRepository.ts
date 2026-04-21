// Data access for the agents table (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import type { Agent } from '../types';
import { dbQueryDuration } from '../middleware/metrics';

/** Either a Pool (autocommit) or a PoolClient (inside withTransaction).
 *  pg exposes `.query()` on both with the same signature, so we accept either. */
type Queryable = Pool | PoolClient;

/** Time a DB call against the `satrank_db_query_duration_seconds` histogram. */
async function timed<T>(repo: string, method: string, fn: () => Promise<T>): Promise<T> {
  const endTimer = dbQueryDuration.startTimer({ repo, method });
  try {
    return await fn();
  } finally {
    endTimer();
  }
}

export class AgentRepository {
  constructor(private db: Queryable) {}

  async findByHash(hash: string): Promise<Agent | undefined> {
    const { rows } = await this.db.query<Agent>('SELECT * FROM agents WHERE public_key_hash = $1', [hash]);
    return rows[0];
  }

  async findByPubkey(pubkey: string): Promise<Agent | undefined> {
    const { rows } = await this.db.query<Agent>('SELECT * FROM agents WHERE public_key = $1', [pubkey]);
    return rows[0];
  }

  async findAll(limit: number, offset: number): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(
      'SELECT * FROM agents WHERE stale = 0 ORDER BY avg_score DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return rows;
  }

  async findByHashes(hashes: string[]): Promise<Agent[]> {
    if (hashes.length === 0) return [];
    if (hashes.length > 500) throw new Error('findByHashes: array exceeds 500 elements');
    const { rows } = await this.db.query<Agent>(
      'SELECT * FROM agents WHERE public_key_hash = ANY($1::text[])',
      [hashes],
    );
    return rows;
  }

  async findByExactAlias(alias: string): Promise<Agent | undefined> {
    const { rows } = await this.db.query<Agent>('SELECT * FROM agents WHERE alias = $1 LIMIT 1', [alias]);
    return rows[0];
  }

  async findTopByScore(limit: number, offset: number): Promise<Agent[]> {
    return timed('agent', 'findTopByScore', async () => {
      const { rows } = await this.db.query<Agent>(
        'SELECT * FROM agents WHERE stale = 0 ORDER BY avg_score DESC LIMIT $1 OFFSET $2',
        [limit, offset],
      );
      return rows;
    });
  }

  async findTopByActivity(limit: number): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(
      'SELECT * FROM agents WHERE stale = 0 ORDER BY total_transactions DESC LIMIT $1',
      [limit],
    );
    return rows;
  }

  /** Returns all agents that have scorable data (capacity, LN+ ratings, transactions, or attestations)
   *  but currently have avg_score = 0. Used for bulk scoring after crawls. */
  async findUnscoredWithData(): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(`
      SELECT * FROM agents
      WHERE stale = 0
        AND avg_score = 0
        AND (capacity_sats > 0 OR lnplus_rank > 0 OR positive_ratings > 0
             OR total_transactions > 1 OR total_attestations_received > 0)
    `);
    return rows;
  }

  async findScoredAbove(minScore: number): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(
      'SELECT * FROM agents WHERE stale = 0 AND avg_score >= $1 ORDER BY avg_score DESC',
      [minScore],
    );
    return rows;
  }

  /** Returns all agents that have been scored (avg_score > 0) for periodic rescore. */
  async findScoredAgents(): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>('SELECT * FROM agents WHERE stale = 0 AND avg_score > 0');
    return rows;
  }

  async countUnscoredWithData(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM agents
      WHERE stale = 0
        AND avg_score = 0
        AND (capacity_sats > 0 OR lnplus_rank > 0 OR positive_ratings > 0
             OR total_transactions > 1 OR total_attestations_received > 0)
    `);
    return Number(rows[0]?.count ?? 0);
  }

  async searchByAlias(alias: string, limit: number, offset: number): Promise<Agent[]> {
    const escaped = alias.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { rows } = await this.db.query<Agent>(
      "SELECT * FROM agents WHERE stale = 0 AND alias LIKE $1 ESCAPE '\\' ORDER BY avg_score DESC LIMIT $2 OFFSET $3",
      [`%${escaped}%`, limit, offset],
    );
    return rows;
  }

  async countBySource(source: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agents WHERE stale = 0 AND source = $1',
      [source],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countByAlias(alias: string): Promise<number> {
    const escaped = alias.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { rows } = await this.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE stale = 0 AND alias LIKE $1 ESCAPE '\\'",
      [`%${escaped}%`],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Count of active (non-stale) agents. Fossils are excluded. */
  async count(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agents WHERE stale = 0',
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countIncludingStale(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agents',
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countStale(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agents WHERE stale = 1',
    );
    return Number(rows[0]?.count ?? 0);
  }

  async insert(agent: Agent): Promise<void> {
    // unique_peers is nullable; coerce undefined → null so pg stores a clean NULL.
    // Use ON CONFLICT DO NOTHING to make the insert idempotent under concurrent crawler
    // workers (see docs/phase-12b/CRAWLER-RACE-CHECK.md — H1/H2/H3 TOCTOU fix).
    await this.db.query(
      `
      INSERT INTO agents (
        public_key_hash, public_key, alias, first_seen, last_seen, source,
        total_transactions, total_attestations_received, avg_score, capacity_sats,
        positive_ratings, negative_ratings, lnplus_rank, hubness_rank,
        betweenness_rank, hopness_rank, query_count, unique_peers
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (public_key_hash) DO NOTHING
      `,
      [
        agent.public_key_hash, agent.public_key, agent.alias, agent.first_seen, agent.last_seen, agent.source,
        agent.total_transactions, agent.total_attestations_received, agent.avg_score, agent.capacity_sats,
        agent.positive_ratings, agent.negative_ratings, agent.lnplus_rank, agent.hubness_rank,
        agent.betweenness_rank, agent.hopness_rank, agent.query_count,
        agent.unique_peers ?? null,
      ],
    );
  }

  async maxChannels(): Promise<number> {
    const { rows } = await this.db.query<{ max: number | null }>(
      "SELECT MAX(total_transactions) AS max FROM agents WHERE stale = 0 AND source = 'lightning_graph'",
    );
    return rows[0]?.max ?? 0;
  }

  async avgScore(): Promise<number> {
    const { rows } = await this.db.query<{ avg: string | null }>(
      'SELECT ROUND(AVG(avg_score)::numeric, 1)::text AS avg FROM agents WHERE stale = 0 AND avg_score > 0',
    );
    return Number(rows[0]?.avg ?? 0);
  }

  async sumChannels(): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      "SELECT COALESCE(SUM(total_transactions), 0)::text AS total FROM agents WHERE stale = 0 AND source = 'lightning_graph'",
    );
    return Number(rows[0]?.total ?? 0);
  }

  async countWithRatings(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agents WHERE stale = 0 AND lnplus_rank > 0',
    );
    return Number(rows[0]?.count ?? 0);
  }

  async networkCapacityBtc(): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      'SELECT COALESCE(SUM(capacity_sats), 0)::text AS total FROM agents WHERE stale = 0 AND capacity_sats > 0',
    );
    const total = Number(rows[0]?.total ?? 0);
    return Math.round((total / 100_000_000) * 10) / 10;
  }

  async markStaleByAge(maxAgeSec: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const result = await this.db.query(
      `
      UPDATE agents
      SET stale = CASE WHEN last_seen < $1 THEN 1 ELSE 0 END
      WHERE stale != CASE WHEN last_seen < $2 THEN 1 ELSE 0 END
      `,
      [cutoff, cutoff],
    );
    return result.rowCount ?? 0;
  }

  async updateAlias(hash: string, alias: string): Promise<void> {
    await this.db.query('UPDATE agents SET alias = $1 WHERE public_key_hash = $2', [alias, hash]);
  }

  private staleCutoff(): number {
    return Math.floor(Date.now() / 1000) - 90 * 86400;
  }

  async updateStats(
    hash: string, totalTx: number, totalAttestations: number, avgScore: number, firstSeen: number, lastSeen: number,
  ): Promise<void> {
    const cutoff = this.staleCutoff();
    await this.db.query(
      `
      UPDATE agents
      SET total_transactions = $1, total_attestations_received = $2, avg_score = $3,
          first_seen = $4, last_seen = $5,
          stale = CASE WHEN $6 >= $7 THEN 0 ELSE 1 END
      WHERE public_key_hash = $8
      `,
      [totalTx, totalAttestations, avgScore, firstSeen, lastSeen, lastSeen, cutoff, hash],
    );
  }

  async updateCapacity(hash: string, capacitySats: number, lastSeen: number): Promise<void> {
    const cutoff = this.staleCutoff();
    await this.db.query(
      `
      UPDATE agents
      SET capacity_sats = $1,
          last_seen = GREATEST(last_seen, $2),
          stale = CASE WHEN GREATEST(last_seen, $3) >= $4 THEN 0 ELSE 1 END
      WHERE public_key_hash = $5
      `,
      [capacitySats, lastSeen, lastSeen, cutoff, hash],
    );
  }

  async updateLightningStats(
    hash: string, channels: number, capacitySats: number, alias: string, lastSeen: number,
    uniquePeers?: number, disabledChannels?: number,
  ): Promise<void> {
    const cutoff = this.staleCutoff();
    if (uniquePeers !== undefined && uniquePeers > 0) {
      await this.db.query(
        `
        UPDATE agents
        SET total_transactions = $1, capacity_sats = $2, alias = $3, last_seen = $4,
            unique_peers = $5, disabled_channels = $6,
            stale = CASE WHEN $7 >= $8 THEN 0 ELSE 1 END
        WHERE public_key_hash = $9
        `,
        [channels, capacitySats, alias, lastSeen, uniquePeers, disabledChannels ?? 0, lastSeen, cutoff, hash],
      );
      return;
    }
    await this.db.query(
      `
      UPDATE agents
      SET total_transactions = $1, capacity_sats = $2, alias = $3, last_seen = $4,
          stale = CASE WHEN $5 >= $6 THEN 0 ELSE 1 END
      WHERE public_key_hash = $7
      `,
      [channels, capacitySats, alias, lastSeen, lastSeen, cutoff, hash],
    );
  }

  async updatePublicKey(hash: string, publicKey: string): Promise<void> {
    await this.db.query('UPDATE agents SET public_key = $1 WHERE public_key_hash = $2', [publicKey, hash]);
  }

  /** Caller is responsible for wrapping in withTransaction if atomicity is needed.
   *  We loop inside a single query-per-pair; the UPDATE row lock is sufficient. */
  async updatePageRankBatch(scores: Map<string, number>): Promise<void> {
    for (const [pubkey, score] of scores) {
      await this.db.query('UPDATE agents SET pagerank_score = $1 WHERE public_key = $2', [score, pubkey]);
    }
  }

  async updateLnplusRatings(
    hash: string, positiveRatings: number, negativeRatings: number,
    lnplusRank: number, hubnessRank: number, betweennessRank: number, hopnessRank: number,
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE agents
      SET positive_ratings = $1, negative_ratings = $2, lnplus_rank = $3,
          hubness_rank = $4, betweenness_rank = $5, hopness_rank = $6
      WHERE public_key_hash = $7
      `,
      [positiveRatings, negativeRatings, lnplusRank, hubnessRank, betweennessRank, hopnessRank, hash],
    );
  }

  async findLightningAgentsWithPubkey(): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(
      "SELECT * FROM agents WHERE stale = 0 AND source = 'lightning_graph' AND public_key IS NOT NULL",
    );
    return rows;
  }

  async findLnplusCandidates(topCapacityLimit: number): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(
      `
      SELECT * FROM agents
      WHERE stale = 0 AND source = 'lightning_graph' AND public_key IS NOT NULL
        AND (
          lnplus_rank > 0
          OR positive_ratings > 0
          OR public_key_hash IN (
            SELECT public_key_hash FROM agents
            WHERE stale = 0 AND source = 'lightning_graph' AND capacity_sats > 0
            ORDER BY capacity_sats DESC
            LIMIT $1
          )
        )
      `,
      [topCapacityLimit],
    );
    return rows;
  }

  async incrementQueryCount(hash: string): Promise<void> {
    await this.db.query(
      'UPDATE agents SET query_count = query_count + 1 WHERE public_key_hash = $1',
      [hash],
    );
  }

  async touchLastQueried(hash: string): Promise<void> {
    await this.db.query(
      'UPDATE agents SET last_queried_at = $1 WHERE public_key_hash = $2',
      [Math.floor(Date.now() / 1000), hash],
    );
  }

  async findHotNodes(withinSec: number): Promise<Agent[]> {
    const cutoff = Math.floor(Date.now() / 1000) - withinSec;
    const { rows } = await this.db.query<Agent>(
      "SELECT * FROM agents WHERE stale = 0 AND last_queried_at >= $1 AND public_key IS NOT NULL AND source = 'lightning_graph' ORDER BY last_queried_at DESC",
      [cutoff],
    );
    return rows;
  }

  /** Atomic SQL increment — avoids read-modify-write race. */
  async incrementTotalTransactions(hash: string): Promise<void> {
    await this.db.query(
      'UPDATE agents SET total_transactions = total_transactions + 1 WHERE public_key_hash = $1',
      [hash],
    );
  }

  async updateAttestationCount(hash: string, totalAttestations: number): Promise<void> {
    await this.db.query(
      'UPDATE agents SET total_attestations_received = $1 WHERE public_key_hash = $2',
      [totalAttestations, hash],
    );
  }

  async getRank(hash: string): Promise<number | null> {
    const { rows: existsRows } = await this.db.query<{ stale: number }>(
      'SELECT stale FROM agents WHERE public_key_hash = $1',
      [hash],
    );
    const exists = existsRows[0];
    if (!exists) return null;
    if (exists.stale === 1) return null;
    const { rows } = await this.db.query<{ rank: string }>(
      `
      SELECT (COUNT(*) + 1)::text AS rank FROM agents WHERE stale = 0 AND avg_score > (
        SELECT avg_score FROM agents WHERE public_key_hash = $1
      )
      `,
      [hash],
    );
    return Number(rows[0]?.rank ?? 1);
  }

  async getRanks(hashes: string[]): Promise<Map<string, number>> {
    if (hashes.length === 0) return new Map();
    if (hashes.length > 500) throw new Error('getRanks: array exceeds 500 elements');
    const { rows } = await this.db.query<{ public_key_hash: string; rank: string }>(
      `
      SELECT public_key_hash, (
        SELECT COUNT(*) + 1 FROM agents WHERE stale = 0 AND avg_score > a.avg_score
      )::text AS rank
      FROM agents a
      WHERE stale = 0 AND public_key_hash = ANY($1::text[])
      `,
      [hashes],
    );
    const result = new Map<string, number>();
    for (const row of rows) result.set(row.public_key_hash, Number(row.rank));
    return result;
  }
}
