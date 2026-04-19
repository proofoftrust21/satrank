// ProbeCrawler bayesian bridge — proves that each base-amount LND probe
// (a) persists a row in `probe_results` (legacy contract),
// (b) writes a v31-enriched row in `transactions` when dualWriteMode='active'
//     and a legacy 9-col row when mode='off',
// (c) ingests into operator/endpoint streaming_posteriors + daily_buckets
//     regardless of dualWriteMode (scoring signal decoupled from tx flag),
// (d) is idempotent per (pubkey, UTC-day, amount) — rerun produces no duplicate
//     row in transactions and no double-count in streaming.
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
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
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
    new EndpointStreamingPosteriorRepository(db),
    new ServiceStreamingPosteriorRepository(db),
    new OperatorStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new RouteStreamingPosteriorRepository(db),
    new EndpointDailyBucketsRepository(db),
    new ServiceDailyBucketsRepository(db),
    new OperatorDailyBucketsRepository(db),
    new NodeDailyBucketsRepository(db),
    new RouteDailyBucketsRepository(db),
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

  it('writes tx row + streaming posteriors on a reachable probe (mode=active)', async () => {
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

    // Phase 3 streaming — probe alimente streaming_posteriors + daily_buckets
    // (operator + endpoint) en un unique chemin d'écriture.
    const streamingOp = db.prepare(
      `SELECT source, total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(reachableHash) as any;
    expect(streamingOp.source).toBe('probe');
    expect(streamingOp.total_ingestions).toBe(1);

    const streamingEp = db.prepare(
      `SELECT source, total_ingestions FROM endpoint_streaming_posteriors WHERE url_hash = ?`,
    ).get(reachableHash) as any;
    expect(streamingEp.source).toBe('probe');
    expect(streamingEp.total_ingestions).toBe(1);

    const bucketOp = db.prepare(
      `SELECT n_obs, n_success FROM operator_daily_buckets WHERE operator_id = ? AND source = 'probe'`,
    ).get(reachableHash) as any;
    expect(bucketOp.n_obs).toBe(1);
    expect(bucketOp.n_success).toBe(1);
  });

  it('writes tx row with failed status + failure counted in streaming on an unreachable probe', async () => {
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

    const bucket = db.prepare(
      `SELECT n_success, n_failure FROM operator_daily_buckets WHERE operator_id = ? AND source = 'probe'`,
    ).get(hash) as any;
    expect(bucket).toEqual(expect.objectContaining({ n_success: 0, n_failure: 1 }));
  });

  it('is idempotent: rerun produces no duplicate tx and no streaming double-count', async () => {
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

    const streaming = db.prepare(
      `SELECT total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(hash) as any;
    expect(streaming.total_ingestions).toBe(1);
  });

  it('mode=off skips v31 enrichment but still updates streaming', async () => {
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

    // Scoring signal is decoupled from dualWriteMode — streaming still writes.
    const streaming = db.prepare(
      `SELECT total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(hash) as any;
    expect(streaming.total_ingestions).toBe(1);
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

    const streamingCount = db.prepare(`SELECT COUNT(*) AS c FROM operator_streaming_posteriors`).get() as any;
    expect(streamingCount.c).toBe(0);
  });
});
