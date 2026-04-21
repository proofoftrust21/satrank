// Tier 2 report bonus — exercises the eligibility gate, threshold crossing,
// daily cap, auto-rollback, and the disabled-by-default flag. The service is
// constructed directly against an in-memory DB so we don't need to boot the
// full app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import crypto from 'node:crypto';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { ReportBonusRepository } from '../repositories/reportBonusRepository';
import { ReportBonusService } from '../services/reportBonusService';
import { NpubAgeCache } from '../nostr/npubAgeCache';
import type { Request } from 'express';
import type { Agent } from '../types';
let testDb: TestDb;

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makeAgent(hash: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias: 'test',
    first_seen: Math.floor(Date.now() / 1000) - 365 * 86400,
    last_seen: Math.floor(Date.now() / 1000),
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 0,
    avg_score: 50,
    capacity_sats: 1_000_000_000,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    query_count: 0,
    unique_peers: 50,
    last_queried_at: null,
    disabled_channels: 0,
    pagerank_score: 80,
    ...overrides,
  };
}

/** Build a bare Request stub sufficient for the bonus gate. */
function fakeRequest(authHeader = ''): Request {
  return {
    headers: authHeader ? { authorization: authHeader, host: 'satrank.dev' } : { host: 'satrank.dev' },
    method: 'POST',
    originalUrl: '/api/report',
  } as unknown as Request;
}

/** Insert a token_balance row so credits have somewhere to land. */
function seedToken(db: Pool, paymentHash: Buffer, remaining = 10): void {
  db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
    .run(paymentHash, remaining, Math.floor(Date.now() / 1000));
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('ReportBonusService', async () => {
  let db: Pool;
  let reporterHash: string;
  let paymentHash: Buffer;
  let service: ReportBonusService;
  let scoringService: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    const agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attRepo = new AttestationRepository(db);
    const snapRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attRepo, snapRepo, db, probeRepo);

    // Reporter with high-enough SatRank score to pass the gate.
    reporterHash = sha256('high-score-reporter');
    await agentRepo.insert(makeAgent(reporterHash, { avg_score: 60 }));

    const bonusRepo = new ReportBonusRepository(db);
    const npubCache = new NpubAgeCache('/tmp/nonexistent-npub-ages.json');
    service = new ReportBonusService(db, bonusRepo, scoringService, npubCache, {
      enabledFromEnv: true,
      threshold: 10,
      dailyCap: 3,
      satsPerBonus: 1,
      minReporterScore: 30,
      minNpubAgeDays: 30,
      rollbackRatio: 1.3,
      guardIntervalMs: 60_000,
    });

    paymentHash = crypto.randomBytes(32);
    seedToken(db, paymentHash, 10);
  });

  afterEach(async () => {
    service.stopGuard();
    await teardownTestPool(testDb);
  });

  it('is off by default when enabledFromEnv is false', async () => {
    service.stopGuard();
    await teardownTestPool(testDb);
    testDb = await setupTestPool();

    db = testDb.pool;
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(sha256('x'), { avg_score: 60 }));
    const scoringOff = new ScoringService(agentRepo, new TransactionRepository(db), new AttestationRepository(db), new SnapshotRepository(db), db, new ProbeRepository(db));
    const off = new ReportBonusService(db, new ReportBonusRepository(db), scoringOff, new NpubAgeCache('/tmp/nonexistent'), {
      enabledFromEnv: false, threshold: 10, dailyCap: 3, satsPerBonus: 1,
      minReporterScore: 30, minNpubAgeDays: 30, rollbackRatio: 1.3, guardIntervalMs: 60_000,
    });
    expect(off.isEnabled()).toBe(false);
    const ph = crypto.randomBytes(32);
    seedToken(db, ph);
    const result = await off.maybeCredit({
      reporterHash: sha256('x'),
      req: fakeRequest(),
      verified: true,
      paymentHash: ph,
    });
    expect(result.credited).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('rejects non-verified reports regardless of gate', async () => {
    const result = await service.maybeCredit({
      reporterHash,
      req: fakeRequest(),
      verified: false,
      paymentHash,
    });
    expect(result.credited).toBe(false);
    expect(result.reason).toBe('not_verified');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('credits exactly on the Nth eligible verified report (threshold=10)', async () => {
    // 9 reports — no credit
    for (let i = 0; i < 9; i++) {
      const r = await service.maybeCredit({ reporterHash, req: fakeRequest(), verified: true, paymentHash });
      expect(r.credited, `report ${i+1}`).toBe(false);
    }
    // 10th report — credit
    const r10 = await service.maybeCredit({ reporterHash, req: fakeRequest(), verified: true, paymentHash });
    expect(r10.credited).toBe(true);
    expect(r10.sats).toBe(1);

    // Balance was credited
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(paymentHash) as { remaining: number };
    expect(row.remaining).toBe(11); // seeded 10 + 1 bonus
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('enforces the daily cap (3 bonuses = 30 reports max)', async () => {
    // Submit 40 eligible verified reports in the same day.
    let credited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await service.maybeCredit({ reporterHash, req: fakeRequest(), verified: true, paymentHash });
      if (r.credited) credited++;
    }
    // threshold=10, dailyCap=3 → first 30 generate 3 bonuses; the next 10 are capped.
    expect(credited).toBe(3);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(paymentHash) as { remaining: number };
    expect(row.remaining).toBe(13); // seeded 10 + 3 bonuses
  });

  it('rejects reporters below the score gate without NIP-98', async () => {
    // Build a genuinely low-scoring agent (fresh + minimal data) so
    // await ScoringService.getScore() itself returns below the 30 gate — avg_score
    // is just a denormalized cache, the live compute drives the decision.
    const lowScoreHash = sha256('low-score-reporter');
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(lowScoreHash, {
      first_seen: Math.floor(Date.now() / 1000) - 86400,  // 1 day old
      capacity_sats: 10_000,
      total_transactions: 1,
      unique_peers: 1,
      pagerank_score: 0,
      avg_score: 10,
    }));
    const r = await service.maybeCredit({
      reporterHash: lowScoreHash,
      req: fakeRequest(),
      verified: true,
      paymentHash,
    });
    expect(r.credited).toBe(false);
    expect(r.gate).toBe('none');
    expect(r.reason).toBe('gate_rejected');
  });

  it('skips when there is no L402 payment_hash to credit', async () => {
    const r = await service.maybeCredit({
      reporterHash,
      req: fakeRequest(),
      verified: true,
      paymentHash: null,
    });
    expect(r.credited).toBe(false);
    expect(r.reason).toBe('no_payment_hash');
  });

  it('disableForRollback flips the flag and increments the rollback counter', async () => {
    expect(service.isEnabled()).toBe(true);
    service.disableForRollback('manual_test');
    expect(service.isEnabled()).toBe(false);
  });
});
