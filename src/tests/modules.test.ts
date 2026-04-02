// Tests for versioning header, metrics, healthcheck, and migration rollback
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations, rollbackTo, getAppliedVersions } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { AttestationService } from '../services/attestationService';
import { StatsService } from '../services/statsService';
import { AgentController } from '../controllers/agentController';
import { AttestationController } from '../controllers/attestationController';
import { HealthController } from '../controllers/healthController';
import { createAgentRoutes } from '../routes/agent';
import { createAttestationRoutes } from '../routes/attestation';
import { createHealthRoutes } from '../routes/health';
import { requestIdMiddleware } from '../middleware/requestId';
import { metricsMiddleware, metricsRegistry } from '../middleware/metrics';
import { errorHandler } from '../middleware/errorHandler';
const EXPECTED_SCHEMA_VERSION = 6;

function buildTestApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);

  const agentController = new AgentController(agentService, agentRepo, snapshotRepo);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  // X-API-Version header
  app.use((_req, res, next) => {
    res.setHeader('X-API-Version', '1.0');
    next();
  });

  app.use(metricsMiddleware);

  const v1 = express.Router();
  v1.use(createAgentRoutes(agentController));
  v1.use(createAttestationRoutes(attestationController));
  v1.use(createHealthRoutes(healthController));
  app.use('/api/v1', v1);

  // Metrics endpoint
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  app.use(errorHandler);

  return { app, db, agentRepo };
}

// --- Module 3: X-API-Version header ---

describe('X-API-Version header', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeAll(() => {
    const ctx = buildTestApp();
    app = ctx.app;
    db = ctx.db;
  });
  afterAll(() => db.close());

  it('returns X-API-Version: 1.0 on health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-api-version']).toBe('1.0');
  });

  it('returns X-API-Version: 1.0 on stats', async () => {
    const res = await request(app).get('/api/v1/stats');
    expect(res.headers['x-api-version']).toBe('1.0');
  });
});

// --- Module 5: Prometheus metrics ---

describe('Prometheus /metrics endpoint', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeAll(() => {
    const ctx = buildTestApp();
    app = ctx.app;
    db = ctx.db;
  });
  afterAll(() => db.close());

  it('returns Prometheus text format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('satrank_agents_total');
    expect(res.text).toContain('satrank_requests_total');
    expect(res.text).toContain('satrank_http_request_duration_seconds');
  });
});

// --- Module 6: Healthcheck with expectedSchemaVersion ---

describe('Healthcheck with schema version', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeAll(() => {
    const ctx = buildTestApp();
    app = ctx.app;
    db = ctx.db;
  });
  afterAll(() => db.close());

  it('returns expectedSchemaVersion and schemaVersion in health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(data.expectedSchemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(data.status).toBe('ok');
    expect(data.dbStatus).toBe('ok');
  });
});

// --- Module 2: Migration rollback ---

describe('Migration rollback', () => {
  it('rolls back from v6 to v4', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    let versions = getAppliedVersions(db);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6]);

    rollbackTo(db, 4);

    versions = getAppliedVersions(db);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4]);

    // Verify v6 index is gone
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_unique_attester_subject'").all();
    expect(indexes).toHaveLength(0);

    // Verify v5 triggers are gone
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_agents_ratings_check'").all();
    expect(triggers).toHaveLength(0);

    db.close();
  });

  it('rolls back to v0 (drops all tables)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    rollbackTo(db, 0);

    const versions = getAppliedVersions(db);
    expect(versions).toHaveLength(0);

    // Core tables should be gone
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents', 'transactions', 'attestations', 'score_snapshots')").all();
    expect(tables).toHaveLength(0);

    db.close();
  });

  it('re-applies migrations after rollback', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    rollbackTo(db, 0);
    runMigrations(db);

    const versions = getAppliedVersions(db);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6]);

    db.close();
  });

  it('throws for missing rollback function', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Insert a fake version 99
    db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (99, ?, ?)').run(
      new Date().toISOString(),
      'fake',
    );

    expect(() => rollbackTo(db, 6)).toThrow('No rollback function for migration v99');

    db.close();
  });
});
