// Tests C6 : weightForSource, computePerSourcePosteriors, checkConvergence.
// Focus : pondération par source/tier, partitioning des observations en 3
// posteriors séparés, détection de la convergence multi-sources.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService, type SourceObservation } from '../services/bayesianScoringService';
import {
  WEIGHT_SOVEREIGN_PROBE,
  WEIGHT_PAID_PROBE,
  WEIGHT_REPORT_LOW,
  WEIGHT_REPORT_MEDIUM,
  WEIGHT_REPORT_HIGH,
  WEIGHT_REPORT_NIP98,
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  CONVERGENCE_P_THRESHOLD,
} from '../config/bayesianConfig';

function makeService() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const svc = new BayesianScoringService(
    new EndpointAggregateRepository(db),
    new ServiceAggregateRepository(db),
    new OperatorAggregateRepository(db),
    new NodeAggregateRepository(db),
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

describe('computePerSourcePosteriors', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  const flatPrior = { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA };

  it('partitionne les observations en 3 posteriors distincts', () => {
    const observations: SourceObservation[] = [
      { success: true, source: 'probe' },
      { success: true, source: 'probe' },
      { success: false, source: 'report', tier: 'medium' },
      { success: true, source: 'paid' },
    ];
    const result = env.svc.computePerSourcePosteriors(flatPrior, observations);
    expect(result.probe).not.toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.paid).not.toBeNull();
    // probe = 2 succès × 1.0
    expect(result.probe!.weightTotal).toBeCloseTo(2.0, 6);
    expect(result.probe!.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 2, 6);
    // paid = 1 succès × 2.0
    expect(result.paid!.weightTotal).toBeCloseTo(2.0, 6);
    expect(result.paid!.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 2, 6);
    // report = 1 échec × 0.5 (medium)
    expect(result.report!.weightTotal).toBeCloseTo(0.5, 6);
    expect(result.report!.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 0.5, 6);
  });

  it('retourne null pour une source sans aucune observation', () => {
    const observations: SourceObservation[] = [{ success: true, source: 'probe' }];
    const result = env.svc.computePerSourcePosteriors(flatPrior, observations);
    expect(result.probe).not.toBeNull();
    expect(result.report).toBeNull();
    expect(result.paid).toBeNull();
  });

  it('applique la décroissance temporelle quand ageSec + window sont fournis', () => {
    const observations: SourceObservation[] = [
      { success: true, source: 'probe', ageSec: 0, window: '7d' },
      { success: true, source: 'probe', ageSec: 7 * 86400 / 3, window: '7d' }, // age = τ → poids × e⁻¹
    ];
    const result = env.svc.computePerSourcePosteriors(flatPrior, observations);
    const expected = 1.0 + Math.exp(-1);
    expect(result.probe!.weightTotal).toBeCloseTo(expected, 5);
    expect(result.probe!.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + expected, 5);
  });

  it('paid a plus de poids qu\'un probe pour le même nombre d\'observations', () => {
    const observations: SourceObservation[] = [
      { success: true, source: 'probe' },
      { success: true, source: 'paid' },
    ];
    const result = env.svc.computePerSourcePosteriors(flatPrior, observations);
    // paid.weightTotal = 2.0, probe.weightTotal = 1.0
    expect(result.paid!.weightTotal).toBeGreaterThan(result.probe!.weightTotal);
  });

  it('un report NIP-98 vaut autant qu\'un probe', () => {
    const observations: SourceObservation[] = [
      { success: true, source: 'probe' },
      { success: true, source: 'report', tier: 'nip98' },
    ];
    const result = env.svc.computePerSourcePosteriors(flatPrior, observations);
    expect(result.probe!.weightTotal).toBe(result.report!.weightTotal);
  });

  it('utilise le prior injecté (pas forcément flat)', () => {
    const customPrior = { alpha: 10, beta: 5 };
    const observations: SourceObservation[] = [{ success: true, source: 'probe' }];
    const result = env.svc.computePerSourcePosteriors(customPrior, observations);
    expect(result.probe!.alpha).toBeCloseTo(11, 6); // 10 + 1
    expect(result.probe!.beta).toBeCloseTo(5, 6);
  });
});

describe('checkConvergence', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  const flatPrior = { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA };

  it('non-convergence si 1 seule source au-dessus du seuil', () => {
    // probe : 20 succès → p ≈ 0.95
    const observations: SourceObservation[] = Array.from({ length: 20 }, () => ({
      success: true,
      source: 'probe' as const,
    }));
    const per = env.svc.computePerSourcePosteriors(flatPrior, observations);
    const conv = env.svc.checkConvergence(per);
    expect(conv.converged).toBe(false);
    expect(conv.sourcesAboveThreshold).toEqual(['probe']);
  });

  it('convergence si 2 sources ≥ CONVERGENCE_P_THRESHOLD', () => {
    const observations: SourceObservation[] = [
      ...Array.from({ length: 20 }, () => ({ success: true, source: 'probe' as const })),
      ...Array.from({ length: 20 }, () => ({ success: true, source: 'paid' as const })),
    ];
    const per = env.svc.computePerSourcePosteriors(flatPrior, observations);
    const conv = env.svc.checkConvergence(per);
    expect(conv.converged).toBe(true);
    expect(conv.sourcesAboveThreshold.sort()).toEqual(['paid', 'probe']);
  });

  it('non-convergence si les probes disent OK mais les reports échouent', () => {
    const observations: SourceObservation[] = [
      ...Array.from({ length: 20 }, () => ({ success: true, source: 'probe' as const })),
      ...Array.from({ length: 20 }, () => ({ success: false, source: 'report' as const, tier: 'high' as const })),
    ];
    const per = env.svc.computePerSourcePosteriors(flatPrior, observations);
    const conv = env.svc.checkConvergence(per);
    expect(conv.converged).toBe(false);
  });

  it('non-convergence quand aucune source ne passe', () => {
    const observations: SourceObservation[] = [
      { success: false, source: 'probe' },
      { success: false, source: 'report', tier: 'medium' },
    ];
    const per = env.svc.computePerSourcePosteriors(flatPrior, observations);
    const conv = env.svc.checkConvergence(per);
    expect(conv.converged).toBe(false);
    expect(conv.sourcesAboveThreshold).toEqual([]);
  });

  it('expose le seuil courant dans le résultat (pour diagnostic API)', () => {
    const per = env.svc.computePerSourcePosteriors(flatPrior, []);
    const conv = env.svc.checkConvergence(per);
    expect(conv.threshold).toBe(CONVERGENCE_P_THRESHOLD);
  });
});
