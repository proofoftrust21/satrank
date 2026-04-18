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
import { TrendService } from '../services/trendService';
import { AgentController } from '../controllers/agentController';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { AttestationController } from '../controllers/attestationController';
import { HealthController } from '../controllers/healthController';
import { createAgentRoutes } from '../routes/agent';
import { createAttestationRoutes } from '../routes/attestation';
import { createHealthRoutes } from '../routes/health';
import { requestIdMiddleware } from '../middleware/requestId';
import { metricsMiddleware, metricsRegistry } from '../middleware/metrics';
import { errorHandler } from '../middleware/errorHandler';
const EXPECTED_SCHEMA_VERSION = 32;

function buildTestApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);

  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  const agentController = new AgentController(agentService, agentRepo, snapshotRepo, trendService, verdictService);
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

  const api = express.Router();
  api.use(createAgentRoutes(agentController));
  api.use(createAttestationRoutes(attestationController));
  api.use(createHealthRoutes(healthController));
  app.use('/api', api);

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
    const res = await request(app).get('/api/health');
    expect(res.headers['x-api-version']).toBe('1.0');
  });

  it('returns X-API-Version: 1.0 on stats', async () => {
    const res = await request(app).get('/api/stats');
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
    const res = await request(app).get('/api/health');
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
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

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
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

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

  it('v7 adds ON DELETE CASCADE — deleting a transaction cascades to attestations', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Insert agent, transaction, attestation
    const hash = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    db.prepare('INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES (?, ?, ?, ?)').run(hash, 1000, 2000, 'manual');
    db.prepare('INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES (?, ?, ?, ?)').run(hash2, 1000, 2000, 'manual');
    db.prepare('INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'tx1', hash, hash2, 'small', 1000, 'ph1', 'verified', 'bolt11',
    );
    db.prepare('INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(
      'att1', 'tx1', hash, hash2, 80, 1000,
    );

    // Verify attestation exists
    const before = db.prepare('SELECT COUNT(*) as c FROM attestations WHERE tx_id = ?').get('tx1') as { c: number };
    expect(before.c).toBe(1);

    // Delete the transaction — attestation should cascade
    db.prepare('DELETE FROM transactions WHERE tx_id = ?').run('tx1');

    const after = db.prepare('SELECT COUNT(*) as c FROM attestations WHERE tx_id = ?').get('tx1') as { c: number };
    expect(after.c).toBe(0);

    db.close();
  });

  it('v7 rollback removes CASCADE', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    rollbackTo(db, 6);

    const versions = getAppliedVersions(db);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6]);

    // Attestations table should still exist with all indexes
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_subject'").all();
    expect(indexes).toHaveLength(1);

    db.close();
  });
});
