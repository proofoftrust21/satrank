// LightningNetwork.plus crawler tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { LnplusCrawler } from '../crawler/lnplusCrawler';
import { sha256 } from '../utils/crypto';
import type { LnplusClient, LnplusNodeInfo } from '../crawler/lnplusClient';
import type { Agent } from '../types';
let testDb: TestDb;

function makeAgent(pubkey: string, alias: string): Agent {
  return {
    public_key_hash: sha256(pubkey),
    public_key: pubkey,
    alias,
    first_seen: 1600000000,
    last_seen: 1700000000,
    source: 'lightning_graph',
    total_transactions: 500,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 5_000_000_000,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

class MockLnplusClient implements LnplusClient {
  responses: Map<string, LnplusNodeInfo | null> = new Map();
  queriedPubkeys: string[] = [];
  shouldFail = false;

  async fetchNodeInfo(pubkey: string): Promise<LnplusNodeInfo | null> {
    this.queriedPubkeys.push(pubkey);
    if (this.shouldFail) throw new Error('LN+ down');
    return this.responses.get(pubkey) ?? null;
  }
}

describe('LnplusCrawler', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let mockClient: MockLnplusClient;
  let crawler: LnplusCrawler;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    mockClient = new MockLnplusClient();
    crawler = new LnplusCrawler(mockClient, agentRepo);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('updates LN+ ratings for Lightning agents with pubkey', async () => {
    const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
    await agentRepo.insert(makeAgent(pubkey, 'ACINQ'));

    mockClient.responses.set(pubkey, {
      positive_ratings: 42,
      negative_ratings: 2,
      lnp_rank: 8,
      lnp_rank_name: 'Gold',
      hubness_rank: 25,
      betweenness_rank: 30,
      hopness_rank: 15,
    });

    const result = await crawler.run();

    expect(result.queried).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.notFound).toBe(0);

    const agent = await agentRepo.findByHash(sha256(pubkey));
    expect(agent!.positive_ratings).toBe(42);
    expect(agent!.negative_ratings).toBe(2);
    expect(agent!.lnplus_rank).toBe(8);
    expect(agent!.hubness_rank).toBe(25);
    expect(agent!.betweenness_rank).toBe(30);
    expect(agent!.hopness_rank).toBe(15);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('queries LN+ with the original pubkey, not the hash', async () => {
    const pubkey = 'pk-original-test';
    await agentRepo.insert(makeAgent(pubkey, 'TestNode'));

    await crawler.run();

    expect(mockClient.queriedPubkeys).toEqual([pubkey]);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('skips agents without a stored pubkey', async () => {
    // Insert agent without public_key
    await agentRepo.insert({
      public_key_hash: sha256('observer-alias'),
      public_key: null,
      alias: 'observer-agent',
      first_seen: 1600000000,
      last_seen: 1700000000,
      source: 'observer_protocol',
      total_transactions: 10,
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

    const result = await crawler.run();

    expect(result.queried).toBe(0);
    expect(mockClient.queriedPubkeys).toHaveLength(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('counts not-found nodes', async () => {
    await agentRepo.insert(makeAgent('pk-unknown', 'Unknown'));
    // No response set = returns null = not found

    const result = await crawler.run();

    expect(result.queried).toBe(1);
    expect(result.notFound).toBe(1);
    expect(result.updated).toBe(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('handles multiple agents', async () => {
    await agentRepo.insert(makeAgent('pk-a', 'NodeA'));
    await agentRepo.insert(makeAgent('pk-b', 'NodeB'));
    await agentRepo.insert(makeAgent('pk-c', 'NodeC'));

    mockClient.responses.set('pk-a', {
      positive_ratings: 10,
      negative_ratings: 1,
      lnp_rank: 5,
      lnp_rank_name: 'Silver',
      hubness_rank: 100,
      betweenness_rank: 200,
      hopness_rank: 50,
    });
    mockClient.responses.set('pk-b', {
      positive_ratings: 0,
      negative_ratings: 0,
      lnp_rank: 1,
      lnp_rank_name: 'Iron',
      hubness_rank: 500,
      betweenness_rank: 600,
      hopness_rank: 400,
    });
    // pk-c not on LN+

    const result = await crawler.run();

    expect(result.queried).toBe(3);
    expect(result.updated).toBe(2);
    expect(result.notFound).toBe(1);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('continues when individual node fetch fails', async () => {
    await agentRepo.insert(makeAgent('pk-ok', 'OKNode'));
    mockClient.responses.set('pk-ok', {
      positive_ratings: 5,
      negative_ratings: 0,
      lnp_rank: 3,
      lnp_rank_name: 'Bronze',
      hubness_rank: 80,
      betweenness_rank: 90,
      hopness_rank: 70,
    });

    // Override to fail on specific key
    const originalFetch = mockClient.fetchNodeInfo.bind(mockClient);
    await agentRepo.insert(makeAgent('pk-fail', 'FailNode'));
    let callCount = 0;
    mockClient.fetchNodeInfo = async (pubkey: string) => {
      callCount++;
      if (pubkey === 'pk-fail') throw new Error('Timeout');
      return originalFetch(pubkey);
    };

    const result = await crawler.run();

    expect(result.updated).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Timeout');
  });
});
