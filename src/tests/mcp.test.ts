// MCP server tool response shape tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { StatsService } from '../services/statsService';
import { TrendService } from '../services/trendService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`mcp-${Math.random()}`),
    public_key: null,
    alias: 'mcp-test',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    query_count: 0,
    ...overrides,
  };
}

describe('MCP tool response shapes', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let agentService: AgentService;
  let statsService: StatsService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo);
    statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
  });

  afterEach(() => { db.close(); });

  it('get_agent_score returns evidence with all sections', () => {
    const pubkey = 'pk-mcp-test';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      alias: 'MCPNode',
      source: 'lightning_graph',
      total_transactions: 500,
      capacity_sats: 5_000_000_000,
      positive_ratings: 20,
      negative_ratings: 1,
      lnplus_rank: 7,
      hubness_rank: 15,
      betweenness_rank: 30,
      query_count: 42,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    // Score structure
    expect(result.score.total).toBeGreaterThan(0);
    expect(result.score.components).toHaveProperty('volume');
    expect(result.score.components).toHaveProperty('reputation');
    expect(result.score.confidence).toBeDefined();

    // Evidence structure
    expect(result.evidence).toBeDefined();
    expect(result.evidence.transactions.count).toBe(500);
    expect(result.evidence.lightningGraph).not.toBeNull();
    expect(result.evidence.lightningGraph!.publicKey).toBe(pubkey);
    expect(result.evidence.lightningGraph!.sourceUrl).toContain('mempool.space');
    expect(result.evidence.reputation).not.toBeNull();
    expect(result.evidence.reputation!.positiveRatings).toBe(20);
    expect(result.evidence.reputation!.lnplusRank).toBe(7);
    expect(result.evidence.reputation!.hubnessRank).toBe(15);
    expect(result.evidence.reputation!.betweennessRank).toBe(30);
    expect(result.evidence.reputation!.sourceUrl).toContain('lightningnetwork.plus');
    expect(result.evidence.popularity.queryCount).toBe(42);
    expect(result.evidence.popularity.bonusApplied).toBeGreaterThan(0);
  });

  it('get_top_agents returns agents with components', () => {
    const agent = makeAgent({
      public_key_hash: sha256('top-mcp'),
      alias: 'TopNode',
      avg_score: 80,
      positive_ratings: 10,
      negative_ratings: 1,
      lnplus_rank: 5,
      query_count: 100,
    });
    agentRepo.insert(agent);

    const agents = agentService.getTopAgents(10, 0);
    expect(agents.length).toBeGreaterThan(0);

    const a = agents[0];
    expect(a.publicKeyHash).toBe(sha256('top-mcp'));
    expect(a.score).toBe(80);
    expect(a.components).toBeDefined();
    expect(typeof a.components.volume).toBe('number');
    expect(typeof a.components.reputation).toBe('number');
  });

  it('search_agents returns agents with LN+ fields', () => {
    const agent = makeAgent({
      public_key_hash: sha256('search-mcp'),
      alias: 'SearchableNode',
      positive_ratings: 5,
      lnplus_rank: 3,
    });
    agentRepo.insert(agent);

    const agents = agentService.searchByAlias('Searchable', 10, 0);
    expect(agents.length).toBe(1);
    expect(agents[0].positive_ratings).toBe(5);
    expect(agents[0].lnplus_rank).toBe(3);
  });

  it('get_network_stats returns expected shape', () => {
    const stats = statsService.getNetworkStats();
    expect(stats).toHaveProperty('totalAgents');
    expect(stats).toHaveProperty('totalChannels');
    expect(stats).toHaveProperty('nodesWithRatings');
    expect(stats).toHaveProperty('networkCapacityBtc');
    expect(stats).toHaveProperty('avgScore');
    expect(stats).toHaveProperty('totalVolumeBuckets');
  });
});
