// Verdict service + endpoint tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
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
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
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

describe('VerdictService', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('returns UNKNOWN for non-existent agent', async () => {
    const hash = sha256('nonexistent');
    const result = await verdictService.getVerdict(hash);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.confidence).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.reason).toContain('not found');
  });

  it('returns SAFE for high-score agent with real transactions', async () => {
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
    agentRepo.insert(counterparty);
    agentRepo.insert(agent);

    // Insert real transactions so scoring engine sees them
    for (let i = 0; i < 200; i++) {
      const txId = uuid();
      db.prepare(`
        INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
        VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
      `).run(txId, counterparty.public_key_hash, agent.public_key_hash, NOW - i * 3600, sha256(txId));
    }

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.verdict).toBe('SAFE');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
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
    agentRepo.insert(agent);

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
    agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.flags).toContain('new_agent');
  });

  it('returns RISKY when fraud attestation exists', async () => {
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
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    // Insert fraud attestation
    attestationRepo.insert({
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

  it('flags dispute_reported when dispute attestation exists', async () => {
    const attester = makeAgent({ public_key_hash: sha256('attester-dispute'), alias: 'DisputeAttester' });
    const subject = makeAgent({
      public_key_hash: sha256('subject-dispute'),
      alias: 'DisputeNode',
      avg_score: 70,
      total_transactions: 100,
      positive_ratings: 15,
      lnplus_rank: 4,
    });
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    attestationRepo.insert({
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

describe('VerdictService — personalTrust', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('returns personalTrust: null when no callerPubkey', async () => {
    const agent = makeAgent({ public_key_hash: sha256('trust-target') });
    agentRepo.insert(agent);
    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.personalTrust).toBeNull();
  });

  it('returns distance 0 when caller directly attested target', async () => {
    const caller = makeAgent({ public_key_hash: sha256('trust-caller'), alias: 'Caller' });
    const target = makeAgent({ public_key_hash: sha256('trust-target-d0'), alias: 'Target' });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId, caller.public_key_hash, target.public_key_hash, NOW, sha256(txId));

    attestationRepo.insert({
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

  it('returns distance 1 when shared connection exists', async () => {
    const caller = makeAgent({ public_key_hash: sha256('trust-caller-d1'), alias: 'Caller' });
    const intermediary = makeAgent({ public_key_hash: sha256('trust-intermediary'), alias: 'Intermediary' });
    const target = makeAgent({ public_key_hash: sha256('trust-target-d1'), alias: 'Target' });
    agentRepo.insert(caller);
    agentRepo.insert(intermediary);
    agentRepo.insert(target);

    // Caller attested intermediary
    const txId1 = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
    `).run(txId1, caller.public_key_hash, intermediary.public_key_hash, NOW, sha256(txId1));

    attestationRepo.insert({
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

    attestationRepo.insert({
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
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBeNull();
    expect(result.personalTrust!.sharedConnections).toBe(0);
    expect(result.personalTrust!.strongestConnection).toBeNull();
  });

  it('returns personalTrust stub for UNKNOWN agent when callerPubkey provided', async () => {
    const result = await verdictService.getVerdict(sha256('nonexistent'), sha256('some-caller'));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBeNull();
    expect(result.personalTrust!.sharedConnections).toBe(0);
  });
});

describe('VerdictService — riskProfile', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('classifies new unproven agent', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('risk-new'),
      first_seen: NOW - 10 * DAY,
      total_transactions: 3,
      positive_ratings: 0,
      lnplus_rank: 0,
    });
    agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.riskProfile).toBeDefined();
    expect(result.riskProfile.name).toBe('new_unproven');
    expect(result.riskProfile.riskLevel).toBe('high');
  });

  it('returns default riskProfile for UNKNOWN agent', async () => {
    const result = await verdictService.getVerdict(sha256('nonexistent-risk'));
    expect(result.riskProfile.name).toBe('default');
    expect(result.riskProfile.riskLevel).toBe('unknown');
  });

  it('riskProfile always has name, riskLevel, and description', async () => {
    const agent = makeAgent({ public_key_hash: sha256('risk-shape') });
    agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(typeof result.riskProfile.name).toBe('string');
    expect(typeof result.riskProfile.riskLevel).toBe('string');
    expect(typeof result.riskProfile.description).toBe('string');
    expect(result.riskProfile.description.length).toBeGreaterThan(0);
  });
});

describe('Verdict endpoint integration', () => {
  let db: Database.Database;
  let app: express.Express;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
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

  afterEach(() => { db.close(); });

  it('GET /api/agent/:hash/verdict returns UNKNOWN for missing agent', async () => {
    const hash = sha256('unknown-agent');
    const res = await request(app).get(`/api/agent/${hash}/verdict`);
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('UNKNOWN');
    expect(res.body.data.confidence).toBe(0);
    expect(res.body.data.flags).toEqual([]);
  });

  it('GET /api/agent/:hash/verdict returns SAFE for good agent', async () => {
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
    agentRepo.insert(counterparty);
    agentRepo.insert(agent);

    // Insert real transactions
    for (let i = 0; i < 200; i++) {
      const txId = uuid();
      db.prepare(`
        INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
        VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
      `).run(txId, counterparty.public_key_hash, agent.public_key_hash, NOW - i * 3600, sha256(txId));
    }

    const res = await request(app).get(`/api/agent/${agent.public_key_hash}/verdict`);
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('SAFE');
    expect(res.body.data.confidence).toBeGreaterThan(0);
    expect(res.body.data.reason).toBeTruthy();
    expect(Array.isArray(res.body.data.flags)).toBe(true);
  });

  it('GET /api/agent/invalid/verdict returns 400', async () => {
    const res = await request(app).get('/api/agent/not-a-hash/verdict');
    expect(res.status).toBe(400);
  });

  it('POST /api/attestation accepts category field', async () => {
    const attester = makeAgent({ public_key_hash: sha256('cat-attester'), alias: 'CatAttester' });
    const subject = makeAgent({ public_key_hash: sha256('cat-subject'), alias: 'CatSubject' });
    agentRepo.insert(attester);
    agentRepo.insert(subject);

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
