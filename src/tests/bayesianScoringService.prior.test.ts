// Tests C5 : resolveHierarchicalPrior, selectWindow, applyTemporalDecay.
// Focus : cascade prior operator → service → flat, fenêtre auto-sélection,
// décroissance exponentielle.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  MIN_N_OBS_FOR_PRIOR_INHERITANCE,
  DECAY_TAU_FRACTION,
  WINDOW_7D_SEC,
} from '../config/bayesianConfig';

const NOW = 1_776_240_000;

function makeService(): { db: Database.Database; svc: BayesianScoringService; endpointRepo: EndpointAggregateRepository; serviceRepo: ServiceAggregateRepository; operatorRepo: OperatorAggregateRepository } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const endpointRepo = new EndpointAggregateRepository(db);
  const serviceRepo = new ServiceAggregateRepository(db);
  const operatorRepo = new OperatorAggregateRepository(db);
  const nodeRepo = new NodeAggregateRepository(db);
  return {
    db,
    svc: new BayesianScoringService(endpointRepo, serviceRepo, operatorRepo, nodeRepo),
    endpointRepo,
    serviceRepo,
    operatorRepo,
  };
}

describe('resolveHierarchicalPrior', () => {
  let env: ReturnType<typeof makeService>;

  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('retombe sur flat (α₀=β₀=1.5) quand aucun parent n\'a de données', () => {
    const prior = env.svc.resolveHierarchicalPrior({ operatorId: 'unknown-op', serviceHash: 'unknown-svc' }, '7d');
    expect(prior.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(prior.beta).toBe(DEFAULT_PRIOR_BETA);
    expect(prior.source).toBe('flat');
  });

  it('retombe sur flat quand le parent est insuffisamment observé (<30)', () => {
    env.operatorRepo.upsert('op-small', '7d', { successDelta: 5, failureDelta: 2, updatedAt: NOW });
    const prior = env.svc.resolveHierarchicalPrior({ operatorId: 'op-small' }, '7d');
    expect(prior.source).toBe('flat');
  });

  it('hérite du prior operator quand il a assez d\'observations', () => {
    // 30+ observations pour atteindre MIN_N_OBS_FOR_PRIOR_INHERITANCE.
    env.operatorRepo.upsert('op-rich', '7d', {
      successDelta: 25,
      failureDelta: 10,
      updatedAt: NOW,
    });
    const prior = env.svc.resolveHierarchicalPrior({ operatorId: 'op-rich' }, '7d');
    expect(prior.source).toBe('operator');
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 25, 5);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 10, 5);
  });

  it('hérite du service quand operator absent mais service riche', () => {
    env.serviceRepo.upsert('svc-rich', '7d', {
      successDelta: 40,
      failureDelta: 20,
      updatedAt: NOW,
    });
    const prior = env.svc.resolveHierarchicalPrior({ serviceHash: 'svc-rich' }, '7d');
    expect(prior.source).toBe('service');
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 40, 5);
  });

  it('préfère operator à service quand les deux ont assez de données (priorité cascade)', () => {
    env.operatorRepo.upsert('op-a', '7d', { successDelta: 30, failureDelta: 0, updatedAt: NOW });
    env.serviceRepo.upsert('svc-a', '7d', { successDelta: 30, failureDelta: 30, updatedAt: NOW });
    const prior = env.svc.resolveHierarchicalPrior({ operatorId: 'op-a', serviceHash: 'svc-a' }, '7d');
    expect(prior.source).toBe('operator');
  });
});

describe('selectWindow', () => {
  let env: ReturnType<typeof makeService>;

  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('retourne 24h quand toutes les fenêtres ont ≥ 20 obs (plus courte)', () => {
    expect(env.svc.selectWindow({ '24h': 25, '7d': 100, '30d': 500 })).toBe('24h');
  });

  it('retourne 7d quand 24h insuffisant mais 7d ≥ 20', () => {
    expect(env.svc.selectWindow({ '24h': 5, '7d': 20, '30d': 100 })).toBe('7d');
  });

  it('retourne 30d en fallback quand aucune fenêtre n\'atteint le seuil', () => {
    expect(env.svc.selectWindow({ '24h': 0, '7d': 0, '30d': 0 })).toBe('30d');
    expect(env.svc.selectWindow({ '24h': 5, '7d': 10, '30d': 15 })).toBe('30d');
  });

  it('selectEndpointWindow interroge le repo correctement', () => {
    // 20 obs en 7d, 0 en 24h → attend '7d'.
    env.endpointRepo.upsert('url-abc', '7d', { successDelta: 15, failureDelta: 5, updatedAt: NOW });
    expect(env.svc.selectEndpointWindow('url-abc')).toBe('7d');
  });
});

describe('applyTemporalDecay', () => {
  let env: ReturnType<typeof makeService>;

  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('à t=0 retourne 1 (poids plein)', () => {
    expect(env.svc.applyTemporalDecay(0, '7d')).toBe(1);
  });

  it('à t=τ retourne e⁻¹ pour chaque fenêtre', () => {
    const tau7d = WINDOW_7D_SEC * DECAY_TAU_FRACTION;
    expect(env.svc.applyTemporalDecay(tau7d, '7d')).toBeCloseTo(Math.exp(-1), 6);
  });

  it('est monotone décroissant à mesure que l\'âge augmente (fenêtre 30d)', () => {
    const samples = [0, 86400, 7 * 86400, 15 * 86400, 30 * 86400];
    let prev = Infinity;
    for (const t of samples) {
      const w = env.svc.applyTemporalDecay(t, '30d');
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });

  it('windowTau cohérent avec la formule τ = windowSec / 3', () => {
    expect(env.svc.windowTau('24h')).toBeCloseTo(86400 / 3, 5);
    expect(env.svc.windowTau('7d')).toBeCloseTo(7 * 86400 / 3, 5);
    expect(env.svc.windowTau('30d')).toBeCloseTo(30 * 86400 / 3, 5);
  });
});

describe('aggregateToPosterior', () => {
  let env: ReturnType<typeof makeService>;

  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('retourne le prior flat pour un agrégat absent', () => {
    const p = env.svc.aggregateToPosterior(undefined);
    expect(p.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(p.beta).toBe(DEFAULT_PRIOR_BETA);
    expect(p.nObs).toBe(0);
  });

  it('lit α/β et nObs depuis l\'agrégat quand il existe', () => {
    env.endpointRepo.upsert('url-z', '24h', { successDelta: 10, failureDelta: 3, updatedAt: NOW });
    const agg = env.endpointRepo.findOne('url-z', '24h');
    const p = env.svc.aggregateToPosterior(agg);
    expect(p.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 10, 6);
    expect(p.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 3, 6);
    expect(p.nObs).toBe(13);
  });
});
