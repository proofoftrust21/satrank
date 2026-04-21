// DVM (NIP-90) tests — trust-check Data Vending Machine
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { SatRankDvm } from '../nostr/dvm';
import { sha256 } from '../utils/crypto';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import type { BayesianVerdictService } from '../services/bayesianVerdictService';
import type { Agent } from '../types';
import type { LndGraphClient, LndQueryRoutesResponse } from '../crawler/lndGraphClient';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256('02' + sha256(alias)),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - 3600,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 10,
    avg_score: 65,
    capacity_sats: 500000000,
    positive_ratings: 5,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 10,
    betweenness_rank: 20,
    hopness_rank: 0,
    query_count: 10,
    unique_peers: null,
    last_queried_at: null,
    ...overrides,
  };
}

function makeMockLnd(response: LndQueryRoutesResponse): LndGraphClient {
  return {
    getInfo: async () => ({ synced_to_graph: true, identity_pubkey: '02aaa', alias: 'mock', num_active_channels: 1, num_peers: 1, block_height: 800000 }),
    getGraph: async () => ({ nodes: [], edges: [] }),
    getNodeInfo: async () => null,
    queryRoutes: async () => response,
  };
}

describe('SatRankDvm', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let bayesianVerdict: BayesianVerdictService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    probeRepo = new ProbeRepository(db);
    bayesianVerdict = createBayesianVerdictService(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('creates a DVM without errors', async () => {
    const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdict, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });
    expect(dvm).toBeDefined();
  });

  it('processRequest returns Bayesian block for indexed agent', async () => {
    const agent = makeAgent('known-node');
    await agentRepo.insert(agent);
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: 500, failure_reason: null });

    const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdict, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const result = await (dvm as unknown as { processRequest: (p: string) => Promise<unknown> }).processRequest(agent.public_key!) as {
      source: string;
      reachable: boolean | null;
      alias: string | null;
      bayesian: { verdict: string; p_success: number; n_obs: number } | null;
      verdict: string;
    };
    expect(result.source).toBe('index');
    expect(result.reachable).toBe(true);
    expect(result.alias).toBe('known-node');
    expect(result.bayesian).not.toBeNull();
    expect(typeof result.bayesian!.p_success).toBe('number');
    expect(typeof result.bayesian!.n_obs).toBe('number');
    expect(['SAFE', 'RISKY', 'UNKNOWN', 'INSUFFICIENT']).toContain(result.bayesian!.verdict);
    expect(result.verdict).toBe(result.bayesian!.verdict);
  });

  it('processRequest returns live_ping for unknown node with LND', async () => {
    const mockLnd = makeMockLnd({ routes: [{ total_time_lock: 100, total_fees: '5', total_fees_msat: '5000', total_amt: '1005', total_amt_msat: '1005000', hops: [{ chan_id: '1', chan_capacity: '1000', amt_to_forward: '1000', fee: '5', fee_msat: '5000', pub_key: '02ccc' }] }] });

    const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdict, mockLnd, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'ff'.repeat(32);
    const result = await (dvm as unknown as { processRequest: (p: string) => Promise<unknown> }).processRequest(unknownPubkey) as {
      source: string;
      reachable: boolean | null;
      verdict: string;
      bayesian: unknown;
    };
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBe(true);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.bayesian).toBeNull();
  });

  it('processRequest returns RISKY for unreachable unknown node', async () => {
    const mockLnd = makeMockLnd({ routes: [] });

    const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdict, mockLnd, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'ee'.repeat(32);
    const result = await (dvm as unknown as { processRequest: (p: string) => Promise<unknown> }).processRequest(unknownPubkey) as {
      source: string;
      reachable: boolean | null;
      verdict: string;
      bayesian: unknown;
    };
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBe(false);
    expect(result.verdict).toBe('RISKY');
    expect(result.bayesian).toBeNull();
  });

  it('processRequest returns UNKNOWN when no LND configured', async () => {
    const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdict, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'dd'.repeat(32);
    const result = await (dvm as unknown as { processRequest: (p: string) => Promise<unknown> }).processRequest(unknownPubkey) as {
      source: string;
      reachable: boolean | null;
      verdict: string;
      bayesian: unknown;
    };
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBeNull();
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.bayesian).toBeNull();
  });
});
