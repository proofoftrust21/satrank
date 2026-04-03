// Contract tests — verify HTTP responses match OpenAPI spec
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
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
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Reusable app builder for contract tests
function buildContractApp() {
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

  const { Router } = express;
  const v1 = Router();
  v1.use(createAgentRoutes(agentController));
  v1.use(createAttestationRoutes(attestationController));
  v1.use(createHealthRoutes(healthController));
  v1.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  app.use('/api/v1', v1);
  app.use(errorHandler);

  return { app, db, agentRepo, txRepo };
}

// Helper: assert an object has all listed keys and each value matches expected JS type
function assertShape(obj: Record<string, unknown>, fields: Record<string, string>) {
  for (const [key, expectedType] of Object.entries(fields)) {
    expect(obj).toHaveProperty(key);
    if (expectedType === 'array') {
      expect(Array.isArray(obj[key])).toBe(true);
    } else if (expectedType === 'nullable-string') {
      expect(obj[key] === null || typeof obj[key] === 'string').toBe(true);
    } else {
      expect(typeof obj[key]).toBe(expectedType);
    }
  }
}

describe('Contract tests — responses match OpenAPI spec', () => {
  let app: express.Express;
  let db: Database.Database;
  let agentHash: string;

  beforeAll(() => {
    const testApp = buildContractApp();
    app = testApp.app;
    db = testApp.db;

    const agent: Agent = {
      public_key_hash: sha256('contract-test-agent'),
      public_key: 'pk-contract',
      alias: 'ContractNode',
      first_seen: NOW - 90 * DAY,
      last_seen: NOW - DAY,
      source: 'lightning_graph',
      total_transactions: 100,
      total_attestations_received: 0,
      avg_score: 60,
      capacity_sats: 1_000_000_000,
      positive_ratings: 8,
      negative_ratings: 1,
      lnplus_rank: 5,
      hubness_rank: 10,
      betweenness_rank: 20,
      hopness_rank: 5,
      query_count: 10,
    };
    const agent2: Agent = {
      public_key_hash: sha256('contract-test-agent2'),
      public_key: null,
      alias: 'ContractNode2',
      first_seen: NOW - 30 * DAY,
      last_seen: NOW - 2 * DAY,
      source: 'observer_protocol',
      total_transactions: 20,
      total_attestations_received: 0,
      avg_score: 30,
      capacity_sats: null,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      query_count: 0,
    };
    testApp.agentRepo.insert(agent);
    testApp.agentRepo.insert(agent2);
    agentHash = agent.public_key_hash;

    const tx: Transaction = {
      tx_id: uuid(),
      sender_hash: agent.public_key_hash,
      receiver_hash: agent2.public_key_hash,
      amount_bucket: 'small',
      timestamp: NOW - 5 * DAY,
      payment_hash: sha256('contract-pay'),
      preimage: null,
      status: 'verified',
      protocol: 'bolt11',
    };
    testApp.txRepo.insert(tx);
  });

  afterAll(() => { db.close(); });

  // --- OpenAPI spec served correctly ---

  it('GET /api/v1/openapi.json returns the spec with correct version', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('SatRank API');
    expect(res.body.paths).toBeDefined();
    expect(res.body.components).toBeDefined();
  });

  // --- AgentScoreResponse matches schema ---

  it('GET /agent/{hash} response matches AgentScoreResponse schema', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}`);
    expect(res.status).toBe(200);
    const data = res.body.data;

    // agent section
    assertShape(data.agent, {
      publicKeyHash: 'string',
      alias: 'nullable-string',
      firstSeen: 'number',
      lastSeen: 'number',
      source: 'string',
    });
    expect(['observer_protocol', '4tress', 'lightning_graph', 'manual']).toContain(data.agent.source);

    // score section
    assertShape(data.score, {
      total: 'number',
      components: 'object',
      confidence: 'string',
      computedAt: 'number',
    });
    expect(data.score.total).toBeGreaterThanOrEqual(0);
    expect(data.score.total).toBeLessThanOrEqual(100);
    expect(['very_low', 'low', 'medium', 'high', 'very_high']).toContain(data.score.confidence);

    // components
    assertShape(data.score.components, {
      volume: 'number',
      reputation: 'number',
      seniority: 'number',
      regularity: 'number',
      diversity: 'number',
    });

    // stats
    assertShape(data.stats, {
      totalTransactions: 'number',
      verifiedTransactions: 'number',
      uniqueCounterparties: 'number',
      attestationsReceived: 'number',
      avgAttestationScore: 'number',
    });

    // evidence
    expect(data.evidence).toBeDefined();
    expect(data.evidence.transactions).toBeDefined();
    expect(typeof data.evidence.transactions.count).toBe('number');
    expect(Array.isArray(data.evidence.transactions.sample)).toBe(true);
    expect(data.evidence.popularity).toBeDefined();
    expect(typeof data.evidence.popularity.queryCount).toBe('number');
  });

  // --- Top agents matches AgentSummary schema ---

  it('GET /agents/top response matches AgentSummary[] schema', async () => {
    const res = await request(app).get('/api/v1/agents/top');
    expect(res.status).toBe(200);

    // meta
    assertShape(res.body.meta, { total: 'number', limit: 'number', offset: 'number' });

    // data array
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      assertShape(item, {
        publicKeyHash: 'string',
        alias: 'nullable-string',
        score: 'number',
        totalTransactions: 'number',
        source: 'string',
      });
    }
  });

  // --- Search matches AgentSearchResult schema ---

  it('GET /agents/search response matches AgentSearchResult[] schema', async () => {
    const res = await request(app).get('/api/v1/agents/search?alias=Contract');
    expect(res.status).toBe(200);

    assertShape(res.body.meta, { total: 'number', limit: 'number', offset: 'number' });
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const item of res.body.data) {
      assertShape(item, {
        publicKeyHash: 'string',
        alias: 'nullable-string',
        score: 'number',
        source: 'string',
      });
    }
  });

  // --- Health matches HealthResponse schema ---

  it('GET /health response matches HealthResponse schema', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    assertShape(res.body.data, {
      status: 'string',
      agentsIndexed: 'number',
      totalTransactions: 'number',
      lastUpdate: 'number',
      uptime: 'number',
    });
    expect(['ok', 'error']).toContain(res.body.data.status);
  });

  // --- Stats matches NetworkStats schema ---

  it('GET /stats response matches NetworkStats schema', async () => {
    const res = await request(app).get('/api/v1/stats');
    expect(res.status).toBe(200);
    assertShape(res.body.data, {
      totalAgents: 'number',
      totalTransactions: 'number',
      totalAttestations: 'number',
      avgScore: 'number',
      totalVolumeBuckets: 'object',
    });
    assertShape(res.body.data.totalVolumeBuckets, {
      micro: 'number',
      small: 'number',
      medium: 'number',
      large: 'number',
    });
  });

  // --- Version matches VersionResponse schema ---

  it('GET /version response matches VersionResponse schema', async () => {
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    assertShape(res.body.data, {
      commit: 'string',
      buildDate: 'string',
      version: 'string',
    });
  });

  // --- History matches ScoreSnapshot[] schema ---

  it('GET /agent/{hash}/history response matches ScoreSnapshot[] schema', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}/history`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    assertShape(res.body.meta, { total: 'number', limit: 'number', offset: 'number' });
    // snapshots may be empty but shape is correct
  });

  // --- Attestations matches Attestation[] schema ---

  it('GET /agent/{hash}/attestations response matches Attestation[] schema', async () => {
    const res = await request(app).get(`/api/v1/agent/${agentHash}/attestations`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    assertShape(res.body.meta, { total: 'number', limit: 'number', offset: 'number' });
  });

  // --- Error responses match ErrorResponse schema ---

  it('404 response matches ErrorResponse schema', async () => {
    const res = await request(app).get(`/api/v1/agent/${sha256('nonexistent-contract')}`);
    expect(res.status).toBe(404);
    assertShape(res.body.error, { code: 'string', message: 'string' });
    expect(res.body).toHaveProperty('requestId');
  });

  it('400 response matches ErrorResponse schema', async () => {
    const res = await request(app).get('/api/v1/agent/invalid-hash');
    expect(res.status).toBe(400);
    assertShape(res.body.error, { code: 'string', message: 'string' });
  });
});

describe('Contract tests — L402 security markers in OpenAPI spec', () => {
  // L402-gated endpoints must have security: [{ l402: [] }]
  const l402Paths = [
    '/agent/{publicKeyHash}',
    '/agent/{publicKeyHash}/verdict',
    '/agent/{publicKeyHash}/history',
    '/agent/{publicKeyHash}/attestations',
  ];

  for (const path of l402Paths) {
    it(`${path} is marked as L402-gated in OpenAPI spec`, () => {
      const pathSpec = (openapiSpec.paths as Record<string, Record<string, { security?: unknown[] }>>)[path];
      expect(pathSpec).toBeDefined();
      const op = pathSpec.get;
      expect(op.security).toEqual([{ l402: [] }]);
    });
  }

  // Free endpoints must NOT have security
  const freePaths = [
    '/agents/top',
    '/agents/search',
    '/health',
    '/stats',
    '/version',
  ];

  for (const path of freePaths) {
    it(`${path} is NOT marked as L402-gated in OpenAPI spec`, () => {
      const pathSpec = (openapiSpec.paths as Record<string, Record<string, { security?: unknown[] }>>)[path];
      expect(pathSpec).toBeDefined();
      const op = pathSpec.get;
      expect(op).not.toHaveProperty('security');
    });
  }

  // POST /verdicts uses L402
  it('/verdicts POST is marked as L402-gated in OpenAPI spec', () => {
    const pathSpec = (openapiSpec.paths as Record<string, Record<string, { security?: unknown[] }>>)['/verdicts'];
    expect(pathSpec).toBeDefined();
    const op = pathSpec.post;
    expect(op.security).toEqual([{ l402: [] }]);
  });

  // POST /attestations uses apiKey, not L402
  it('/attestations POST uses apiKey auth, not L402', () => {
    const pathSpec = openapiSpec.paths['/attestations'];
    expect(pathSpec).toBeDefined();
    const op = pathSpec.post;
    expect(op.security).toEqual([{ apiKey: [] }]);
  });
});
