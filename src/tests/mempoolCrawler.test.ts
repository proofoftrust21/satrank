// mempool.space Lightning crawler tests with mocked client
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { MempoolCrawler } from '../crawler/mempoolCrawler';
import { sha256 } from '../utils/crypto';
import type { MempoolClient, MempoolNode } from '../crawler/mempoolClient';

function makeNode(overrides: Partial<MempoolNode> = {}): MempoolNode {
  return {
    publicKey: `pubkey-${Math.random().toString(36).slice(2, 14)}`,
    alias: 'ACINQ',
    channels: 2500,
    capacity: 5_000_000_000,
    firstSeen: 1600000000,
    updatedAt: 1700000000,
    country: { en: 'France' },
    iso_code: 'FR',
    ...overrides,
  };
}

class MockMempoolClient implements MempoolClient {
  nodes: MempoolNode[] = [];
  calls = 0;
  shouldFail = false;

  async fetchTopNodes(): Promise<MempoolNode[]> {
    this.calls++;
    if (this.shouldFail) throw new Error('Connection refused');
    return this.nodes;
  }
}

describe('MempoolCrawler', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let mockClient: MockMempoolClient;
  let crawler: MempoolCrawler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    mockClient = new MockMempoolClient();
    crawler = new MempoolCrawler(mockClient, agentRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes Lightning nodes as agents', async () => {
    const node = makeNode({
      publicKey: 'pk-acinq',
      alias: 'ACINQ',
      channels: 2500,
      capacity: 5_000_000_000,
      firstSeen: 1600000000,
      updatedAt: 1700000000,
    });
    mockClient.nodes = [node];

    const result = await crawler.run();

    expect(result.nodesFetched).toBe(1);
    expect(result.newAgents).toBe(1);
    expect(result.updatedAgents).toBe(0);

    const agent = agentRepo.findByHash(sha256('pk-acinq'));
    expect(agent).toBeDefined();
    expect(agent!.alias).toBe('ACINQ');
    expect(agent!.source).toBe('lightning_graph');
    expect(agent!.total_transactions).toBe(2500);
    expect(agent!.capacity_sats).toBe(5_000_000_000);
    expect(agent!.first_seen).toBe(1600000000);
    expect(agent!.last_seen).toBe(1700000000);
  });

  it('updates existing Lightning nodes', async () => {
    const node = makeNode({
      publicKey: 'pk-kraken',
      alias: 'Kraken',
      channels: 1000,
      capacity: 2_000_000_000,
      firstSeen: 1600000000,
      updatedAt: 1700000000,
    });
    mockClient.nodes = [node];

    // First crawl — creates the agent
    await crawler.run();

    // Second crawl — updated data
    mockClient.nodes = [makeNode({
      publicKey: 'pk-kraken',
      alias: 'Kraken v2',
      channels: 1200,
      capacity: 3_000_000_000,
      firstSeen: 1600000000,
      updatedAt: 1750000000,
    })];

    const result = await crawler.run();

    expect(result.newAgents).toBe(0);
    expect(result.updatedAgents).toBe(1);

    const agent = agentRepo.findByHash(sha256('pk-kraken'));
    expect(agent!.alias).toBe('Kraken v2');
    expect(agent!.total_transactions).toBe(1200);
    expect(agent!.capacity_sats).toBe(3_000_000_000);
    expect(agent!.last_seen).toBe(1750000000);
    // first_seen preserved from original insert
    expect(agent!.first_seen).toBe(1600000000);
  });

  it('continues gracefully when API fails', async () => {
    mockClient.shouldFail = true;

    const result = await crawler.run();

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Fetch failed');
    expect(result.nodesFetched).toBe(0);
    expect(result.newAgents).toBe(0);
  });

  it('indexes multiple nodes in one crawl', async () => {
    mockClient.nodes = [
      makeNode({ publicKey: 'pk-1', alias: 'Node A', channels: 100, capacity: 1_000_000_000 }),
      makeNode({ publicKey: 'pk-2', alias: 'Node B', channels: 200, capacity: 2_000_000_000 }),
      makeNode({ publicKey: 'pk-3', alias: 'Node C', channels: 300, capacity: 3_000_000_000 }),
    ];

    const result = await crawler.run();

    expect(result.nodesFetched).toBe(3);
    expect(result.newAgents).toBe(3);
    expect(agentRepo.count()).toBe(3);
  });

  it('skips nodes without publicKey or alias', async () => {
    mockClient.nodes = [
      makeNode({ publicKey: '', alias: 'Valid alias' }),
      makeNode({ publicKey: 'pk-valid', alias: '' }),
      makeNode({ publicKey: 'pk-ok', alias: 'OK Node', channels: 50 }),
    ];

    const result = await crawler.run();

    expect(result.newAgents).toBe(1);
    expect(result.errors.length).toBe(2);
  });

  it('hashes publicKey with SHA-256', async () => {
    const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
    mockClient.nodes = [makeNode({ publicKey: pubkey, alias: 'Test' })];

    await crawler.run();

    const expectedHash = sha256(pubkey);
    const agent = agentRepo.findByHash(expectedHash);
    expect(agent).toBeDefined();
    expect(agent!.alias).toBe('Test');
  });

  it('consolidates cross-source agents by alias match', async () => {
    // Pre-existing Observer Protocol agent — hash is sha256('ACINQ'), not sha256(pubkey)
    const observerHash = sha256('ACINQ');
    agentRepo.insert({
      public_key_hash: observerHash,
      public_key: null,
      alias: 'ACINQ',
      first_seen: 1500000000,
      last_seen: 1600000000,
      source: 'observer_protocol',
      total_transactions: 15,
      total_attestations_received: 3,
      avg_score: 60,
      capacity_sats: null,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      unique_peers: null,
      last_queried_at: null,
      query_count: 0,
    });

    // Lightning node with same alias but different pubkey hash
    mockClient.nodes = [makeNode({
      publicKey: 'pk-acinq-real',
      alias: 'ACINQ',
      channels: 2500,
      capacity: 5_000_000_000,
      updatedAt: 1700000000,
    })];

    const result = await crawler.run();

    // Should enrich the existing agent, not create a duplicate
    expect(result.newAgents).toBe(0);
    expect(result.updatedAgents).toBe(1);
    expect(agentRepo.count()).toBe(1);

    // Original agent enriched with capacity, but alias/source/tx preserved
    const agent = agentRepo.findByHash(observerHash);
    expect(agent).toBeDefined();
    expect(agent!.alias).toBe('ACINQ');
    expect(agent!.source).toBe('observer_protocol');
    expect(agent!.total_transactions).toBe(15);
    expect(agent!.capacity_sats).toBe(5_000_000_000);

    // No agent created under the Lightning pubkey hash
    const lightningAgent = agentRepo.findByHash(sha256('pk-acinq-real'));
    expect(lightningAgent).toBeUndefined();
  });

  it('creates new agent when no alias match exists', async () => {
    // Pre-existing agent with different alias
    agentRepo.insert({
      public_key_hash: sha256('other-agent'),
      public_key: null,
      alias: 'OtherNode',
      first_seen: 1500000000,
      last_seen: 1600000000,
      source: 'observer_protocol',
      total_transactions: 5,
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
      last_queried_at: null,
      query_count: 0,
    });

    mockClient.nodes = [makeNode({
      publicKey: 'pk-unique',
      alias: 'UniqueNode',
      channels: 100,
      capacity: 1_000_000_000,
    })];

    const result = await crawler.run();

    expect(result.newAgents).toBe(1);
    expect(agentRepo.count()).toBe(2);
  });

  it('only enriches non-lightning agents with capacity and lastSeen', async () => {
    // Pre-existing Observer Protocol agent with same hash
    const pubkey = 'pk-collision';
    const hash = sha256(pubkey);
    agentRepo.insert({
      public_key_hash: hash,
      public_key: null,
      alias: 'observer-agent',
      first_seen: 1500000000,
      last_seen: 1600000000,
      source: 'observer_protocol',
      total_transactions: 10,
      total_attestations_received: 5,
      avg_score: 75,
      capacity_sats: null,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      unique_peers: null,
      last_queried_at: null,
      query_count: 0,
    });

    mockClient.nodes = [makeNode({
      publicKey: pubkey,
      alias: 'Lightning Node',
      channels: 500,
      capacity: 1_000_000_000,
      updatedAt: 1700000000,
    })];

    const result = await crawler.run();

    expect(result.updatedAgents).toBe(1);
    const agent = agentRepo.findByHash(hash);
    // Alias, source, and total_transactions are preserved
    expect(agent!.alias).toBe('observer-agent');
    expect(agent!.source).toBe('observer_protocol');
    expect(agent!.total_transactions).toBe(10);
    // Only capacity and lastSeen are enriched
    expect(agent!.capacity_sats).toBe(1_000_000_000);
    expect(agent!.last_seen).toBe(1700000000);
  });
});
