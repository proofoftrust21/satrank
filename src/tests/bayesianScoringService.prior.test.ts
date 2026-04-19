// Tests C15 : resolveHierarchicalPrior 100% streaming.
// Cascade 4 niveaux : operator → service → category → flat.
// Critère d'héritage : n_obs_effective = (α+β) - (α₀+β₀) ≥ PRIOR_MIN_EFFECTIVE_OBS (30).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
} from '../repositories/aggregatesRepository';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  PRIOR_MIN_EFFECTIVE_OBS,
} from '../config/bayesianConfig';

const NOW = 1_776_240_000;

function makeEnv() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const endpointAggRepo = new EndpointAggregateRepository(db);
  const serviceAggRepo = new ServiceAggregateRepository(db);
  const operatorAggRepo = new OperatorAggregateRepository(db);
  const nodeAggRepo = new NodeAggregateRepository(db);
  const endpointStreamRepo = new EndpointStreamingPosteriorRepository(db);
  const serviceStreamRepo = new ServiceStreamingPosteriorRepository(db);
  const operatorStreamRepo = new OperatorStreamingPosteriorRepository(db);
  const nodeStreamRepo = new NodeStreamingPosteriorRepository(db);
  const svc = new BayesianScoringService(
    endpointAggRepo,
    serviceAggRepo,
    operatorAggRepo,
    nodeAggRepo,
    undefined,
    endpointStreamRepo,
    serviceStreamRepo,
    operatorStreamRepo,
    nodeStreamRepo,
  );
  return { db, svc, endpointStreamRepo, serviceStreamRepo, operatorStreamRepo };
}

describe('resolveHierarchicalPrior — 4-level streaming cascade (C15)', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    env = makeEnv();
  });

  afterEach(() => {
    env.db.close();
    vi.useRealTimers();
  });

  it('1. flat : aucun parent connu → Beta(α₀, β₀)', () => {
    const prior = env.svc.resolveHierarchicalPrior({});
    expect(prior.source).toBe('flat');
    expect(prior.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(prior.beta).toBe(DEFAULT_PRIOR_BETA);
  });

  it('2. operator : nObsEff ≥ 30 sur operator_streaming → prior_source=operator', () => {
    // 25 succès + 10 échecs = 35 obs effectives sur une source → seuil atteint.
    env.operatorStreamRepo.ingest('op-rich', 'probe', {
      successDelta: 25,
      failureDelta: 10,
      nowSec: NOW,
    });
    const prior = env.svc.resolveHierarchicalPrior({ operatorId: 'op-rich' });
    expect(prior.source).toBe('operator');
    // Pas de décroissance (Δt = 0) → α = 1.5 + 25, β = 1.5 + 10.
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 25, 3);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 10, 3);
  });

  it('3. service : operator < 30, service ≥ 30 → prior_source=service (fallback)', () => {
    // Operator sous le seuil (5 obs) — doit cascader.
    env.operatorStreamRepo.ingest('op-thin', 'probe', {
      successDelta: 3,
      failureDelta: 2,
      nowSec: NOW,
    });
    // Service atteint le seuil avec 30 obs.
    env.serviceStreamRepo.ingest('svc-rich', 'probe', {
      successDelta: 20,
      failureDelta: 10,
      nowSec: NOW,
    });
    const prior = env.svc.resolveHierarchicalPrior({
      operatorId: 'op-thin',
      serviceHash: 'svc-rich',
    });
    expect(prior.source).toBe('service');
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 20, 3);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 10, 3);
  });

  it('4. category : operator + service < 30, somme siblings ≥ 30 → prior_source=category', () => {
    // Trois endpoints siblings, chacun avec 12 obs → total 36 > 30.
    for (const hash of ['sib-a', 'sib-b', 'sib-c']) {
      env.endpointStreamRepo.ingest(hash, 'probe', {
        successDelta: 9,
        failureDelta: 3,
        nowSec: NOW,
      });
    }
    const prior = env.svc.resolveHierarchicalPrior({
      operatorId: 'op-unknown',
      serviceHash: 'svc-unknown',
      categoryName: 'llm',
      categorySiblingHashes: ['sib-a', 'sib-b', 'sib-c'],
    });
    expect(prior.source).toBe('category');
    // Somme (α−α₀, β−β₀) = (3×9, 3×3) = (27, 9) → α = 1.5 + 27, β = 1.5 + 9.
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 27, 3);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 9, 3);
  });

  it('5. priorité operator > service > category quand tous au-dessus du seuil', () => {
    env.operatorStreamRepo.ingest('op-a', 'probe', {
      successDelta: 30,
      failureDelta: 5,
      nowSec: NOW,
    });
    env.serviceStreamRepo.ingest('svc-a', 'probe', {
      successDelta: 30,
      failureDelta: 30,
      nowSec: NOW,
    });
    env.endpointStreamRepo.ingest('sib-1', 'probe', {
      successDelta: 30,
      failureDelta: 30,
      nowSec: NOW,
    });
    const prior = env.svc.resolveHierarchicalPrior({
      operatorId: 'op-a',
      serviceHash: 'svc-a',
      categoryName: 'storage',
      categorySiblingHashes: ['sib-1'],
    });
    expect(prior.source).toBe('operator');
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 30, 3);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + 5, 3);
  });

  it('6. flat : tous les niveaux sous le seuil → Beta(α₀, β₀)', () => {
    env.operatorStreamRepo.ingest('op-small', 'probe', {
      successDelta: 5,
      failureDelta: 2,
      nowSec: NOW,
    });
    env.serviceStreamRepo.ingest('svc-small', 'probe', {
      successDelta: 4,
      failureDelta: 1,
      nowSec: NOW,
    });
    env.endpointStreamRepo.ingest('sib-small', 'probe', {
      successDelta: 3,
      failureDelta: 2,
      nowSec: NOW,
    });
    // Vérifie bien qu'on reste sous le seuil : 7 + 5 + 5 = 17 < 30.
    expect(7 + 5 + 5).toBeLessThan(PRIOR_MIN_EFFECTIVE_OBS);
    const prior = env.svc.resolveHierarchicalPrior({
      operatorId: 'op-small',
      serviceHash: 'svc-small',
      categoryName: 'misc',
      categorySiblingHashes: ['sib-small'],
    });
    expect(prior.source).toBe('flat');
    expect(prior.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(prior.beta).toBe(DEFAULT_PRIOR_BETA);
  });
});
