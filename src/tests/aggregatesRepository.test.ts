// Tests pour les 5 aggregates repositories.
// Valide upsert (insert-path + update-path), isolation par fenêtre,
// batch findByIds, pruneStale, et le cas spécifique route/node.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  RouteAggregateRepository,
  NodeAggregateRepository,
  AGGREGATE_DEFAULT_PRIOR,
} from '../repositories/aggregatesRepository';

const NOW = 1_776_240_000;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('EndpointAggregateRepository', () => {
  let db: Database.Database;
  let repo: EndpointAggregateRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new EndpointAggregateRepository(db);
  });

  afterEach(() => { db.close(); });

  it('upsert crée la ligne avec prior flat puis applique les deltas (insert-path)', () => {
    repo.upsert('url-1', '24h', { successDelta: 3, failureDelta: 1, updatedAt: NOW });
    const row = repo.findOne('url-1', '24h');
    expect(row).toBeDefined();
    expect(row!.nSuccess).toBe(3);
    expect(row!.nFailure).toBe(1);
    expect(row!.nObs).toBe(4);
    expect(row!.posteriorAlpha).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.alpha + 3, 6);
    expect(row!.posteriorBeta).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.beta + 1, 6);
  });

  it('upsert accumule sur une ligne existante (update-path)', () => {
    repo.upsert('url-2', '7d', { successDelta: 2, failureDelta: 0, updatedAt: NOW });
    repo.upsert('url-2', '7d', { successDelta: 5, failureDelta: 2, updatedAt: NOW + 10 });
    const row = repo.findOne('url-2', '7d');
    expect(row!.nSuccess).toBe(7);
    expect(row!.nFailure).toBe(2);
    expect(row!.posteriorAlpha).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.alpha + 7, 6);
    expect(row!.posteriorBeta).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.beta + 2, 6);
    expect(row!.updatedAt).toBe(NOW + 10);
  });

  it('isolation des fenêtres : même url sur 3 windows ne se mélange pas', () => {
    repo.upsert('url-3', '24h', { successDelta: 10, failureDelta: 0, updatedAt: NOW });
    repo.upsert('url-3', '7d', { successDelta: 50, failureDelta: 0, updatedAt: NOW });
    repo.upsert('url-3', '30d', { successDelta: 200, failureDelta: 0, updatedAt: NOW });
    expect(repo.findOne('url-3', '24h')!.nSuccess).toBe(10);
    expect(repo.findOne('url-3', '7d')!.nSuccess).toBe(50);
    expect(repo.findOne('url-3', '30d')!.nSuccess).toBe(200);
  });

  it('findByIds retourne les lignes d\'une fenêtre pour un lot', () => {
    for (const id of ['a', 'b', 'c']) {
      repo.upsert(id, '24h', { successDelta: 1, failureDelta: 0, updatedAt: NOW });
    }
    const rows = repo.findByIds(['a', 'b'], '24h');
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('findAll(window) filtre correctement par fenêtre', () => {
    repo.upsert('x', '24h', { successDelta: 1, failureDelta: 0, updatedAt: NOW });
    repo.upsert('y', '7d', { successDelta: 1, failureDelta: 0, updatedAt: NOW });
    expect(repo.findAll('24h').length).toBe(1);
    expect(repo.findAll('7d').length).toBe(1);
  });

  it('updateMedians met à jour latence / prix sans toucher aux compteurs', () => {
    repo.upsert('url-m', '7d', { successDelta: 5, failureDelta: 0, updatedAt: NOW });
    repo.updateMedians('url-m', '7d', 120, 1000, NOW + 30);
    const row = repo.findOne('url-m', '7d')!;
    expect(row.medianLatencyMs).toBe(120);
    expect(row.medianPriceMsat).toBe(1000);
    expect(row.nSuccess).toBe(5); // inchangé
  });

  it('pruneStale supprime les lignes antérieures au cutoff', () => {
    repo.upsert('stale', '24h', { successDelta: 1, failureDelta: 0, updatedAt: NOW - 86400 });
    repo.upsert('fresh', '24h', { successDelta: 1, failureDelta: 0, updatedAt: NOW });
    const purged = repo.pruneStale(NOW - 3600);
    expect(purged).toBe(1);
    expect(repo.findOne('stale', '24h')).toBeUndefined();
    expect(repo.findOne('fresh', '24h')).toBeDefined();
  });
});

describe('ServiceAggregateRepository', () => {
  let db: Database.Database;
  let repo: ServiceAggregateRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new ServiceAggregateRepository(db);
  });

  afterEach(() => { db.close(); });

  it('upsert + findOne sur service_hash', () => {
    repo.upsert('svc-1', '7d', { successDelta: 4, failureDelta: 1, updatedAt: NOW });
    const row = repo.findOne('svc-1', '7d');
    expect(row!.id).toBe('svc-1');
    expect(row!.nSuccess).toBe(4);
  });
});

describe('OperatorAggregateRepository', () => {
  let db: Database.Database;
  let repo: OperatorAggregateRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new OperatorAggregateRepository(db);
  });

  afterEach(() => { db.close(); });

  it('upsert + findOne sur operator_id', () => {
    repo.upsert('op-1', '30d', { successDelta: 10, failureDelta: 2, updatedAt: NOW });
    const row = repo.findOne('op-1', '30d');
    expect(row!.id).toBe('op-1');
    expect(row!.nObs).toBe(12);
  });
});

describe('RouteAggregateRepository', () => {
  let db: Database.Database;
  let repo: RouteAggregateRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new RouteAggregateRepository(db);
  });

  afterEach(() => { db.close(); });

  it('upsertRoute stocke caller_hash et target_hash à la création', () => {
    repo.upsertRoute('route-1', 'caller-a', 'target-b', '24h', {
      successDelta: 2,
      failureDelta: 0,
      updatedAt: NOW,
    });
    const row = repo.findOne('route-1', '24h')!;
    expect(row.callerHash).toBe('caller-a');
    expect(row.targetHash).toBe('target-b');
    expect(row.nSuccess).toBe(2);
  });

  it('upsertRoute incrémente sans écraser caller/target sur update-path', () => {
    repo.upsertRoute('route-2', 'caller-a', 'target-b', '24h', { successDelta: 1, failureDelta: 0, updatedAt: NOW });
    repo.upsertRoute('route-2', 'caller-a', 'target-b', '24h', { successDelta: 3, failureDelta: 1, updatedAt: NOW + 10 });
    const row = repo.findOne('route-2', '24h')!;
    expect(row.nSuccess).toBe(4);
    expect(row.nFailure).toBe(1);
    expect(row.callerHash).toBe('caller-a');
  });
});

describe('NodeAggregateRepository', () => {
  let db: Database.Database;
  let repo: NodeAggregateRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new NodeAggregateRepository(db);
  });

  afterEach(() => { db.close(); });

  it('upsert crée un posterior routing + delivery séparés', () => {
    repo.upsert('pubkey-xyz', '7d', {
      routableDelta: 5,
      deliveredDelta: 4,
      reportedSuccessDelta: 3,
      reportedFailureDelta: 1,
      updatedAt: NOW,
    });
    const row = repo.findOne('pubkey-xyz', '7d')!;
    expect(row.nRoutable).toBe(5);
    expect(row.nDelivered).toBe(4);
    expect(row.nReportedSuccess).toBe(3);
    expect(row.nReportedFailure).toBe(1);
    expect(row.routingAlpha).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.alpha + 5, 6);
    expect(row.deliveryAlpha).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.alpha + 4 + 3, 6);
    expect(row.deliveryBeta).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.beta + 1, 6);
  });

  it('upsertRoutingFailure incrémente routing_beta et n_observations', () => {
    repo.upsertRoutingFailure('pubkey-fail', '24h', NOW);
    const row = repo.findOne('pubkey-fail', '24h')!;
    expect(row.routingBeta).toBeCloseTo(AGGREGATE_DEFAULT_PRIOR.beta + 1, 6);
    expect(row.nObservations).toBe(1);
  });

  it('isolation des fenêtres pour un même pubkey', () => {
    repo.upsert('pk-iso', '24h', { routableDelta: 1, deliveredDelta: 0, reportedSuccessDelta: 0, reportedFailureDelta: 0, updatedAt: NOW });
    repo.upsert('pk-iso', '30d', { routableDelta: 99, deliveredDelta: 0, reportedSuccessDelta: 0, reportedFailureDelta: 0, updatedAt: NOW });
    expect(repo.findOne('pk-iso', '24h')!.nRoutable).toBe(1);
    expect(repo.findOne('pk-iso', '30d')!.nRoutable).toBe(99);
  });
});
