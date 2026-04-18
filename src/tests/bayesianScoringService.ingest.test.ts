// Tests C8 : ingestTransactionOutcome — Option A (compteurs raw incrémentaux
// par fenêtre, décroissance appliquée au read seulement).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
  AGGREGATE_DEFAULT_PRIOR,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BAYESIAN_WINDOWS } from '../config/bayesianConfig';

const NOW = 1_776_240_000;

function makeService() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const endpointRepo = new EndpointAggregateRepository(db);
  const serviceRepo = new ServiceAggregateRepository(db);
  const operatorRepo = new OperatorAggregateRepository(db);
  const nodeRepo = new NodeAggregateRepository(db);
  const routeRepo = new RouteAggregateRepository(db);
  const svc = new BayesianScoringService(endpointRepo, serviceRepo, operatorRepo, nodeRepo, routeRepo);
  return { db, svc, endpointRepo, serviceRepo, operatorRepo, routeRepo };
}

describe('ingestTransactionOutcome', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  it('incrémente les 3 fenêtres pour un endpoint quand endpointHash fourni', () => {
    const result = env.svc.ingestTransactionOutcome({
      success: true,
      timestamp: NOW,
      endpointHash: 'url-1',
    });
    expect(result.endpointUpdates).toBe(3);
    for (const w of BAYESIAN_WINDOWS) {
      const row = env.endpointRepo.findOne('url-1', w);
      expect(row).toBeDefined();
      expect(row!.nSuccess).toBe(1);
      expect(row!.nFailure).toBe(0);
    }
  });

  it('ignore les niveaux dont la clé est absente (pas d\'update fantôme)', () => {
    const result = env.svc.ingestTransactionOutcome({
      success: true,
      timestamp: NOW,
      endpointHash: 'url-only',
      // Pas de serviceHash, operatorId, caller/target
    });
    expect(result.endpointUpdates).toBe(3);
    expect(result.serviceUpdates).toBe(0);
    expect(result.operatorUpdates).toBe(0);
    expect(result.routeUpdates).toBe(0);
    expect(env.endpointRepo.findOne('url-only', '24h')).toBeDefined();
    expect(env.serviceRepo.findOne('url-only', '24h')).toBeUndefined();
    expect(env.operatorRepo.findOne('url-only', '24h')).toBeUndefined();
  });

  it('met à jour endpoint, service, operator et route ensemble quand tous les champs sont fournis', () => {
    const result = env.svc.ingestTransactionOutcome({
      success: true,
      timestamp: NOW,
      endpointHash: 'url-A',
      serviceHash: 'svc-A',
      operatorId: 'op-A',
      callerHash: 'caller-X',
      targetHash: 'target-Y',
    });
    expect(result.endpointUpdates).toBe(3);
    expect(result.serviceUpdates).toBe(3);
    expect(result.operatorUpdates).toBe(3);
    expect(result.routeUpdates).toBe(3);
    expect(env.endpointRepo.findOne('url-A', '7d')!.nSuccess).toBe(1);
    expect(env.serviceRepo.findOne('svc-A', '7d')!.nSuccess).toBe(1);
    expect(env.operatorRepo.findOne('op-A', '7d')!.nSuccess).toBe(1);
    const route = env.routeRepo.findOne('caller-X:target-Y', '7d')!;
    expect(route.nSuccess).toBe(1);
    expect(route.callerHash).toBe('caller-X');
    expect(route.targetHash).toBe('target-Y');
  });

  it('accumule plusieurs transactions sur le même endpoint (compteurs non-décroissants)', () => {
    for (let i = 0; i < 10; i++) {
      env.svc.ingestTransactionOutcome({
        success: i < 7, // 7 succès, 3 échecs
        timestamp: NOW + i,
        endpointHash: 'url-loop',
      });
    }
    const row = env.endpointRepo.findOne('url-loop', '24h')!;
    expect(row.nSuccess).toBe(7);
    expect(row.nFailure).toBe(3);
    expect(row.nObs).toBe(10);
    expect(row.posteriorAlpha).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.alpha + 7, 6);
    expect(row.posteriorBeta).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.beta + 3, 6);
  });

  it('échec → incrémente nFailure, pas nSuccess', () => {
    env.svc.ingestTransactionOutcome({
      success: false,
      timestamp: NOW,
      endpointHash: 'url-fail',
      operatorId: 'op-fail',
    });
    expect(env.endpointRepo.findOne('url-fail', '30d')!.nFailure).toBe(1);
    expect(env.endpointRepo.findOne('url-fail', '30d')!.nSuccess).toBe(0);
    expect(env.operatorRepo.findOne('op-fail', '30d')!.nFailure).toBe(1);
  });

  it('route non mise à jour si RouteAggregateRepository absent (optional DI)', () => {
    // Service construit sans routeRepo
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const svc = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      // routeRepo omis
    );
    const result = svc.ingestTransactionOutcome({
      success: true,
      timestamp: NOW,
      endpointHash: 'url-no-route',
      callerHash: 'c',
      targetHash: 't',
    });
    expect(result.routeUpdates).toBe(0);
    expect(result.endpointUpdates).toBe(3);
    db.close();
  });

  it('updatedAt propagé vers chaque agrégat', () => {
    const t = NOW + 12345;
    env.svc.ingestTransactionOutcome({
      success: true,
      timestamp: t,
      endpointHash: 'url-t',
      operatorId: 'op-t',
    });
    expect(env.endpointRepo.findOne('url-t', '24h')!.updatedAt).toBe(t);
    expect(env.operatorRepo.findOne('op-t', '24h')!.updatedAt).toBe(t);
  });

  it('idempotence d\'architecture : N transactions → N deltas (Option A pure)', () => {
    // L'ingestion ne déduplique pas ; c'est au write-path applicatif de le faire.
    // Ici on vérifie que 3 ingestions du même outcome produisent bien 3 incréments.
    const outcome = { success: true, timestamp: NOW, endpointHash: 'url-dup' };
    env.svc.ingestTransactionOutcome(outcome);
    env.svc.ingestTransactionOutcome(outcome);
    env.svc.ingestTransactionOutcome(outcome);
    expect(env.endpointRepo.findOne('url-dup', '24h')!.nSuccess).toBe(3);
  });
});
