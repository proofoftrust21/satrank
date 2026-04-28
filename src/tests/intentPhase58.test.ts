// Phase 5.8 — tests for the `optimize=` parameter and the new
// reliability_score / uptime_30d signals on /api/intent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { TrendService } from '../services/trendService';
import { AgentService } from '../services/agentService';
import { IntentService } from '../services/intentService';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import { endpointHash } from '../utils/urlCanonical';
import type { Agent } from '../types';

let testDb: TestDb;
const NOW = Math.floor(Date.now() / 1000);

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash, public_key: `02${hash.slice(0, 64)}`, alias: 'op',
    first_seen: NOW - 365 * 86400, last_seen: NOW - 60, source: 'attestation',
    total_transactions: 50, total_attestations_received: 0, avg_score: 70,
    capacity_sats: null, positive_ratings: 10, negative_ratings: 0,
    lnplus_rank: 3, hubness_rank: 0, betweenness_rank: 0, hopness_rank: 0,
    unique_peers: null, last_queried_at: null, query_count: 0,
  };
}

interface SeedFixture {
  agentHash: string;
  url: string;
  category: string;
  alpha: number;
  beta: number;
  totalIngestions: number;
  priceSats?: number;
  lastLatencyMs?: number;
  reliability?: number;
  uptime30d?: number;
}

async function seed(db: Pool, agentRepo: AgentRepository, repo: ServiceEndpointRepository, f: SeedFixture): Promise<void> {
  // Agent insert is idempotent — multiple endpoints can share an operator.
  await db.query(
    `INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score, capacity_sats, positive_ratings, negative_ratings, lnplus_rank, hubness_rank, betweenness_rank, hopness_rank, unique_peers, last_queried_at, query_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (public_key_hash) DO NOTHING`,
    [f.agentHash, `02${f.agentHash.slice(0, 64)}`, 'op', NOW - 365 * 86400, NOW - 60, 'attestation', 50, 0, 70, null, 10, 0, 3, 0, 0, 0, null, null, 0],
  );
  void agentRepo;
  await repo.upsert(f.agentHash, f.url, 200, f.lastLatencyMs ?? 200, '402index');
  await repo.updateMetadata(f.url, {
    name: f.url, description: null, category: f.category, provider: null,
  });
  await repo.updatePrice(f.url, f.priceSats ?? 5);
  await db.query(
    'UPDATE service_endpoints SET check_count = $1, success_count = $2, last_checked_at = $3, last_latency_ms = $4 WHERE url = $5',
    [Math.round(f.alpha + f.beta), Math.round(f.alpha), NOW - 30, f.lastLatencyMs ?? 200, f.url],
  );
  if (f.reliability != null) {
    await db.query('UPDATE service_endpoints SET upstream_reliability_score = $1 WHERE url = $2', [f.reliability, f.url]);
  }
  if (f.uptime30d != null) {
    await db.query('UPDATE service_endpoints SET upstream_uptime_30d = $1 WHERE url = $2', [f.uptime30d, f.url]);
  }
  await db.query(
    `INSERT INTO endpoint_streaming_posteriors
       (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
     VALUES ($1, 'probe', $2, $3, $4, $5)
     ON CONFLICT (url_hash, source) DO UPDATE SET
       posterior_alpha = EXCLUDED.posterior_alpha,
       posterior_beta = EXCLUDED.posterior_beta,
       last_update_ts = EXCLUDED.last_update_ts,
       total_ingestions = EXCLUDED.total_ingestions`,
    [endpointHash(f.url), f.alpha, f.beta, NOW, f.totalIngestions],
  );
}

function buildIntentService(db: Pool): IntentService {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  const probeRepo = new ProbeRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdict, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  return new IntentService({
    serviceEndpointRepo: serviceRepo,
    agentRepo,
    agentService,
    bayesianVerdictService: bayesianVerdict,
    trendService,
    probeRepo,
    now: () => NOW,
  });
}

describe('Phase 5.8 — reliability + uptime signals on /api/intent', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let serviceRepo: ServiceEndpointRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    serviceRepo = new ServiceEndpointRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('reliability_score and uptime_30d surface on candidate when populated', async () => {
    const op = sha256('relU');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://r.example/api', category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
      reliability: 92, uptime30d: 0.97,
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].reliability_score).toBe(92);
    expect(r.candidates[0].uptime_30d).toBeCloseTo(0.97);
  });

  it('reliability_score / uptime_30d omitted when null', async () => {
    const op = sha256('relNull');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://rn.example/api', category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
      // No reliability/uptime passed.
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates[0].reliability_score).toBeUndefined();
    expect(r.candidates[0].uptime_30d).toBeUndefined();
  });
});

describe('Phase 5.8 — optimize= parameter', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let serviceRepo: ServiceEndpointRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    serviceRepo = new ServiceEndpointRepository(db);

    // Seed 3 endpoints under the SAME operator so per-endpoint variance
    // is the only differentiator. p_success increases with index; latency
    // decreases (lower = better); reliability flips; price decreases.
    const op = sha256('opt-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://o.example/A', category: 'data',
      alpha: 9, beta: 1, totalIngestions: 10,        // p ≈ 0.9
      lastLatencyMs: 800,                            // slowest
      reliability: 60,                               // mid-low
      priceSats: 50,                                 // most expensive
    });
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://o.example/B', category: 'data',
      alpha: 6, beta: 4, totalIngestions: 10,        // p ≈ 0.6
      lastLatencyMs: 100,                            // fastest
      reliability: 95,                               // highest
      priceSats: 5,                                  // cheapest
    });
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://o.example/C', category: 'data',
      alpha: 3, beta: 7, totalIngestions: 10,        // p ≈ 0.3
      lastLatencyMs: 400,                            // mid
      reliability: 80,                               // mid
      priceSats: 20,                                 // mid
    });
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('default (optimize omitted) → p_success DESC', async () => {
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.intent.optimize).toBe('p_success');
    expect(r.candidates[0].endpoint_url).toBe('https://o.example/A'); // p=0.9
    expect(r.candidates[1].endpoint_url).toBe('https://o.example/B'); // p=0.6
    expect(r.candidates[2].endpoint_url).toBe('https://o.example/C'); // p=0.3
  });

  it('optimize=latency → fastest first', async () => {
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'latency' }, 5);
    expect(r.intent.optimize).toBe('latency');
    expect(r.candidates[0].endpoint_url).toBe('https://o.example/B'); // 100ms
    expect(r.candidates[1].endpoint_url).toBe('https://o.example/C'); // 400ms
    expect(r.candidates[2].endpoint_url).toBe('https://o.example/A'); // 800ms
  });

  it('optimize=reliability → highest reliability_score first', async () => {
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'reliability' }, 5);
    expect(r.intent.optimize).toBe('reliability');
    expect(r.candidates[0].endpoint_url).toBe('https://o.example/B'); // 95
    expect(r.candidates[1].endpoint_url).toBe('https://o.example/C'); // 80
    expect(r.candidates[2].endpoint_url).toBe('https://o.example/A'); // 60
  });

  it('optimize=cost → cheapest first', async () => {
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'cost' }, 5);
    expect(r.intent.optimize).toBe('cost');
    expect(r.candidates[0].endpoint_url).toBe('https://o.example/B'); // 5 sats
    expect(r.candidates[1].endpoint_url).toBe('https://o.example/C'); // 20 sats
    expect(r.candidates[2].endpoint_url).toBe('https://o.example/A'); // 50 sats
  });

  it('meta.ranking_explanation primary changes with optimize axis', async () => {
    const svc = buildIntentService(db);
    const rP = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    const rL = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'latency' }, 5);
    const rR = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'reliability' }, 5);
    const rC = await svc.resolveIntent({ category: 'data', keywords: [], optimize: 'cost' }, 5);
    expect(rP.meta.ranking_explanation.primary).toMatch(/is_meaningful/);
    expect(rL.meta.ranking_explanation.primary).toMatch(/median_latency_ms ASC/);
    expect(rR.meta.ranking_explanation.primary).toMatch(/upstream_reliability_score DESC/);
    expect(rC.meta.ranking_explanation.primary).toMatch(/price_sats ASC/);
  });

  it('intent.optimize is echoed back even when default', async () => {
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.intent.optimize).toBe('p_success');
  });
});
