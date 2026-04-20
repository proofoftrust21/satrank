// Phase 7 — tests d'intégration pour GET /api/operators (liste paginée).
//
// Couverture :
//   - liste vide → data=[], total=0
//   - pagination (limit, offset)
//   - filtre status=verified/pending/rejected
//   - tri par last_activity DESC (default)
//   - meta.counts expose les 3 status
//   - 400 sur params invalides
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations } from '../database/migrations';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { OperatorController } from '../controllers/operatorController';
import { errorHandler } from '../middleware/errorHandler';

interface Ctx {
  db: Database.Database;
  app: express.Express;
  service: OperatorService;
  operators: OperatorRepository;
}

function setup(): Ctx {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const operators = new OperatorRepository(db);
  const identities = new OperatorIdentityRepository(db);
  const ownerships = new OperatorOwnershipRepository(db);
  const endpointPosteriors = new EndpointStreamingPosteriorRepository(db);
  const nodePosteriors = new NodeStreamingPosteriorRepository(db);
  const servicePosteriors = new ServiceStreamingPosteriorRepository(db);

  const service = new OperatorService(
    operators,
    identities,
    ownerships,
    endpointPosteriors,
    nodePosteriors,
    servicePosteriors,
  );
  const controller = new OperatorController({
    operatorService: service,
    operatorRepo: operators,
  });

  const app = express();
  app.use(express.json());
  app.get('/api/operators', controller.list);
  app.use(errorHandler);

  return { db, app, service, operators };
}

describe('GET /api/operators — liste vide', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('renvoie data=[] et total=0', async () => {
    const res = await request(ctx.app).get('/api/operators');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    expect(res.body.meta.counts).toEqual({ verified: 0, pending: 0, rejected: 0 });
  });
});

describe('GET /api/operators — pagination', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('trie par last_activity DESC par défaut', async () => {
    ctx.service.upsertOperator('op-old', 1000);
    ctx.service.upsertOperator('op-new', 3000);
    ctx.service.upsertOperator('op-mid', 2000);

    const res = await request(ctx.app).get('/api/operators');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { operator_id: string }) => r.operator_id)).toEqual([
      'op-new', 'op-mid', 'op-old',
    ]);
  });

  it('pagine avec limit+offset', async () => {
    for (let i = 0; i < 25; i++) {
      ctx.service.upsertOperator(`op-${String(i).padStart(3, '0')}`, 1000 + i);
    }
    const p1 = await request(ctx.app).get('/api/operators?limit=10&offset=0');
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.meta.total).toBe(25);
    expect(p1.body.meta.limit).toBe(10);
    expect(p1.body.meta.offset).toBe(0);

    const p3 = await request(ctx.app).get('/api/operators?limit=10&offset=20');
    expect(p3.body.data).toHaveLength(5);
    expect(p3.body.meta.offset).toBe(20);
  });

  it('limit default=20, offset default=0', async () => {
    for (let i = 0; i < 30; i++) {
      ctx.service.upsertOperator(`op-${i}`, 1000 + i);
    }
    const res = await request(ctx.app).get('/api/operators');
    expect(res.body.data).toHaveLength(20);
    expect(res.body.meta.limit).toBe(20);
    expect(res.body.meta.offset).toBe(0);
  });
});

describe('GET /api/operators — filtre status', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('filtre status=verified', async () => {
    ctx.service.upsertOperator('op-v1', 1000);
    ctx.service.upsertOperator('op-v2', 2000);
    ctx.service.upsertOperator('op-p1', 3000);
    ctx.operators.updateVerification('op-v1', 2, 'verified');
    ctx.operators.updateVerification('op-v2', 2, 'verified');

    const res = await request(ctx.app).get('/api/operators?status=verified');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r: { status: string }) => r.status === 'verified')).toBe(true);
    expect(res.body.meta.total).toBe(2);
    // counts meta reste global (tous les status, pas filtré)
    expect(res.body.meta.counts.verified).toBe(2);
    expect(res.body.meta.counts.pending).toBe(1);
  });

  it('filtre status=pending', async () => {
    ctx.service.upsertOperator('op-p1', 1000);
    ctx.service.upsertOperator('op-p2', 2000);
    ctx.service.upsertOperator('op-v1', 3000);
    ctx.operators.updateVerification('op-v1', 2, 'verified');

    const res = await request(ctx.app).get('/api/operators?status=pending');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r: { status: string }) => r.status === 'pending')).toBe(true);
  });

  it('filtre status=rejected', async () => {
    ctx.service.upsertOperator('op-r1', 1000);
    ctx.operators.updateVerification('op-r1', 0, 'rejected');

    const res = await request(ctx.app).get('/api/operators?status=rejected');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('rejected');
  });
});

describe('GET /api/operators — validation', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('400 sur status inconnu', async () => {
    const res = await request(ctx.app).get('/api/operators?status=zombie');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 sur limit > 100', async () => {
    const res = await request(ctx.app).get('/api/operators?limit=500');
    expect(res.status).toBe(400);
  });

  it('400 sur offset négatif', async () => {
    const res = await request(ctx.app).get('/api/operators?offset=-10');
    expect(res.status).toBe(400);
  });

  it('400 sur limit=0', async () => {
    const res = await request(ctx.app).get('/api/operators?limit=0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/operators — fields', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('expose operator_id, status, verification_score, timestamps', async () => {
    ctx.service.upsertOperator('op-fields', 1000);
    ctx.operators.updateVerification('op-fields', 2, 'verified');

    const res = await request(ctx.app).get('/api/operators');
    const row = res.body.data[0];
    expect(row.operator_id).toBe('op-fields');
    expect(row.status).toBe('verified');
    expect(row.verification_score).toBe(2);
    expect(row.first_seen).toBe(1000);
    expect(row.last_activity).toBe(1000);
    expect(typeof row.created_at).toBe('number');
  });
});
