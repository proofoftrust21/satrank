// DVM (NIP-90) tests — trust-check Data Vending Machine
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { SatRankDvm } from '../nostr/dvm';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
import type { LndGraphClient, LndQueryRoutesResponse } from '../crawler/lndGraphClient';

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

describe('SatRankDvm', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let snapshotRepo: SnapshotRepository;
  let scoringService: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(() => db.close());

  it('creates a DVM without errors', () => {
    const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });
    expect(dvm).toBeDefined();
  });

  it('processRequest returns score for known agent', async () => {
    const agent = makeAgent('known-node');
    agentRepo.insert(agent);
    scoringService.computeScore(agent.public_key_hash);
    probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: 500, failure_reason: null });

    const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    // Access private method via type assertion for testing
    const result = await (dvm as any).processRequest(agent.public_key!);
    expect(result.source).toBe('index');
    expect(result.score).toBeGreaterThan(0);
    expect(result.reachable).toBe(true);
    expect(result.alias).toBe('known-node');
  });

  it('processRequest returns live_ping for unknown node with LND', async () => {
    const mockLnd = makeMockLnd({ routes: [{ total_time_lock: 100, total_fees: '5', total_fees_msat: '5000', total_amt: '1005', total_amt_msat: '1005000', hops: [{ chan_id: '1', chan_capacity: '1000', amt_to_forward: '1000', fee: '5', fee_msat: '5000', pub_key: '02ccc' }] }] });

    const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService, mockLnd, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'ff'.repeat(32);
    const result = await (dvm as any).processRequest(unknownPubkey);
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBe(true);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.score).toBeNull();
  });

  it('processRequest returns RISKY for unreachable unknown node', async () => {
    const mockLnd = makeMockLnd({ routes: [] });

    const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService, mockLnd, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'ee'.repeat(32);
    const result = await (dvm as any).processRequest(unknownPubkey);
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBe(false);
    expect(result.verdict).toBe('RISKY');
  });

  it('processRequest returns UNKNOWN when no LND configured', async () => {
    const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService, undefined, {
      privateKeyHex: 'aa'.repeat(32),
      relays: [],
    });

    const unknownPubkey = '02' + 'dd'.repeat(32);
    const result = await (dvm as any).processRequest(unknownPubkey);
    expect(result.source).toBe('live_ping');
    expect(result.reachable).toBeNull();
    expect(result.verdict).toBe('UNKNOWN');
  });
});
