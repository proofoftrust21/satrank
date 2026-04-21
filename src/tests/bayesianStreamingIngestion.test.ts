// Phase 3 refactor — tests pour ingestStreaming + computeRiskProfile (C5).
//
// Garanties :
//   - ingestStreaming écrit dans streaming_posteriors ET daily_buckets quand
//     source ∈ {probe, report, paid} + repos wired
//   - weightForSource est bien appliqué (probe=1.0, paid=2.0, report tier-based)
//   - Ingestion multi-niveaux (endpoint + service + operator + route) en un appel
//   - Absence de repo → no-op silencieux pour ce niveau (rétro-compat)
//   - computeRiskProfile — Option B :
//     * fenêtre récente = 7 derniers jours
//     * fenêtre antérieure = 23 jours avant
//     * classification low / medium / high / unknown selon delta
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  RouteDailyBucketsRepository,
  NodeDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { WEIGHT_PAID_PROBE, WEIGHT_SOVEREIGN_PROBE, WEIGHT_REPORT_NIP98, DEFAULT_PRIOR_ALPHA } from '../config/bayesianConfig';
let testDb: TestDb;

const NOW = Date.UTC(2026, 3, 18, 12, 0, 0) / 1000;

function makeService(db: Pool): BayesianScoringService {
  return new BayesianScoringService(
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
}

describe('ingestStreaming — routage par source', async () => {
  let db: Pool;
  let svc: BayesianScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    svc = makeService(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('source=probe écrit dans streaming ET buckets (poids=1.0)', async () => {
    const r = await svc.ingestStreaming({
      success: true,
      timestamp: NOW,
      source: 'probe',
      endpointHash: 'h1',
    });
    expect(r.endpointUpdates).toBe(1);
    expect(r.bucketsBumped).toBe(1);

    const streamingRow = (await db.query<{ posterior_alpha: number; posterior_beta: number }>(
      `SELECT * FROM endpoint_streaming_posteriors WHERE url_hash='h1' AND source='probe'`,
    )).rows[0];
    expect(streamingRow.posterior_alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + WEIGHT_SOVEREIGN_PROBE, 6);

    const bucketRow = (await db.query<{ n_success: number; n_obs: number }>(
      `SELECT * FROM endpoint_daily_buckets WHERE url_hash='h1' AND source='probe'`,
    )).rows[0];
    expect(bucketRow.n_success).toBe(1);
    expect(bucketRow.n_obs).toBe(1);
  });

  it('source=paid applique le poids paid (2.0)', async () => {
    await svc.ingestStreaming({
      success: true,
      timestamp: NOW,
      source: 'paid',
      endpointHash: 'h2',
    });
    const streamingRow = (await db.query<{ posterior_alpha: number }>(
      `SELECT * FROM endpoint_streaming_posteriors WHERE url_hash='h2' AND source='paid'`,
    )).rows[0];
    expect(streamingRow.posterior_alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + WEIGHT_PAID_PROBE, 6);
  });

  it('source=report nip98 applique le poids tier (1.0)', async () => {
    await svc.ingestStreaming({
      success: true,
      timestamp: NOW,
      source: 'report',
      tier: 'nip98',
      endpointHash: 'h3',
    });
    const streamingRow = (await db.query<{ posterior_alpha: number }>(
      `SELECT * FROM endpoint_streaming_posteriors WHERE url_hash='h3' AND source='report'`,
    )).rows[0];
    expect(streamingRow.posterior_alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + WEIGHT_REPORT_NIP98, 6);
  });

  it('ingestion multi-niveaux (endpoint + service + operator + route) en un appel', async () => {
    const r = await svc.ingestStreaming({
      success: true,
      timestamp: NOW,
      source: 'probe',
      endpointHash: 'ep1',
      serviceHash: 'sv1',
      operatorId: 'op1',
      callerHash: 'caller-A',
      targetHash: 'target-B',
    });
    expect(r.endpointUpdates).toBe(1);
    expect(r.serviceUpdates).toBe(1);
    expect(r.operatorUpdates).toBe(1);
    expect(r.routeUpdates).toBe(1);
    expect(r.bucketsBumped).toBe(4); // endpoint + service + operator + route

    const routeRow = (await db.query<{ route_hash: string; posterior_alpha: number }>(
      `SELECT * FROM route_streaming_posteriors WHERE caller_hash='caller-A' AND target_hash='target-B'`,
    )).rows[0];
    expect(routeRow.route_hash).toBe('caller-A:target-B');
  });

});

describe('computeRiskProfile — Option B (delta success_rate)', async () => {
  let db: Pool;
  let svc: BayesianScoringService;
  let repo: EndpointDailyBucketsRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    svc = makeService(db);
    repo = new EndpointDailyBucketsRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('unknown si n_obs total < seuil (signal trop faible)', async () => {
    await repo.bump('id1', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    const result = await svc.computeRiskProfile(repo, 'id1', NOW);
    expect(result.profile).toBe('unknown');
    expect(result.totalObs).toBe(1);
  });

  it('unknown si fenêtre antérieure vide (pas de baseline)', async () => {
    // 10 obs récentes, 0 antérieure
    for (let i = 0; i < 10; i++) {
      await repo.bump('id2', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    }
    const result = await svc.computeRiskProfile(repo, 'id2', NOW);
    expect(result.profile).toBe('unknown');
    expect(result.recentSuccessRate).toBe(1.0);
    expect(result.priorSuccessRate).toBeNull();
  });

  it('low profile : stable (delta ≈ 0)', async () => {
    // 50 obs antérieures (90% success), 50 récentes (90% success) → delta=0
    for (let i = 0; i < 50; i++) {
      await repo.bump('id3', 'probe', {
        day: '2026-03-30', // il y a ~19 jours : dans [atTs-29d, atTs-7d]
        nObsDelta: 1,
        nSuccessDelta: i < 45 ? 1 : 0,
        nFailureDelta: i < 45 ? 0 : 1,
      });
      await repo.bump('id3', 'probe', {
        day: '2026-04-18',
        nObsDelta: 1,
        nSuccessDelta: i < 45 ? 1 : 0,
        nFailureDelta: i < 45 ? 0 : 1,
      });
    }
    const result = await svc.computeRiskProfile(repo, 'id3', NOW);
    expect(result.profile).toBe('low');
    expect(result.delta).toBeCloseTo(0, 6);
  });

  it('medium profile : légère dégradation (delta ∈ [-0.25, -0.10))', async () => {
    // prior : 50 obs, 95% success. recent : 50 obs, 80% success → delta = -0.15
    for (let i = 0; i < 50; i++) {
      await repo.bump('id4', 'probe', {
        day: '2026-03-30',
        nObsDelta: 1,
        nSuccessDelta: i < 47 ? 1 : 0,
        nFailureDelta: i < 47 ? 0 : 1,
      });
      await repo.bump('id4', 'probe', {
        day: '2026-04-18',
        nObsDelta: 1,
        nSuccessDelta: i < 40 ? 1 : 0,
        nFailureDelta: i < 40 ? 0 : 1,
      });
    }
    const result = await svc.computeRiskProfile(repo, 'id4', NOW);
    expect(result.profile).toBe('medium');
    expect(result.delta).toBeCloseTo(0.80 - 0.94, 2);
  });

  it('high profile : dégradation marquée (delta < -0.25)', async () => {
    // prior : 50 obs, 100% success. recent : 50 obs, 50% success → delta = -0.50
    for (let i = 0; i < 50; i++) {
      await repo.bump('id5', 'probe', {
        day: '2026-03-30',
        nObsDelta: 1,
        nSuccessDelta: 1,
        nFailureDelta: 0,
      });
      await repo.bump('id5', 'probe', {
        day: '2026-04-18',
        nObsDelta: 1,
        nSuccessDelta: i < 25 ? 1 : 0,
        nFailureDelta: i < 25 ? 0 : 1,
      });
    }
    const result = await svc.computeRiskProfile(repo, 'id5', NOW);
    expect(result.profile).toBe('high');
    expect(result.delta).toBeCloseTo(0.5 - 1.0, 2);
  });
});
