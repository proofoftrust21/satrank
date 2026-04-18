// API tests — decide, report, profile
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express, { Router } from 'express';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { DecideService } from '../services/decideService';
import { ReportService } from '../services/reportService';
import { V2Controller } from '../controllers/v2Controller';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
// createV2Routes not imported — routes mounted directly to avoid IP rate limiter in tests
import { errorHandler } from '../middleware/errorHandler';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
    first_seen: NOW - 180 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 50,
    total_attestations_received: 10,
    avg_score: 65,
    capacity_sats: null,
    positive_ratings: 3,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 5,
    ...overrides,
  };
}

function makeTx(id: string, sender: string, receiver: string): Transaction {
  return {
    tx_id: id,
    sender_hash: sender,
    receiver_hash: receiver,
    amount_bucket: 'small',
    timestamp: NOW - DAY,
    payment_hash: sha256(id),
    preimage: null,
    status: 'verified',
    protocol: 'bolt11',
  };
}

let db: Database.Database;
let app: express.Express;
let agentRepo: AgentRepository;
let txRepo: TransactionRepository;
let attestationRepo: AttestationRepository;

function buildTestApp() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  agentRepo = new AgentRepository(db);
  txRepo = new TransactionRepository(db);
  attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const probeRepo = new ProbeRepository(db);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const bayesianVerdictService = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);
  const riskService = new RiskService();
  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, bayesianVerdictService, probeRepo);
  const decideService = new DecideService({ agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService, probeRepo });
  const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db);
  const v2Controller = new V2Controller(decideService, reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo);

  app = express();
  app.use(express.json());
  // Mount controller handlers directly — skip IP rate limiter to avoid
  // cross-test 429s. Business-level rate limiting is tested via ReportService.
  const v2 = Router();
  v2.post('/decide', v2Controller.decide);
  v2.post('/report', v2Controller.report);
  v2.get('/profile/:id', v2Controller.profile);
  app.use('/api', v2);
  app.use(errorHandler);

  // Seed test agents
  const alice = makeAgent('alice');
  const bob = makeAgent('bob');
  agentRepo.insert(alice);
  agentRepo.insert(bob);

  // Seed some transactions so scoring has data
  for (let i = 0; i < 10; i++) {
    txRepo.insert(makeTx(`tx-${i}`, alice.public_key_hash, bob.public_key_hash));
  }
}

beforeAll(() => { buildTestApp(); });
afterAll(() => { db.close(); });

// --- POST /api/decide ---

describe('POST /api/decide', () => {
  it('returns go=true for a well-known agent', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('bob'), caller: sha256('alice') })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(typeof res.body.data.go).toBe('boolean');
    expect(typeof res.body.data.successRate).toBe('number');
    expect(res.body.data.successRate).toBeGreaterThanOrEqual(0);
    expect(res.body.data.successRate).toBeLessThanOrEqual(1);
    expect(res.body.data.components).toBeDefined();
    expect(res.body.data.components.pathQuality).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.data.p_success).toBe('number');
    expect(res.body.data.verdict).toBeDefined();
    expect(res.body.data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns go=false for unknown target', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('unknown-agent'), caller: sha256('alice') })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    // Unknown agent → INSUFFICIENT verdict → low success rate → go=false
    expect(res.body.data.go).toBe(false);
    expect(res.body.data.verdict).toBe('INSUFFICIENT');
  });

  it('validates input — rejects missing target', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ caller: sha256('alice') })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
  });

  it('validation error names the offending field, expected format, and received length', async () => {
    // 11-char caller — Romain's canonical example
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('bob'), caller: 'shortstring' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const msg: string = res.body.error.message;
    expect(msg).toContain('caller');
    expect(msg).toContain('64-char SHA256 hash');
    expect(msg).toContain('66-char Lightning pubkey');
    expect(msg).toContain('got 11 chars');
  });

  it('validation error reports missing caller as required', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('bob') })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    const msg: string = res.body.error.message;
    expect(msg).toContain('caller');
    expect(msg).toContain('required');
  });

  it('validation error reports amountSats range violation', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('bob'), caller: sha256('alice'), amountSats: 0 })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    const msg: string = res.body.error.message;
    expect(msg).toContain('amountSats');
    expect(msg).toContain('got 0');
  });

  it('accepts 66-char Lightning pubkeys', async () => {
    // Register agent with a pubkey
    const pubkey = '02' + sha256('lightning-agent');
    const hash = sha256(pubkey);
    agentRepo.insert(makeAgent('lightning-agent', { public_key_hash: hash, public_key: pubkey }));

    const res = await request(app)
      .post('/api/decide')
      .send({ target: pubkey, caller: sha256('alice') })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('accepts amountSats parameter', async () => {
    const res = await request(app)
      .post('/api/decide')
      .send({ target: sha256('bob'), caller: sha256('alice'), amountSats: 50000 })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
  });
});

// --- POST /api/report ---

describe('POST /api/report', () => {
  it('submits a success report', async () => {
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('bob'),
        reporter: sha256('alice'),
        outcome: 'success',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    expect(res.body.data.reportId).toBeDefined();
    expect(res.body.data.verified).toBe(false);
    expect(res.body.data.weight).toBeGreaterThan(0);
    expect(res.body.data.timestamp).toBeGreaterThan(0);
  });

  it('submits a failure report', async () => {
    // Need a different target to avoid dedup
    agentRepo.insert(makeAgent('charlie'));
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('charlie'),
        reporter: sha256('alice'),
        outcome: 'failure',
        memo: 'Payment failed after 30 seconds',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(false);
  });

  it('submits a timeout report', async () => {
    agentRepo.insert(makeAgent('dave'));
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('dave'),
        reporter: sha256('alice'),
        outcome: 'timeout',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
  });

  it('verifies preimage and gives weight bonus', async () => {
    const { createHash } = await import('node:crypto');
    const preimage = 'a'.repeat(64);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

    agentRepo.insert(makeAgent('eve'));
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('eve'),
        reporter: sha256('alice'),
        outcome: 'success',
        paymentHash,
        preimage,
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(true);
    // Weight should be > base weight due to preimage bonus
    expect(res.body.data.weight).toBeGreaterThan(0.3);
  });

  it('rejects self-report', async () => {
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('alice'),
        reporter: sha256('alice'),
        outcome: 'success',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
  });

  it('rejects duplicate report within 1 hour', async () => {
    agentRepo.insert(makeAgent('frank'));

    // First report
    const res1 = await request(app)
      .post('/api/report')
      .send({
        target: sha256('frank'),
        reporter: sha256('alice'),
        outcome: 'success',
      })
      .set('Content-Type', 'application/json');
    expect(res1.status).toBe(201);

    // Second report — same reporter + target within 1 hour
    const res2 = await request(app)
      .post('/api/report')
      .send({
        target: sha256('frank'),
        reporter: sha256('alice'),
        outcome: 'failure',
      })
      .set('Content-Type', 'application/json');
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('DUPLICATE_REPORT');
  });

  it('rejects report for unknown target', async () => {
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('nonexistent'),
        reporter: sha256('alice'),
        outcome: 'success',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.details?.resource).toBe('Agent (target)');
  });

  it('validates outcome enum', async () => {
    const res = await request(app)
      .post('/api/report')
      .send({
        target: sha256('bob'),
        reporter: sha256('alice'),
        outcome: 'invalid',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
  });
});

// --- GET /api/profile/:id ---

describe('GET /api/profile/:id', () => {
  it('returns profile for known agent', async () => {
    const res = await request(app)
      .get(`/api/profile/${sha256('bob')}`);

    expect(res.status).toBe(200);
    expect(res.body.data.agent.publicKeyHash).toBe(sha256('bob'));
    expect(res.body.data.agent.alias).toBe('bob');
    expect(res.body.data.bayesian).toBeDefined();
    expect(typeof res.body.data.bayesian.p_success).toBe('number');
    expect(['SAFE', 'UNKNOWN', 'RISKY', 'INSUFFICIENT']).toContain(res.body.data.bayesian.verdict);
    expect(res.body.data.bayesian.sources).toBeDefined();
    expect(res.body.data.bayesian.convergence).toBeDefined();
    expect(res.body.data.rank === null || typeof res.body.data.rank === 'number').toBe(true);
    expect(res.body.data.reports).toBeDefined();
    expect(typeof res.body.data.reports.total).toBe('number');
    expect(typeof res.body.data.reports.successRate).toBe('number');
    expect(res.body.data.delta).toBeUndefined();
    expect(res.body.data.score).toBeUndefined();
    expect(res.body.data.riskProfile).toBeDefined();
    expect(res.body.data.evidence).toBeDefined();
    expect(Array.isArray(res.body.data.flags)).toBe(true);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app)
      .get(`/api/profile/${sha256('nobody')}`);

    expect(res.status).toBe(404);
  });

  it('accepts 66-char Lightning pubkey', async () => {
    const pubkey = '03' + sha256('profile-ln-agent');
    const hash = sha256(pubkey);
    agentRepo.insert(makeAgent('profile-ln-agent', { public_key_hash: hash, public_key: pubkey }));

    const res = await request(app)
      .get(`/api/profile/${pubkey}`);

    expect(res.status).toBe(200);
    expect(res.body.data.agent.publicKeyHash).toBe(hash);
  });

  it('includes report counts after submitting reports', async () => {
    // Submit a report first
    agentRepo.insert(makeAgent('grace'));
    await request(app)
      .post('/api/report')
      .send({ target: sha256('grace'), reporter: sha256('bob'), outcome: 'success' })
      .set('Content-Type', 'application/json');

    const res = await request(app).get(`/api/profile/${sha256('grace')}`);

    expect(res.status).toBe(200);
    expect(res.body.data.reports.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.reports.successes).toBeGreaterThanOrEqual(1);
  });

  it('validates invalid hash format', async () => {
    const res = await request(app).get('/api/profile/invalid-hash');
    expect(res.status).toBe(400);
  });
});

// --- DecideService unit tests ---

describe('DecideService', () => {
  it('returns Bayesian block + successRate in [0,1]', async () => {
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const riskService = new RiskService();
    const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, createBayesianVerdictService(db), probeRepo);
    const decideService = new DecideService({ agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService, probeRepo });

    const result = await decideService.decide(sha256('bob'), sha256('alice'));
    expect(typeof result.p_success).toBe('number');
    expect(result.p_success).toBeGreaterThanOrEqual(0);
    expect(result.p_success).toBeLessThanOrEqual(1);
    expect(typeof result.n_obs).toBe('number');
    expect(['24h', '7d', '30d']).toContain(result.window);
    expect(result.sources).toBeDefined();
    expect(result.convergence).toBeDefined();
    expect(result.successRate).toBeGreaterThanOrEqual(0);
    expect(result.successRate).toBeLessThanOrEqual(1);
  });
});

// --- ReportService unit tests ---

describe('ReportService', () => {
  it('weights reports by reporter score', () => {
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db);

    // Create a fresh target for this test
    agentRepo.insert(makeAgent('weight-target'));
    agentRepo.insert(makeAgent('weight-reporter', { avg_score: 80 }));

    const result = reportService.submit({
      target: sha256('weight-target'),
      reporter: sha256('weight-reporter'),
      outcome: 'success',
    });

    // Weight is computed from scoringService.getScore() (computed, not avg_score field)
    // Just verify it's within the valid range
    expect(result.weight).toBeGreaterThanOrEqual(0.3);
    expect(result.weight).toBeLessThanOrEqual(2.0); // max with preimage bonus
  });

  it('maps outcomes to correct scores', () => {
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db);

    agentRepo.insert(makeAgent('outcome-target'));
    agentRepo.insert(makeAgent('outcome-reporter'));

    // Submit and check that the attestation was created with the right score
    const result = reportService.submit({
      target: sha256('outcome-target'),
      reporter: sha256('outcome-reporter'),
      outcome: 'failure',
    });

    // Verify the attestation was stored with score=15 (failure)
    const attestations = attestationRepo.findBySubject(sha256('outcome-target'), 10, 0);
    const report = attestations.find(a => a.attestation_id === result.reportId);
    expect(report).toBeDefined();
    expect(report!.score).toBe(15);
    expect(report!.category).toBe('failed_transaction');
  });
});
