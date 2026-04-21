// Tests weightForSource — pondération par source/tier.
// Les anciens tests computePerSourcePosteriors/checkConvergence ont été
// supprimés en C16 : ces méthodes étaient couplées à l'ancienne chaîne
// aggregates+window et ne sont plus appelées (le verdict service calcule
// ses posteriors par source directement depuis streaming_posteriors).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
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
import {
  WEIGHT_SOVEREIGN_PROBE,
  WEIGHT_PAID_PROBE,
  WEIGHT_REPORT_LOW,
  WEIGHT_REPORT_MEDIUM,
  WEIGHT_REPORT_HIGH,
  WEIGHT_REPORT_NIP98,
} from '../config/bayesianConfig';
let testDb: TestDb;

describe('weightForSource', async () => {
  let pool: Pool;
  let svc: BayesianScoringService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    svc = new BayesianScoringService(
      new EndpointStreamingPosteriorRepository(pool),
      new ServiceStreamingPosteriorRepository(pool),
      new OperatorStreamingPosteriorRepository(pool),
      new NodeStreamingPosteriorRepository(pool),
      new RouteStreamingPosteriorRepository(pool),
      new EndpointDailyBucketsRepository(pool),
      new ServiceDailyBucketsRepository(pool),
      new OperatorDailyBucketsRepository(pool),
      new NodeDailyBucketsRepository(pool),
      new RouteDailyBucketsRepository(pool),
    );
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  it('probe = 1.0', () => {
    expect(svc.weightForSource('probe')).toBe(WEIGHT_SOVEREIGN_PROBE);
  });

  it('paid = 2.0 (le plus cher → le plus fort signal)', () => {
    expect(svc.weightForSource('paid')).toBe(WEIGHT_PAID_PROBE);
  });

  it('report tiers : low/medium/high/nip98 = 0.3/0.5/0.7/1.0', () => {
    expect(svc.weightForSource('report', 'low')).toBe(WEIGHT_REPORT_LOW);
    expect(svc.weightForSource('report', 'medium')).toBe(WEIGHT_REPORT_MEDIUM);
    expect(svc.weightForSource('report', 'high')).toBe(WEIGHT_REPORT_HIGH);
    expect(svc.weightForSource('report', 'nip98')).toBe(WEIGHT_REPORT_NIP98);
  });

  it('report sans tier → low (défaut le plus prudent)', () => {
    expect(svc.weightForSource('report')).toBe(WEIGHT_REPORT_LOW);
  });
});
