// ProbeCrawler bayesian bridge — proves that each base-amount LND probe
// (a) persists a row in `probe_results` (legacy contract),
// (b) writes a v31-enriched row in `transactions` when dualWriteMode='active'
//     and a legacy 9-col row when mode='off',
// (c) upserts operator/endpoint aggregates in all 3 bayesian windows regardless
//     of the mode (Q1: ingestion decoupled from flag),
// (d) is idempotent per (pubkey, UTC-day, amount) — rerun produces no duplicate
//     row in transactions and no double-count in aggregates.
//
// The LND client is stubbed so the test never hits the network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import {
  EndpointAggregateRepository,
  OperatorAggregateRepository,
  ServiceAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { ProbeCrawler } from '../crawler/probeCrawler';
import type { LndGraphClient, LndQueryRoutesResponse } from '../crawler/lndGraphClient';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(pubkey: string): Agent {
  return {
    public_key_hash: pubkey,
    public_key: pubkey,
    alias: `node-${pubkey.slice(0, 6)}`,
    first_seen: NOW - 30 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
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
    last_queried_at: null,
    query_count: 0,
  };
}

function stubLndClient(reachableByPubkey: Map<string, boolean>): LndGraphClient {
  return {
    async getInfo() { return { identity_pubkey: 'stub', alias: 'stub', num_active_channels: 0, block_height: 0, synced_to_chain: true } as any; },
    async getGraph() { return { nodes: [], edges: [] } as any; },
    async getNodeInfo() { return null; },
    async queryRoutes(pubkey: string): Promise<LndQueryRoutesResponse> {
      if (reachableByPubkey.get(pubkey)) {
        return {
          routes: [{
            total_time_lock: 0,
            total_fees: '1',
            total_fees_msat: '1000',
            total_amt: '1000',
            total_amt_msat: '1000000',
            hops: [{ chan_id: '1', chan_capacity: '100000', amt_to_forward: '1000', fee: '1', fee_msat: '1000', pub_key: pubkey }],
          }],
        };
      }
      return { routes: [] };
    },
  };
}

function buildCrawler(db: Database.Database, reachable: Map<string, boolean>, mode: 'off' | 'active' = 'active') {
  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const probeRepo = new ProbeRepository(db);
  const bayesian = new BayesianScoringService(
    new EndpointAggregateRepository(db),
    new ServiceAggregateRepository(db),
    new OperatorAggregateRepository(db),
    new NodeAggregateRepository(db),
    new RouteAggregateRepository(db),
  );
  const lnd = stubLndClient(reachable);
  const crawler = new ProbeCrawler(
    lnd, agentRepo, probeRepo,
    { maxPerSecond: 1000, amountSats: 1000, dualWriteMode: mode },
    { txRepo, bayesian, db },
  );
  return { crawler, agentRepo, txRepo, probeRepo };
}

describe('ProbeCrawler bayesian bridge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('writes tx row + operator aggregates on a reachable probe (mode=active)', async () => {
    const reachableKey = 'aa'.repeat(33);
    const reachableHash = 'bb'.repeat(32);

    const agentRepo = new AgentRepository(db);
    agentRepo.insert({ ...makeAgent(reachableKey), public_key_hash: reachableHash });

    const { crawler } = buildCrawler(db, new Map([[reachableKey, true]]), 'active');
    await crawler.run();

    const tx = db.prepare(
      `SELECT * FROM transactions WHERE endpoint_hash = ? AND source = 'probe' AND timestamp >= ?`,
    ).get(reachableHash, NOW - DAY) as any;
    expect(tx).toBeDefined();
    expect(tx.status).toBe('verified');
    expect(tx.operator_id).toBe(reachableHash);
    expect(tx.window_bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const opAgg = db.prepare(
      `SELECT window, n_success, n_failure, n_obs FROM operator_aggregates WHERE operator_id = ? ORDER BY window`,
    ).all(reachableHash) as any[];
    expect(opAgg.length).toBe(3);
    expect(opAgg.every(r => r.n_success === 1 && r.n_failure === 0 && r.n_obs === 1)).toBe(true);

    const epAgg = db.prepare(
      `SELECT window, n_obs FROM endpoint_aggregates WHERE url_hash = ?`,
    ).all(reachableHash) as any[];
    expect(epAgg.length).toBe(3);
    expect(epAgg.every(r => r.n_obs === 1)).toBe(true);
  });

  it('writes tx row with failed status + failure aggregates on an unreachable probe', async () => {
    const pubkey = 'cc'.repeat(33);
    const hash = 'dd'.repeat(32);

    const agentRepo = new AgentRepository(db);
    agentRepo.insert({ ...makeAgent(pubkey), public_key_hash: hash });

    const { crawler } = buildCrawler(db, new Map([[pubkey, false]]), 'active');
    await crawler.run();

    const tx = db.prepare(
      `SELECT status, source FROM transactions WHERE endpoint_hash = ?`,
    ).get(hash) as any;
    expect(tx.status).toBe('failed');
    expect(tx.source).toBe('probe');

    const opAgg = db.prepare(
      `SELECT n_success, n_failure FROM operator_aggregates WHERE operator_id = ? AND window = '7d'`,
    ).get(hash) as any;
    expect(opAgg).toEqual(expect.objectContaining({ n_success: 0, n_failure: 1 }));
  });

  it('is idempotent: rerun produces no duplicate tx and no aggregate double-count', async () => {
    const pubkey = 'ee'.repeat(33);
    const hash = 'ff'.repeat(32);

    const agentRepo = new AgentRepository(db);
    agentRepo.insert({ ...makeAgent(pubkey), public_key_hash: hash });

    const { crawler } = buildCrawler(db, new Map([[pubkey, true]]), 'active');
    await crawler.run();
    await crawler.run();

    const txCount = db.prepare(
      `SELECT COUNT(*) AS c FROM transactions WHERE endpoint_hash = ? AND source = 'probe'`,
    ).get(hash) as any;
    expect(txCount.c).toBe(1);

    const opAgg = db.prepare(
      `SELECT n_obs FROM operator_aggregates WHERE operator_id = ? AND window = '7d'`,
    ).get(hash) as any;
    expect(opAgg.n_obs).toBe(1);
  });

  it('mode=off skips v31 enrichment but still updates aggregates', async () => {
    const pubkey = '11'.repeat(33);
    const hash = '22'.repeat(32);

    const agentRepo = new AgentRepository(db);
    agentRepo.insert({ ...makeAgent(pubkey), public_key_hash: hash });

    const { crawler } = buildCrawler(db, new Map([[pubkey, true]]), 'off');
    await crawler.run();

    const tx = db.prepare(
      `SELECT endpoint_hash, operator_id, source, window_bucket, status FROM transactions WHERE sender_hash = ?`,
    ).get(hash) as any;
    expect(tx).toBeDefined();
    expect(tx.status).toBe('verified');
    expect(tx.endpoint_hash).toBeNull();
    expect(tx.operator_id).toBeNull();
    expect(tx.source).toBeNull();
    expect(tx.window_bucket).toBeNull();

    const opAgg = db.prepare(
      `SELECT n_obs FROM operator_aggregates WHERE operator_id = ? AND window = '7d'`,
    ).get(hash) as any;
    expect(opAgg.n_obs).toBe(1);
  });

  it('ingests nothing when bayesianDeps missing — legacy probe_results only', async () => {
    const pubkey = '33'.repeat(33);
    const hash = '44'.repeat(32);

    const agentRepo = new AgentRepository(db);
    agentRepo.insert({ ...makeAgent(pubkey), public_key_hash: hash });

    const probeRepo = new ProbeRepository(db);
    const lnd = stubLndClient(new Map([[pubkey, true]]));
    const crawler = new ProbeCrawler(
      lnd, agentRepo, probeRepo,
      { maxPerSecond: 1000, amountSats: 1000 },
    );
    await crawler.run();

    const probeRow = db.prepare(`SELECT reachable FROM probe_results WHERE target_hash = ?`).get(hash) as any;
    expect(probeRow.reachable).toBe(1);

    const txCount = db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get() as any;
    expect(txCount.c).toBe(0);

    const opCount = db.prepare(`SELECT COUNT(*) AS c FROM operator_aggregates`).get() as any;
    expect(opCount.c).toBe(0);
  });
});
