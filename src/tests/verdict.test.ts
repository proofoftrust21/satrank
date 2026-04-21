// Verdict service + endpoint tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
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
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { createBayesianVerdictService, seedSafeBayesianObservations } from './helpers/bayesianTestFactory';
import { AgentController } from '../controllers/agentController';
import { AttestationController } from '../controllers/attestationController';
import { HealthController } from '../controllers/healthController';
import { createAgentRoutes } from '../routes/agent';
import { createAttestationRoutes } from '../routes/attestation';
import { createHealthRoutes } from '../routes/health';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandler';
import { sha256 } from '../utils/crypto';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`verdict-${Math.random()}`),
    public_key: null,
    alias: 'test-agent',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 50,
    total_attestations_received: 0,
    avg_score: 60,
    capacity_sats: null,
    positive_ratings: 10,
    negative_ratings: 1,
    lnplus_rank: 3,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('VerdictService', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), createBayesianVerdictService(db));
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('returns INSUFFICIENT for non-existent agent', async () => {
    const hash = sha256('nonexistent');
    const result = await verdictService.getVerdict(hash);
    expect(result.verdict).toBe('INSUFFICIENT');
    expect(result.n_obs).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.reason).toContain('not found');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('returns SAFE for high-score agent with real transactions', async () => {
    const counterparty = makeAgent({
      public_key_hash: sha256('safe-counterparty'),
      alias: 'Counterparty',
    });
    const agent = makeAgent({
      public_key_hash: sha256('safe-agent'),
      alias: 'SafeNode',
      avg_score: 75,
      total_transactions: 200,
      positive_ratings: 20,
      negative_ratings: 1,
      lnplus_rank: 5,
      query_count: 60,
      source: 'lightning_graph',
      public_key: 'pk-safe-agent',
      capacity_sats: 5_000_000_000,
      hubness_rank: 10,
      betweenness_rank: 20,
    });
    await agentRepo.insert(counterparty);
    await agentRepo.insert(agent);

    // Insert real transactions so scoring engine sees them
    for (let i = 0; i < 200; i++) {
      const txId = uuid();
      db.prepare(`
        INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
        VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
      `).run(txId, counterparty.public_key_hash, agent.public_key_hash, NOW - i * 3600, sha256(txId));
    }
    seedSafeBayesianObservations(db, agent.public_key_hash, { now: NOW });

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.verdict).toBe('SAFE');
    expect(result.p_success).toBeGreaterThanOrEqual(0.5);
    expect(result.reason).toContain('200 tx completed');
    expect(result.flags).toContain('high_demand');
  });

  it('returns RISKY for low-score agent', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('risky-agent'),
      alias: 'RiskyNode',
      avg_score: 20,
      total_transactions: 5,
      positive_ratings: 0,
      negative_ratings: 3,
      lnplus_rank: 0,
    });
    await agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.verdict).toBe('RISKY');
    expect(result.flags).toContain('low_volume');
    expect(result.flags).toContain('negative_reputation');
    expect(result.flags).toContain('no_reputation_data');
  });

  it('flags new_agent for recently created agents', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('new-agent'),
      first_seen: NOW - 5 * DAY,
      total_transactions: 50,
      positive_ratings: 5,
      lnplus_rank: 2,
    });
    await agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.flags).toContain('new_agent');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('returns RISKY when fraud attestation exists', async () => {
    // Create attester + subject agents and a transaction between them
    const attester = makeAgent({ public_key_hash: sha256('attester-fraud'), alias: 'Attester' });
    const subject = makeAgent({
      public_key_hash: sha256('subject-fraud'),
      alias: 'FraudNode',
      avg_score: 70,
      total_transactions: 100,
      positive_ratings: 15,
      lnplus_rank: 4,
    });
    await agentRepo.insert(attester);
    await agentRepo.insert(subject);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    // Insert fraud attestation
    await attestationRepo.insert({
      attestation_id: uuid(),
      tx_id: txId,
      attester_hash: attester.public_key_hash,
      subject_hash: subject.public_key_hash,
      score: 10,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'fraud',
      verified: 0,
      weight: 1.0,
    });

    const result = await verdictService.getVerdict(subject.public_key_hash);
    expect(result.verdict).toBe('RISKY');
    expect(result.flags).toContain('fraud_reported');
    expect(result.reason).toContain('fraud reported');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('flags dispute_reported when dispute attestation exists', async () => {
    const attester = makeAgent({ public_key_hash: sha256('attester-dispute'), alias: 'DisputeAttester' });
    const subject = makeAgent({
      public_key_hash: sha256('subject-dispute'),
      alias: 'DisputeNode',
      avg_score: 70,
      total_transactions: 100,
      positive_ratings: 15,
      lnplus_rank: 4,
    });
    await agentRepo.insert(attester);
    await agentRepo.insert(subject);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    await attestationRepo.insert({
      attestation_id: uuid(),
      tx_id: txId,
      attester_hash: attester.public_key_hash,
      subject_hash: subject.public_key_hash,
      score: 30,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'dispute',
      verified: 0,
      weight: 1.0,
    });

    const result = await verdictService.getVerdict(subject.public_key_hash);
    expect(result.flags).toContain('dispute_reported');
  });
});

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('VerdictService — personalTrust', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), createBayesianVerdictService(db));
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('returns personalTrust: null when no callerPubkey', async () => {
    const agent = makeAgent({ public_key_hash: sha256('trust-target') });
    await agentRepo.insert(agent);
    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.personalTrust).toBeNull();
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('returns distance 0 when caller directly attested target', async () => {
    const caller = makeAgent({ public_key_hash: sha256('trust-caller'), alias: 'Caller' });
    const target = makeAgent({ public_key_hash: sha256('trust-target-d0'), alias: 'Target' });
    await agentRepo.insert(caller);
    await agentRepo.insert(target);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, caller.public_key_hash, target.public_key_hash, NOW, sha256(txId));

    await attestationRepo.insert({
      attestation_id: uuid(),
      tx_id: txId,
      attester_hash: caller.public_key_hash,
      subject_hash: target.public_key_hash,
      score: 85,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'successful_transaction',
      verified: 0,
      weight: 1.0,
    });

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBe(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('returns distance 1 when shared connection exists', async () => {
    const caller = makeAgent({ public_key_hash: sha256('trust-caller-d1'), alias: 'Caller' });
    const intermediary = makeAgent({ public_key_hash: sha256('trust-intermediary'), alias: 'Intermediary' });
    const target = makeAgent({ public_key_hash: sha256('trust-target-d1'), alias: 'Target' });
    await agentRepo.insert(caller);
    await agentRepo.insert(intermediary);
    await agentRepo.insert(target);

    // Caller attested intermediary
    const txId1 = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId1, caller.public_key_hash, intermediary.public_key_hash, NOW, sha256(txId1));

    await attestationRepo.insert({
      attestation_id: uuid(),
      tx_id: txId1,
      attester_hash: caller.public_key_hash,
      subject_hash: intermediary.public_key_hash,
      score: 80,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'successful_transaction',
      verified: 0,
      weight: 1.0,
    });

    // Intermediary attested target
    const txId2 = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId2, intermediary.public_key_hash, target.public_key_hash, NOW, sha256(txId2));

    await attestationRepo.insert({
      attestation_id: uuid(),
      tx_id: txId2,
      attester_hash: intermediary.public_key_hash,
      subject_hash: target.public_key_hash,
      score: 75,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'successful_transaction',
      verified: 0,
      weight: 1.0,
    });

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBe(1);
    expect(result.personalTrust!.sharedConnections).toBeGreaterThanOrEqual(1);
    expect(result.personalTrust!.strongestConnection).toBeTruthy();
  });

  it('returns distance null when no trust path exists', async () => {
    const caller = makeAgent({ public_key_hash: sha256('trust-caller-none'), alias: 'CallerNone' });
    const target = makeAgent({ public_key_hash: sha256('trust-target-none'), alias: 'TargetNone' });
    await agentRepo.insert(caller);
    await agentRepo.insert(target);

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBeNull();
    expect(result.personalTrust!.sharedConnections).toBe(0);
    expect(result.personalTrust!.strongestConnection).toBeNull();
  });

  it('returns personalTrust stub for INSUFFICIENT (missing) agent when callerPubkey provided', async () => {
    const result = await verdictService.getVerdict(sha256('nonexistent'), sha256('some-caller'));
    expect(result.verdict).toBe('INSUFFICIENT');
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBeNull();
    expect(result.personalTrust!.sharedConnections).toBe(0);
  });
});

describe('VerdictService — riskProfile', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let verdictService: VerdictService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), createBayesianVerdictService(db));
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('classifies new unproven agent', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('risk-new'),
      first_seen: NOW - 10 * DAY,
      total_transactions: 3,
      positive_ratings: 0,
      lnplus_rank: 0,
    });
    await agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.riskProfile).toBeDefined();
    expect(result.riskProfile.name).toBe('new_unproven');
    expect(result.riskProfile.riskLevel).toBe('high');
  });

  it('returns unrated riskProfile for UNKNOWN agent', async () => {
    const result = await verdictService.getVerdict(sha256('nonexistent-risk'));
    expect(result.riskProfile.name).toBe('unrated');
    expect(result.riskProfile.riskLevel).toBe('unknown');
  });

  it('riskProfile always has name, riskLevel, and description', async () => {
    const agent = makeAgent({ public_key_hash: sha256('risk-shape') });
    await agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(typeof result.riskProfile.name).toBe('string');
    expect(typeof result.riskProfile.riskLevel).toBe('string');
    expect(typeof result.riskProfile.description).toBe('string');
    expect(result.riskProfile.description.length).toBeGreaterThan(0);
  });
});

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('Verdict endpoint integration', async () => {
  let db: Pool;
  let app: express.Express;
  let agentRepo: AgentRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
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

    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    const { Router } = express;
    const api = Router();
    api.use(createAgentRoutes(agentController));
    api.use(createAttestationRoutes(attestationController));
    api.use(createHealthRoutes(healthController));
    app.use('/api', api);
    app.use(errorHandler);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('GET /api/agent/:hash/verdict returns INSUFFICIENT for missing agent', async () => {
    const hash = sha256('unknown-agent');
    const res = await request(app).get(`/api/agent/${hash}/verdict`);
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('INSUFFICIENT');
    expect(res.body.data.n_obs).toBe(0);
    expect(res.body.data.flags).toEqual([]);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('GET /api/agent/:hash/verdict returns SAFE for good agent', async () => {
    const counterparty = makeAgent({
      public_key_hash: sha256('verdict-counterparty'),
      alias: 'Counterparty2',
    });
    const agent = makeAgent({
      public_key_hash: sha256('verdict-good'),
      alias: 'GoodNode',
      avg_score: 80,
      total_transactions: 200,
      positive_ratings: 20,
      negative_ratings: 1,
      lnplus_rank: 5,
      source: 'lightning_graph',
      public_key: 'pk-good-node',
      capacity_sats: 5_000_000_000,
      hubness_rank: 10,
      betweenness_rank: 20,
    });
    await agentRepo.insert(counterparty);
    await agentRepo.insert(agent);

    // Insert real transactions
    for (let i = 0; i < 200; i++) {
      const txId = uuid();
      db.prepare(`
        INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
        VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
      `).run(txId, counterparty.public_key_hash, agent.public_key_hash, NOW - i * 3600, sha256(txId));
    }
    seedSafeBayesianObservations(db, agent.public_key_hash, { now: NOW });

    const res = await request(app).get(`/api/agent/${agent.public_key_hash}/verdict`);
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('SAFE');
    expect(res.body.data.p_success).toBeGreaterThan(0);
    expect(res.body.data.reason).toBeTruthy();
    expect(Array.isArray(res.body.data.flags)).toBe(true);
  });

  it('GET /api/agent/invalid/verdict returns 400', async () => {
    const res = await request(app).get('/api/agent/not-a-hash/verdict');
    expect(res.status).toBe(400);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('POST /api/attestation accepts category field', async () => {
    const attester = makeAgent({ public_key_hash: sha256('cat-attester'), alias: 'CatAttester' });
    const subject = makeAgent({ public_key_hash: sha256('cat-subject'), alias: 'CatSubject' });
    await agentRepo.insert(attester);
    await agentRepo.insert(subject);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    const res = await request(app)
      .post('/api/attestation')
      .set('Content-Type', 'application/json')
      .set('X-API-Key', process.env.SATRANK_API_KEY || 'test-key')
      .send({
        txId,
        attesterHash: attester.public_key_hash,
        subjectHash: subject.public_key_hash,
        score: 15,
        category: 'fraud',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.attestationId).toBeTruthy();
  });
});
