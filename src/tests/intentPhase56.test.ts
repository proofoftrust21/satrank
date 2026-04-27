// Phase 5.6 — tests for the lower IS_MEANINGFUL threshold (5→3),
// the markProbed helper, and the new Bayesian-driven ranking in
// findServices.
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
  /** Seconds in the past for `last_checked_at`. 0 = "now", >3600 = stale. */
  probeAgeSec?: number;
}

async function seed(db: Pool, agentRepo: AgentRepository, repo: ServiceEndpointRepository, f: SeedFixture): Promise<void> {
  await agentRepo.insert(makeAgent(f.agentHash));
  await repo.upsert(f.agentHash, f.url, 200, 200, '402index');
  await repo.updateMetadata(f.url, {
    name: f.url, description: null, category: f.category, provider: null,
  });
  await repo.updatePrice(f.url, 5);
  // Seed posterior + last_checked_at directly.
  const lastChecked = NOW - (f.probeAgeSec ?? 0);
  await db.query(
    'UPDATE service_endpoints SET check_count = $1, success_count = $2, last_checked_at = $3 WHERE url = $4',
    [Math.round(f.alpha + f.beta), Math.round(f.alpha), lastChecked, f.url],
  );
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

describe('Phase 5.6 — IS_MEANINGFUL threshold lowered to 3', async () => {
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

  it('candidate with n_obs ≥ 3 and recent probe → is_meaningful=true', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('m1'), url: 'https://m1.example/x',
      category: 'data', alpha: 5, beta: 2, totalIngestions: 5, probeAgeSec: 30,
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].bayesian.is_meaningful).toBe(true);
  });

  it('candidate with α=4 β=2 (n_obs effective ≈ 3) → is_meaningful=true', async () => {
    // The verdict service reports n_obs as the excess over the (α₀=1.5, β₀=1.5)
    // prior, not the raw α+β. So α=4, β=2 → wSuccess=2.5, wFailure=0.5 → n_obs=3.0.
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('m2'), url: 'https://m2.example/x',
      category: 'data', alpha: 4, beta: 2, totalIngestions: 4, probeAgeSec: 30,
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].bayesian.is_meaningful).toBe(true);
  });

  it('candidate with α=2 β=2 (n_obs effective < 3) → is_meaningful=false', async () => {
    // α=2, β=2 → wSuccess=0.5, wFailure=0.5 → n_obs=1.0 < 3 threshold.
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('m3'), url: 'https://m3.example/x',
      category: 'data', alpha: 2, beta: 2, totalIngestions: 2, probeAgeSec: 30,
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].bayesian.is_meaningful).toBe(false);
  });

  it('candidate with n_obs ≥ 3 but stale probe → is_meaningful=false (freshness gate)', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('m4'), url: 'https://m4.example/x',
      category: 'data', alpha: 5, beta: 2, totalIngestions: 5,
      probeAgeSec: 7200, // 2 hours — past FRESHNESS_STALE_THRESHOLD_SEC (1h)
    });
    const svc = buildIntentService(db);
    const r = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].bayesian.is_meaningful).toBe(false);
  });
});

describe('Phase 5.6 — markProbed updates last_checked_at', async () => {
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

  it('markProbed bumps last_checked_at to nowSec', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('mp1'), url: 'https://mp1.example/x',
      category: 'data', alpha: 5, beta: 2, totalIngestions: 5, probeAgeSec: 7200,
    });
    const before = await serviceRepo.findByUrl('https://mp1.example/x');
    expect(before!.last_checked_at).toBe(NOW - 7200);

    await serviceRepo.markProbed('https://mp1.example/x', NOW);
    const after = await serviceRepo.findByUrl('https://mp1.example/x');
    expect(after!.last_checked_at).toBe(NOW);
  });

  it('markProbed defaults to "now" when nowSec omitted', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('mp2'), url: 'https://mp2.example/x',
      category: 'data', alpha: 5, beta: 2, totalIngestions: 5, probeAgeSec: 7200,
    });
    const beforeMs = Date.now();
    await serviceRepo.markProbed('https://mp2.example/x');
    const after = await serviceRepo.findByUrl('https://mp2.example/x');
    const afterMs = Date.now();
    expect(after!.last_checked_at).toBeGreaterThanOrEqual(Math.floor(beforeMs / 1000) - 1);
    expect(after!.last_checked_at).toBeLessThanOrEqual(Math.floor(afterMs / 1000) + 1);
  });

  it('markProbed on unknown URL is a no-op (does not throw)', async () => {
    await expect(
      serviceRepo.markProbed('https://does-not-exist.example/x'),
    ).resolves.not.toThrow();
  });
});

describe('Phase 5.6 — findServices ranks by Bayesian p_success', async () => {
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

  it('sort=p_success orders candidates by posterior_alpha / (alpha + beta) DESC', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('low'), url: 'https://low.example/x',
      category: 'data', alpha: 3, beta: 7, totalIngestions: 10, probeAgeSec: 30,
    });
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('mid'), url: 'https://mid.example/x',
      category: 'data', alpha: 6, beta: 4, totalIngestions: 10, probeAgeSec: 30,
    });
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('hi'), url: 'https://hi.example/x',
      category: 'data', alpha: 9, beta: 1, totalIngestions: 10, probeAgeSec: 30,
    });

    const { services } = await serviceRepo.findServices({
      category: 'data', sort: 'p_success', limit: 10, offset: 0,
    });
    expect(services).toHaveLength(3);
    expect(services[0].url).toBe('https://hi.example/x');
    expect(services[1].url).toBe('https://mid.example/x');
    expect(services[2].url).toBe('https://low.example/x');
  });

  it('tiebreaker on equal p_success: total_ingestions DESC wins', async () => {
    // Two candidates with α=6, β=4 → identical p_success = 0.6.
    // The one with more total_ingestions should rank first.
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('thin'), url: 'https://thin.example/x',
      category: 'data', alpha: 6, beta: 4, totalIngestions: 10, probeAgeSec: 30,
    });
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('thick'), url: 'https://thick.example/x',
      category: 'data', alpha: 6, beta: 4, totalIngestions: 30, probeAgeSec: 30,
    });
    const { services } = await serviceRepo.findServices({
      category: 'data', sort: 'p_success', limit: 10, offset: 0,
    });
    expect(services).toHaveLength(2);
    expect(services[0].url).toBe('https://thick.example/x');
    expect(services[1].url).toBe('https://thin.example/x');
  });

  it('endpoint without streaming row sorts last via COALESCE(0)', async () => {
    await seed(db, agentRepo, serviceRepo, {
      agentHash: sha256('p1'), url: 'https://p1.example/x',
      category: 'data', alpha: 6, beta: 4, totalIngestions: 10, probeAgeSec: 30,
    });
    // p2 — no streaming row at all (skip the INSERT). The seed helper
    // always inserts; do a manual partial seed.
    const noStreamHash = sha256('p2');
    await agentRepo.insert(makeAgent(noStreamHash));
    await serviceRepo.upsert(noStreamHash, 'https://p2.example/x', 200, 200, '402index');
    await serviceRepo.updateMetadata('https://p2.example/x', {
      name: 'p2', description: null, category: 'data', provider: null,
    });

    const { services } = await serviceRepo.findServices({
      category: 'data', sort: 'p_success', limit: 10, offset: 0,
    });
    expect(services).toHaveLength(2);
    expect(services[0].url).toBe('https://p1.example/x');
    expect(services[1].url).toBe('https://p2.example/x');
  });
});
