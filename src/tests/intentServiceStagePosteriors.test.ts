// Phase 5.14 — intentService propagates stage_posteriors block when the
// EndpointStagePosteriorsRepository is wired. Test isolé pour ne pas
// alourdir intentService.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  setupTestPool,
  teardownTestPool,
  type TestDb,
} from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import {
  EndpointStagePosteriorsRepository,
  STAGE_CHALLENGE,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';
import { TrendService } from '../services/trendService';
import { AgentService } from '../services/agentService';
import { IntentService } from '../services/intentService';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

let testDb: TestDb;
const NOW = Math.floor(Date.now() / 1000);

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: `02${hash.slice(0, 64)}`,
    alias: 'op',
    first_seen: NOW - 365 * 86400,
    last_seen: NOW - 86400,
    source: 'attestation',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 70,
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

function buildService(
  db: Pool,
  withStagePosteriorsRepo: boolean,
): IntentService {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  const probeRepo = new ProbeRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const agentService = new AgentService(
    agentRepo,
    txRepo,
    attestationRepo,
    bayesianVerdict,
    probeRepo,
  );
  const trendService = new TrendService(agentRepo, snapshotRepo);
  return new IntentService({
    serviceEndpointRepo: serviceRepo,
    agentRepo,
    agentService,
    bayesianVerdictService: bayesianVerdict,
    trendService,
    probeRepo,
    endpointStagePosteriorsRepo: withStagePosteriorsRepo
      ? new EndpointStagePosteriorsRepository(db)
      : undefined,
    now: () => NOW,
  });
}

describe('IntentService — stage_posteriors propagation (Phase 5.14)', () => {
  let db: Pool;
  let serviceRepo: ServiceEndpointRepository;
  let agentRepo: AgentRepository;
  let stagesRepo: EndpointStagePosteriorsRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    serviceRepo = new ServiceEndpointRepository(db);
    agentRepo = new AgentRepository(db);
    stagesRepo = new EndpointStagePosteriorsRepository(db);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('omits stage_posteriors when the repo is not wired (back-compat)', async () => {
    const hash = sha256('op-no-repo');
    await agentRepo.insert(makeAgent(hash));
    const url = 'https://no-repo.example/data';
    await serviceRepo.upsert(hash, url, 200, 100, '402index');
    await serviceRepo.updateMetadata(url, {
      name: 'no-repo',
      description: null,
      category: 'data',
      provider: null,
    });
    await serviceRepo.updatePrice(url, 5);
    // Insert stage data — but build the service WITHOUT the repo, so the
    // candidate response should NOT include stage_posteriors.
    await stagesRepo.observe(
      { endpoint_url: url, stage: STAGE_CHALLENGE, success: true },
      NOW,
    );

    const svc = buildService(db, /* withStagePosteriorsRepo */ false);
    const result = await svc.resolveIntent({ category: 'data' }, undefined);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const cand = result.candidates.find(c => c.endpoint_url === url);
    expect(cand).toBeDefined();
    expect(cand!.stage_posteriors).toBeUndefined();
  });

  it('omits stage_posteriors when the repo is wired but no rows exist for the endpoint', async () => {
    const hash = sha256('op-empty-stages');
    await agentRepo.insert(makeAgent(hash));
    const url = 'https://empty-stages.example/data';
    await serviceRepo.upsert(hash, url, 200, 100, '402index');
    await serviceRepo.updateMetadata(url, {
      name: 'empty',
      description: null,
      category: 'data',
      provider: null,
    });
    await serviceRepo.updatePrice(url, 5);

    const svc = buildService(db, /* withStagePosteriorsRepo */ true);
    const result = await svc.resolveIntent({ category: 'data' }, undefined);
    const cand = result.candidates.find(c => c.endpoint_url === url);
    expect(cand).toBeDefined();
    expect(cand!.stage_posteriors).toBeUndefined();
  });

  it('Phase 6.5 — fresh=false response is cached (idempotent), fresh=true bypasses cache', async () => {
    const hash = sha256('op-cache');
    await agentRepo.insert(makeAgent(hash));
    const url = 'https://cache.example/data';
    await serviceRepo.upsert(hash, url, 200, 100, '402index');
    await serviceRepo.updateMetadata(url, {
      name: 'cache',
      description: null,
      category: 'data',
      provider: null,
    });
    await serviceRepo.updatePrice(url, 5);

    const svc = buildService(db, true);
    // Première requête fresh=false : compute + cache.
    const a = await svc.resolveIntent({ category: 'data' }, undefined);
    let stats = svc.getResponseCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.size).toBe(1);

    // 2e requête identique : hit.
    const b = await svc.resolveIntent({ category: 'data' }, undefined);
    stats = svc.getResponseCacheStats();
    expect(stats.hits).toBe(1);
    expect(b).toEqual(a); // identical response

    // 3e requête fresh=true : bypass cache (pas de hit + pas de miss compté).
    await svc.resolveIntent({ category: 'data' }, undefined, { fresh: true });
    const stats3 = svc.getResponseCacheStats();
    expect(stats3.hits).toBe(1); // pas changé
    // Note : fresh=true ne consume pas le compteur hits/misses (cache.get
    // n'est pas appelé). En revanche, on ne set() pas non plus pour
    // ne pas polluer le cache fresh=false avec une réponse fresh.

    // Clear puis nouvelle requête : miss à nouveau.
    svc.clearResponseCache();
    await svc.resolveIntent({ category: 'data' }, undefined);
    const statsClear = svc.getResponseCacheStats();
    expect(statsClear.misses).toBe(1);
    expect(statsClear.hits).toBe(0);
  });

  it('emits stage_posteriors when at least one stage has data; meaningful_stages reflects threshold', async () => {
    const hash = sha256('op-staged');
    await agentRepo.insert(makeAgent(hash));
    const url = 'https://staged.example/data';
    await serviceRepo.upsert(hash, url, 200, 100, '402index');
    await serviceRepo.updateMetadata(url, {
      name: 'staged',
      description: null,
      category: 'data',
      provider: null,
    });
    await serviceRepo.updatePrice(url, 5);

    // Stage 1 (challenge) : 9 successes → meaningful (n_obs >= 3)
    for (let i = 0; i < 9; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_CHALLENGE, success: true },
        NOW,
      );
    }
    // Stage 3 (payment) : 1 success → NOT meaningful (n_obs = 1 < 3)
    await stagesRepo.observe(
      { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
      NOW,
    );
    // Stage 4 (delivery) : 5 failures → meaningful (n_obs >= 3), but low p
    for (let i = 0; i < 5; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: false },
        NOW,
      );
    }

    const svc = buildService(db, /* withStagePosteriorsRepo */ true);
    const result = await svc.resolveIntent({ category: 'data' }, undefined);
    const cand = result.candidates.find(c => c.endpoint_url === url);
    expect(cand).toBeDefined();
    const sp = cand!.stage_posteriors;
    expect(sp).toBeDefined();
    expect(sp!.measured_stages).toBe(3);
    expect(sp!.meaningful_stages).toEqual(['challenge', 'delivery']);
    expect(Object.keys(sp!.stages).sort()).toEqual([
      'challenge',
      'delivery',
      'payment',
    ]);
    expect(sp!.stages.challenge.is_meaningful).toBe(true);
    expect(sp!.stages.payment.is_meaningful).toBe(false);
    expect(sp!.stages.delivery.is_meaningful).toBe(true);
    // p_e2e is the product of challenge × delivery (payment excluded).
    // challenge α≈10.5/12 ≈ 0.875, delivery α≈1.5/8 ≈ 0.19.
    // Product ≈ 0.166.
    expect(sp!.p_e2e).toBeGreaterThan(0);
    expect(sp!.p_e2e).toBeLessThan(0.3);
    expect(sp!.p_e2e).toBeCloseTo(
      sp!.stages.challenge.p_success * sp!.stages.delivery.p_success,
      4,
    );
  });
});
