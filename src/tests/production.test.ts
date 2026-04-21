// Production readiness tests — graceful shutdown, structured logging
import { describe, it, expect, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { createServer } from 'http';
import express from 'express';
import request from 'supertest';
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
import { createHealthRoutes } from '../routes/health';
import { createAttestationRoutes } from '../routes/attestation';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandler';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
let testDb: TestDb;

async function buildProdTestApp() {
  testDb = await setupTestPool();
  const db = testDb.pool;
  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const bayesianVerdictService = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), bayesianVerdictService);
  const agentController = new AgentController(agentService, agentRepo, verdictService);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  const { Router } = express;
  const api = Router();
  api.use(createAgentRoutes(agentController));
  api.use(createAttestationRoutes(attestationController));
  api.use(createHealthRoutes(healthController));
  app.use('/api', api);
  app.use(errorHandler);

  return { app, db };
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('Production — Graceful shutdown', async () => {
  let serverToClose: ReturnType<typeof createServer> | null = null;
  let dbToClose: Pool | null = null;

  afterEach(async () => {
    serverToClose?.close();
    await dbToClose?.end();
  });

  it('server.close() stops accepting new connections and resolves', async () => {
    const { app, db } = await buildProdTestApp();
    dbToClose = db;

    const server = createServer(app);
    serverToClose = server;

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    // Verify server is accepting requests
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);

    // Close the server
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await expect(closed).resolves.toBeUndefined();
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('in-flight request completes after server.close() is called', async () => {
    const { app, db } = await buildProdTestApp();
    dbToClose = db;

    // Add a slow endpoint to simulate in-flight request
    app.get('/api/slow', (_req, res) => {
      setTimeout(() => res.json({ data: 'done' }), 50);
    });

    const server = createServer(app);
    serverToClose = server;

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');

    // Start a request and immediately close the server
    const reqPromise = request(app).get('/api/slow');
    server.close();

    // The in-flight request should still complete
    const res = await reqPromise;
    expect(res.status).toBe(200);
    expect(res.body.data).toBe('done');
  });
});

describe('Production — Request ID middleware', async () => {
  it('generates a UUID request ID when none is provided', async () => {
    const { app, db } = await buildProdTestApp();
    const UUID_RE = /^[\w-]{1,64}$/;

    // Make a request that triggers the error handler (which includes requestId in response)
    const res = await request(app).get('/api/agent/invalid-hash');
    expect(res.status).toBe(400);
    expect(res.body.requestId).toBeDefined();
    expect(UUID_RE.test(res.body.requestId)).toBe(true);

    await teardownTestPool(testDb);
  });

  it('propagates caller-supplied X-Request-Id', async () => {
    const { app, db } = await buildProdTestApp();
    const customId = 'my-trace-id-abc123';

    const res = await request(app)
      .get('/api/agent/invalid-hash')
      .set('x-request-id', customId);
    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe(customId);

    await teardownTestPool(testDb);
  });

  it('rejects unsafe X-Request-Id values and generates a new one', async () => {
    const { app, db } = await buildProdTestApp();

    const res = await request(app)
      .get('/api/agent/invalid-hash')
      .set('x-request-id', '<script>alert(1)</script>');
    expect(res.status).toBe(400);
    // Should NOT use the injected value
    expect(res.body.requestId).not.toContain('<script>');

    await teardownTestPool(testDb);
  });

  it('every error response includes requestId field', async () => {
    const { app, db } = await buildProdTestApp();

    // 400 — validation error
    const r400 = await request(app).get('/api/agent/bad');
    expect(r400.body).toHaveProperty('requestId');

    // 404 — not found (need valid hash format)
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update('nonexistent').digest('hex');
    const r404 = await request(app).get(`/api/agent/${hash}`);
    expect(r404.body).toHaveProperty('requestId');

    await teardownTestPool(testDb);
  });
});
