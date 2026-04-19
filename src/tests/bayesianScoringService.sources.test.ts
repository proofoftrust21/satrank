// Tests weightForSource — pondération par source/tier.
// Les anciens tests computePerSourcePosteriors/checkConvergence ont été
// supprimés en C16 : ces méthodes étaient couplées à l'ancienne chaîne
// aggregates+window et ne sont plus appelées (le verdict service calcule
// ses posteriors par source directement depuis streaming_posteriors).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
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

function makeService() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const svc = new BayesianScoringService(
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
  return { db, svc };
}

describe('weightForSource', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('probe = 1.0', () => {
    expect(env.svc.weightForSource('probe')).toBe(WEIGHT_SOVEREIGN_PROBE);
  });

  it('paid = 2.0 (le plus cher → le plus fort signal)', () => {
    expect(env.svc.weightForSource('paid')).toBe(WEIGHT_PAID_PROBE);
  });

  it('report tiers : low/medium/high/nip98 = 0.3/0.5/0.7/1.0', () => {
    expect(env.svc.weightForSource('report', 'low')).toBe(WEIGHT_REPORT_LOW);
    expect(env.svc.weightForSource('report', 'medium')).toBe(WEIGHT_REPORT_MEDIUM);
    expect(env.svc.weightForSource('report', 'high')).toBe(WEIGHT_REPORT_HIGH);
    expect(env.svc.weightForSource('report', 'nip98')).toBe(WEIGHT_REPORT_NIP98);
  });

  it('report sans tier → low (défaut le plus prudent)', () => {
    expect(env.svc.weightForSource('report')).toBe(WEIGHT_REPORT_LOW);
  });
});
