// LightningNetwork.plus crawler tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { LnplusCrawler } from '../crawler/lnplusCrawler';
import { sha256 } from '../utils/crypto';
import type { LnplusClient, LnplusNodeInfo } from '../crawler/lnplusClient';
import type { Agent } from '../types';

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

describe('LnplusCrawler', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let mockClient: MockLnplusClient;
  let crawler: LnplusCrawler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    mockClient = new MockLnplusClient();
    crawler = new LnplusCrawler(mockClient, agentRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('updates LN+ ratings for Lightning agents with pubkey', async () => {
    const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
    agentRepo.insert(makeAgent(pubkey, 'ACINQ'));

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

    const agent = agentRepo.findByHash(sha256(pubkey));
    expect(agent!.positive_ratings).toBe(42);
    expect(agent!.negative_ratings).toBe(2);
    expect(agent!.lnplus_rank).toBe(8);
    expect(agent!.hubness_rank).toBe(25);
    expect(agent!.betweenness_rank).toBe(30);
    expect(agent!.hopness_rank).toBe(15);
  });

  it('queries LN+ with the original pubkey, not the hash', async () => {
    const pubkey = 'pk-original-test';
    agentRepo.insert(makeAgent(pubkey, 'TestNode'));

    await crawler.run();

    expect(mockClient.queriedPubkeys).toEqual([pubkey]);
  });

  it('skips agents without a stored pubkey', async () => {
    // Insert agent without public_key
    agentRepo.insert({
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
      query_count: 0,
    });

    const result = await crawler.run();

    expect(result.queried).toBe(0);
    expect(mockClient.queriedPubkeys).toHaveLength(0);
  });

  it('counts not-found nodes', async () => {
    agentRepo.insert(makeAgent('pk-unknown', 'Unknown'));
    // No response set = returns null = not found

    const result = await crawler.run();

    expect(result.queried).toBe(1);
    expect(result.notFound).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('handles multiple agents', async () => {
    agentRepo.insert(makeAgent('pk-a', 'NodeA'));
    agentRepo.insert(makeAgent('pk-b', 'NodeB'));
    agentRepo.insert(makeAgent('pk-c', 'NodeC'));

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

  it('continues when individual node fetch fails', async () => {
    agentRepo.insert(makeAgent('pk-ok', 'OKNode'));
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
    agentRepo.insert(makeAgent('pk-fail', 'FailNode'));
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
