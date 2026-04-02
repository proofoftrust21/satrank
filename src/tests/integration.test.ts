// Integration tests — real HTTP through Express with supertest
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
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
import { errorHandler } from '../middleware/errorHandler';
import { openapiSpec } from '../openapi';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Build a full Express app backed by an in-memory SQLite DB
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
  app.use(cors());
  app.use(express.json());
  app.use(requestIdMiddleware);

  // Static files (for methodology test)
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: path.join(__dirname, '..', '..', 'public') }));

  const { Router } = express;
  const v1 = Router();
  v1.use(createAgentRoutes(agentController));
  v1.use(createAttestationRoutes(attestationController));
  v1.use(createHealthRoutes(healthController));
  v1.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  v1.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send('<html><body>docs</body></html>');
  });
  app.use('/api/v1', v1);
  app.use(errorHandler);

  return { app, db, agentRepo, txRepo, attestationRepo };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`int-${Math.random()}`),
    public_key: null,
    alias: 'integration-test',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    query_count: 0,
    ...overrides,
  };
}

describe('Integration — HTTP endpoints', () => {
  let app: express.Express;
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;

  // Seed data
  let agentA: Agent;
  let agentB: Agent;
  let txId: string;

  beforeAll(() => {
    const testApp = buildTestApp();
    app = testApp.app;
    db = testApp.db;
    agentRepo = testApp.agentRepo;
    txRepo = testApp.txRepo;
    attestationRepo = testApp.attestationRepo;

    // Seed two agents with a transaction between them
    agentA = makeAgent({
      public_key_hash: sha256('agent-a-integration'),
      alias: 'AlphaNode',
      total_transactions: 100,
      avg_score: 65,
      positive_ratings: 10,
      lnplus_rank: 5,
    });
    agentB = makeAgent({
      public_key_hash: sha256('agent-b-integration'),
      alias: 'BetaNode',
      total_transactions: 50,
      avg_score: 40,
    });
    agentRepo.insert(agentA);
    agentRepo.insert(agentB);

    txId = uuid();
    const tx: Transaction = {
      tx_id: txId,
      sender_hash: agentA.public_key_hash,
      receiver_hash: agentB.public_key_hash,
      amount_bucket: 'medium',
      timestamp: NOW - 10 * DAY,
      payment_hash: sha256('payment-integration'),
      preimage: null,
      status: 'verified',
      protocol: 'l402',
    };
    txRepo.insert(tx);
  });

  afterAll(() => {
    db.close();
  });

  // --- Health endpoint ---

  it('GET /api/v1/health returns 200 with DB status and schema version', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.dbStatus).toBe('ok');
    expect(res.body.data.schemaVersion).toBeGreaterThanOrEqual(6);
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.data).toHaveProperty('agentsIndexed');
    expect(res.body.data).toHaveProperty('totalTransactions');
  });

  // --- Stats endpoint ---

  it('GET /api/v1/stats returns network stats', async () => {
    const res = await request(app).get('/api/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalAgents');
    expect(res.body.data).toHaveProperty('totalTransactions');
    expect(res.body.data).toHaveProperty('totalAttestations');
    expect(res.body.data).toHaveProperty('avgScore');
    expect(res.body.data).toHaveProperty('totalVolumeBuckets');
  });

  // --- Version endpoint ---

  it('GET /api/v1/version returns version info', async () => {
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('commit');
  });

  // --- Top agents (free, no L402) ---

  it('GET /api/v1/agents/top returns 200 without L402', async () => {
    const res = await request(app).get('/api/v1/agents/top');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
    expect(res.body.meta).toHaveProperty('limit');
  });

  it('GET /api/v1/agents/top?limit=1 limits results', async () => {
    const res = await request(app).get('/api/v1/agents/top?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.meta.limit).toBe(1);
  });

  // --- Search agents (free, no L402) ---

  it('GET /api/v1/agents/search?alias=Alpha returns 200 without L402', async () => {
    const res = await request(app).get('/api/v1/agents/search?alias=Alpha');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].alias).toBe('AlphaNode');
  });

  it('GET /api/v1/agents/search without alias returns 400', async () => {
    const res = await request(app).get('/api/v1/agents/search');
    expect(res.status).toBe(400);
  });

  // --- Agent detail (L402-gated in prod, free in dev) ---

  it('GET /api/v1/agent/:hash returns score with evidence', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentA.public_key_hash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.agent.publicKeyHash).toBe(agentA.public_key_hash);
    expect(res.body.data.score).toHaveProperty('total');
    expect(res.body.data.score).toHaveProperty('components');
    expect(res.body.data.evidence).toBeDefined();
  });

  it('GET /api/v1/agent/:invalidHash returns 400', async () => {
    const res = await request(app).get('/api/v1/agent/not-a-valid-hash');
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/agent/:unknownHash returns 404', async () => {
    const unknownHash = sha256('nonexistent-agent');
    const res = await request(app).get(`/api/v1/agent/${unknownHash}`);
    expect(res.status).toBe(404);
  });

  // --- Agent history (L402-gated) ---

  it('GET /api/v1/agent/:hash/history returns paginated snapshots', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentA.public_key_hash}/history`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
  });

  // --- Agent attestations (L402-gated) ---

  it('GET /api/v1/agent/:hash/attestations returns paginated attestations', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentA.public_key_hash}/attestations`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
  });

  // --- POST attestation (API key required in prod, passthrough in dev) ---

  it('POST /api/v1/attestation creates an attestation', async () => {
    const res = await request(app)
      .post('/api/v1/attestation')
      .send({
        txId,
        attesterHash: agentA.public_key_hash,
        subjectHash: agentB.public_key_hash,
        score: 85,
        tags: ['reliable', 'fast'],
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('attestationId');
    expect(res.body.data).toHaveProperty('timestamp');
  });

  it('POST /api/v1/attestation rejects invalid input', async () => {
    const res = await request(app)
      .post('/api/v1/attestation')
      .send({ txId: 'not-a-uuid', attesterHash: 'bad', subjectHash: 'bad', score: 999 });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/attestation rejects self-attestation', async () => {
    const res = await request(app)
      .post('/api/v1/attestation')
      .send({
        txId,
        attesterHash: agentA.public_key_hash,
        subjectHash: agentA.public_key_hash,
        score: 50,
      });
    expect(res.status).toBe(400);
  });

  // --- OpenAPI spec ---

  it('GET /api/v1/openapi.json returns valid OpenAPI spec', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('SatRank API');
    expect(res.body.paths).toBeDefined();
  });

  // --- Docs page ---

  it('GET /api/v1/docs returns HTML', async () => {
    const res = await request(app).get('/api/v1/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  // --- Methodology page ---

  it('GET /methodology returns HTML', async () => {
    const res = await request(app).get('/methodology');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  // --- Request ID ---

  it('error responses include the propagated request-id', async () => {
    const customId = 'test-request-id-12345';
    const unknownHash = sha256('reqid-propagation-test');
    const res = await request(app)
      .get(`/api/v1/agent/${unknownHash}`)
      .set('x-request-id', customId);
    expect(res.status).toBe(404);
    expect(res.body.requestId).toBe(customId);
  });

  it('unknown routes return 404 via error handler', async () => {
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
  });

  // --- Duplicate attestation ---

  it('POST /api/v1/attestation returns 409 on duplicate', async () => {
    // First attestation was already created in the test above (agentA → agentB)
    // Submit the same pair again — should conflict on UNIQUE(attester_hash, subject_hash)
    const res = await request(app)
      .post('/api/v1/attestation')
      .send({
        txId,
        attesterHash: agentA.public_key_hash,
        subjectHash: agentB.public_key_hash,
        score: 90,
      });
    expect(res.status).toBe(409);
  });
});

describe('Integration — L402 perimeter (production mode)', () => {
  let app: express.Express;
  let db: Database.Database;
  let agentHash: string;

  beforeAll(() => {
    // Build app with production-like auth behavior
    const memDb = new Database(':memory:');
    memDb.pragma('foreign_keys = ON');
    runMigrations(memDb);
    db = memDb;

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

    const agent = makeAgent({
      public_key_hash: sha256('l402-test-agent'),
      alias: 'L402TestNode',
      total_transactions: 10,
    });
    agentRepo.insert(agent);
    agentHash = agent.public_key_hash;

    // Simulate production L402 middleware that always enforces payment
    function prodApertureGateAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
      const header = req.headers['x-aperture-auth'] as string | undefined;
      if (!header) {
        const err = new Error('Payment required');
        (err as unknown as { statusCode: number; code: string }).statusCode = 402;
        (err as unknown as { statusCode: number; code: string }).code = 'PAYMENT_REQUIRED';
        _res.status(402).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Payment required' } });
        return;
      }
      next();
    }

    // Build routes with production auth
    const testApp = express();
    testApp.use(express.json());
    testApp.use(requestIdMiddleware);

    const { Router } = express;
    const v1 = Router();

    // Agent routes with prod L402
    const agentRouter = Router();
    agentRouter.get('/agents/top', agentController.getTop);
    agentRouter.get('/agents/search', agentController.search);
    agentRouter.get('/agent/:publicKeyHash', prodApertureGateAuth, agentController.getAgent);
    agentRouter.get('/agent/:publicKeyHash/history', prodApertureGateAuth, agentController.getHistory);
    v1.use(agentRouter);

    // Attestation routes with prod L402
    const attestRouter = Router();
    attestRouter.get('/agent/:publicKeyHash/attestations', prodApertureGateAuth, attestationController.getBySubject);
    v1.use(attestRouter);

    v1.use(createHealthRoutes(healthController));
    testApp.use('/api/v1', v1);
    testApp.use(errorHandler);

    app = testApp;
  });

  afterAll(() => {
    db.close();
  });

  // L402-gated endpoints should return 402 without X-Aperture-Auth
  it('GET /api/v1/agent/:hash returns 402 without L402 header', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}`);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('GET /api/v1/agent/:hash/history returns 402 without L402 header', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}/history`);
    expect(res.status).toBe(402);
  });

  it('GET /api/v1/agent/:hash/attestations returns 402 without L402 header', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}/attestations`);
    expect(res.status).toBe(402);
  });

  // Free endpoints should return 200
  it('GET /api/v1/agents/top returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/v1/agents/top');
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/agents/search?alias=L402 returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/v1/agents/search?alias=L402');
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/health returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  // L402-gated endpoints should pass with X-Aperture-Auth header
  it('GET /api/v1/agent/:hash returns 200 with L402 header', async () => {
    const res = await request(app)
      .get(`/api/v1/agent/${agentHash}`)
      .set('X-Aperture-Auth', 'valid-token');
    expect(res.status).toBe(200);
  });
});
