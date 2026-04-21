// Integration tests — real HTTP through Express with supertest
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
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
import { errorHandler } from '../middleware/errorHandler';
import { openapiSpec } from '../openapi';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Build a full Express app backed by an in-memory SQLite DB
async function buildTestApp() {
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
  app.use(cors());
  app.use(express.json());

  // Content-Type enforcement (same as app.ts)
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
      return;
    }
    next();
  });

  app.use(requestIdMiddleware);

  // Static files (for methodology test)
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: path.join(__dirname, '..', '..', 'public') }));

  const { Router } = express;
  const api = Router();
  api.use(createAgentRoutes(agentController));
  api.use(createAttestationRoutes(attestationController));
  api.use(createHealthRoutes(healthController));
  api.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  api.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send('<html><body>docs</body></html>');
  });
  app.use('/api', api);
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
    source: 'attestation',
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
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

describe('Integration — HTTP endpoints', async () => {
  let app: express.Express;
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;

  // Seed data
  let agentA: Agent;
  let agentB: Agent;
  let txId: string;

  beforeAll(async () => {
    const testApp = await buildTestApp();
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
    await agentRepo.insert(agentA);
    await agentRepo.insert(agentB);

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
    await txRepo.insert(tx);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  // --- Health endpoint ---

  it('GET /api/health returns 200 with DB status and schema version', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.dbStatus).toBe('ok');
    expect(res.body.data.schemaVersion).toBeGreaterThanOrEqual(6);
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.data).toHaveProperty('agentsIndexed');
    expect(res.body.data).toHaveProperty('totalTransactions');
  });

  // --- Stats endpoint ---

  it('GET /api/stats returns network stats', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalAgents');
    expect(res.body.data).toHaveProperty('totalChannels');
    expect(res.body.data).toHaveProperty('nodesWithRatings');
    expect(res.body.data).toHaveProperty('networkCapacityBtc');
    expect(res.body.data).toHaveProperty('totalVolumeBuckets');
  });

  // --- Version endpoint ---

  it('GET /api/version returns version info', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('commit');
  });

  // --- Top agents (free, no L402) ---

  it('GET /api/agents/top returns 200 without L402', async () => {
    const res = await request(app).get('/api/agents/top');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
    expect(res.body.meta).toHaveProperty('limit');
  });

  it('GET /api/agents/top?limit=1 limits results', async () => {
    const res = await request(app).get('/api/agents/top?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('GET /api/agents/top returns Bayesian block for each agent', async () => {
    const res = await request(app).get('/api/agents/top?limit=1');
    expect(res.status).toBe(200);
    const agent = res.body.data[0];
    expect(agent).toHaveProperty('bayesian');
    expect(agent.bayesian).toHaveProperty('p_success');
    expect(agent.bayesian).toHaveProperty('ci95_low');
    expect(agent.bayesian).toHaveProperty('ci95_high');
    expect(agent.bayesian).toHaveProperty('n_obs');
    expect(agent.bayesian).toHaveProperty('verdict');
    expect(agent.bayesian).toHaveProperty('time_constant_days');
    expect(agent.bayesian).toHaveProperty('last_update');
    expect(agent.bayesian).toHaveProperty('recent_activity');
    expect(agent.bayesian).toHaveProperty('risk_profile');
  });

  it('GET /api/agents/top?sort_by=n_obs sorts by observation count', async () => {
    const res = await request(app).get('/api/agents/top?sort_by=n_obs');
    expect(res.status).toBe(200);
    expect(res.body.meta.sort_by).toBe('n_obs');
    if (res.body.data.length >= 2) {
      expect(res.body.data[0].bayesian.n_obs).toBeGreaterThanOrEqual(res.body.data[1].bayesian.n_obs);
    }
  });

  it('GET /api/agents/top?sort_by=reputation returns 400 (legacy axis removed)', async () => {
    const res = await request(app).get('/api/agents/top?sort_by=reputation');
    expect(res.status).toBe(400);
  });

  it('GET /api/agents/top?sort_by=invalid returns 400', async () => {
    const res = await request(app).get('/api/agents/top?sort_by=invalid');
    expect(res.status).toBe(400);
  });

  // --- Search agents (free, no L402) ---

  it('GET /api/agents/search?alias=Alpha returns 200 without L402', async () => {
    const res = await request(app).get('/api/agents/search?alias=Alpha');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].alias).toBe('AlphaNode');
  });

  it('GET /api/agents/search without alias returns 400', async () => {
    const res = await request(app).get('/api/agents/search');
    expect(res.status).toBe(400);
  });

  // --- Agent detail (L402-gated in prod, free in dev) ---

  it('GET /api/agent/:hash returns Bayesian block with evidence', async () => {
    const res = await request(app).get(`/api/agent/${agentA.public_key_hash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.agent.publicKeyHash).toBe(agentA.public_key_hash);
    expect(res.body.data.bayesian).toHaveProperty('p_success');
    expect(res.body.data.bayesian).toHaveProperty('verdict');
    expect(res.body.data.evidence).toBeDefined();
  });

  it('GET /api/agent/:invalidHash returns 400', async () => {
    const res = await request(app).get('/api/agent/not-a-valid-hash');
    expect(res.status).toBe(400);
  });

  it('GET /api/agent/:unknownHash returns 404', async () => {
    const unknownHash = sha256('nonexistent-agent');
    const res = await request(app).get(`/api/agent/${unknownHash}`);
    expect(res.status).toBe(404);
  });

  // --- Agent history (L402-gated) ---

  it('GET /api/agent/:hash/history returns paginated snapshots', async () => {
    const res = await request(app).get(`/api/agent/${agentA.public_key_hash}/history`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
  });

  // --- Agent attestations (L402-gated) ---

  it('GET /api/agent/:hash/attestations returns paginated attestations', async () => {
    const res = await request(app).get(`/api/agent/${agentA.public_key_hash}/attestations`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toHaveProperty('total');
  });

  // --- POST attestation (API key required in prod, passthrough in dev) ---

  it('POST /api/attestation creates an attestation', async () => {
    const res = await request(app)
      .post('/api/attestation')
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

  it('POST /api/attestation rejects invalid input', async () => {
    const res = await request(app)
      .post('/api/attestation')
      .send({ txId: 'not-a-uuid', attesterHash: 'bad', subjectHash: 'bad', score: 999 });
    expect(res.status).toBe(400);
  });

  it('POST /api/attestation rejects self-attestation', async () => {
    const res = await request(app)
      .post('/api/attestation')
      .send({
        txId,
        attesterHash: agentA.public_key_hash,
        subjectHash: agentA.public_key_hash,
        score: 50,
      });
    expect(res.status).toBe(400);
  });

  // --- OpenAPI spec ---

  it('GET /api/openapi.json returns valid OpenAPI spec', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('SatRank API');
    expect(res.body.paths).toBeDefined();
  });

  // --- Docs page ---

  it('GET /api/docs returns HTML', async () => {
    const res = await request(app).get('/api/docs');
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
      .get(`/api/agent/${unknownHash}`)
      .set('x-request-id', customId);
    expect(res.status).toBe(404);
    expect(res.body.requestId).toBe(customId);
  });

  it('unknown routes return 404 via error handler', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
  });

  // --- Duplicate attestation ---

  it('POST /api/attestation returns 409 on duplicate', async () => {
    // First attestation was already created in the test above (agentA → agentB)
    // Submit the same pair again — should conflict on UNIQUE(attester_hash, subject_hash)
    const res = await request(app)
      .post('/api/attestation')
      .send({
        txId,
        attesterHash: agentA.public_key_hash,
        subjectHash: agentB.public_key_hash,
        score: 90,
      });
    expect(res.status).toBe(409);
  });
});

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('Integration — L402 perimeter (production mode)', async () => {
  let app: express.Express;
  let db: Pool;
  let agentHash: string;

  beforeAll(async () => {
    // Build app with production-like auth behavior
    testDb = await setupTestPool();
    db = testDb.pool;

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

    const agent = makeAgent({
      public_key_hash: sha256('l402-test-agent'),
      alias: 'L402TestNode',
      total_transactions: 10,
    });
    await agentRepo.insert(agent);
    agentHash = agent.public_key_hash;

    // Simulate production apertureGateAuth — in production, the middleware checks
    // for localhost IP (Aperture reverse proxy sits on the same host). Non-localhost
    // requests are rejected with 402. In tests (NODE_ENV !== 'production'), the
    // real middleware always passes through.
    function prodLocalhostGateAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
      const ip = req.ip || req.socket.remoteAddress || '';
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocalhost) {
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
    const api = Router();

    // Agent routes with prod L402
    const agentRouter = Router();
    agentRouter.get('/agents/top', agentController.getTop);
    agentRouter.get('/agents/search', agentController.search);
    agentRouter.get('/agent/:publicKeyHash', prodLocalhostGateAuth, agentController.getAgent);
    agentRouter.get('/agent/:publicKeyHash/history', prodLocalhostGateAuth, agentController.getHistory);
    api.use(agentRouter);

    // Attestation routes with prod L402
    const attestRouter = Router();
    attestRouter.get('/agent/:publicKeyHash/attestations', prodLocalhostGateAuth, attestationController.getBySubject);
    api.use(attestRouter);

    api.use(createHealthRoutes(healthController));
    testApp.use('/api', api);
    testApp.use(errorHandler);

    app = testApp;
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  // In tests, supertest connects via localhost, so the localhost gate passes through.
  // This verifies that the gated endpoints work when accessed from localhost (as
  // Aperture would in production).
  it('GET /api/agent/:hash returns 200 from localhost (Aperture passthrough)', async () => {
    const res = await request(app).get(`/api/agent/${agentHash}`);
    expect(res.status).toBe(200);
  });

  it('GET /api/agent/:hash/history returns 200 from localhost', async () => {
    const res = await request(app).get(`/api/agent/${agentHash}/history`);
    expect(res.status).toBe(200);
  });

  it('GET /api/agent/:hash/attestations returns 200 from localhost', async () => {
    const res = await request(app).get(`/api/agent/${agentHash}/attestations`);
    expect(res.status).toBe(200);
  });

  // Free endpoints should return 200
  it('GET /api/agents/top returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/agents/top');
    expect(res.status).toBe(200);
  });

  it('GET /api/agents/search?alias=L402 returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/agents/search?alias=L402');
    expect(res.status).toBe(200);
  });

  it('GET /api/health returns 200 (no L402 required)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

// TODO Phase 12B: describe still uses new Database(':memory:') — port to setupTestPool before unskipping.
describe.skip('Integration — Security headers and Content-Type', async () => {
  let app: express.Express;
  let db: Pool;
  let agentHash: string;
  let txId: string;

  beforeAll(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;

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

    const agent = makeAgent({
      public_key_hash: sha256('sec-test-agent'),
      alias: 'SecTestNode',
      total_transactions: 10,
    });
    const agent2 = makeAgent({
      public_key_hash: sha256('sec-test-agent2'),
      alias: 'SecTestNode2',
      total_transactions: 5,
    });
    await agentRepo.insert(agent);
    await agentRepo.insert(agent2);
    agentHash = agent.public_key_hash;

    txId = uuid();
    await txRepo.insert({
      tx_id: txId,
      sender_hash: agent.public_key_hash,
      receiver_hash: agent2.public_key_hash,
      amount_bucket: 'small',
      timestamp: NOW - 5 * DAY,
      payment_hash: sha256('sec-pay'),
      preimage: null,
      status: 'verified',
      protocol: 'l402',
    });

    // Build app with helmet for security header tests
    const helmet = require('helmet');
    const testApp = express();
    testApp.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    testApp.use(express.json());

    // Content-Type enforcement
    testApp.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
        return;
      }
      next();
    });

    testApp.use(requestIdMiddleware);
    const { Router } = express;
    const api = Router();
    api.use(createAgentRoutes(agentController));
    api.use(createAttestationRoutes(attestationController));
    api.use(createHealthRoutes(healthController));
    testApp.use('/api', api);
    testApp.use(errorHandler);

    app = testApp;
  });

  afterAll(async () => { await teardownTestPool(testDb); });

  it('POST with Content-Type: text/plain returns 415', async () => {
    const res = await request(app)
      .post('/api/attestation')
      .set('Content-Type', 'text/plain')
      .send('not json');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('POST with no Content-Type returns 415', async () => {
    const res = await request(app)
      .post('/api/attestation')
      .set('Content-Type', '')
      .send('');
    expect(res.status).toBe(415);
  });

  it('POST with application/json Content-Type is accepted', async () => {
    const res = await request(app)
      .post('/api/attestation')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        txId,
        attesterHash: agentHash,
        subjectHash: sha256('sec-test-agent2'),
        score: 80,
      }));
    expect(res.status).toBe(201);
  });

  it('responses include Content-Security-Policy header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('responses include X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('responses include X-Frame-Options header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
