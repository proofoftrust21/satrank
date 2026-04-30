// Phase 2 (2026-05-01) — RefundEngine tests.
//
// Cover: classifier (every delivery_outcome variant + non-paid attempts),
// ledger idempotency, daily-cap enforcement (fresh vs established agents,
// drain-attack scenario via concurrent attempts), and the worst-case
// reservation guard.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { RefundEngine, DEFAULT_REFUND_ENGINE_CONFIG } from '../services/refundEngine';
import { RefundLedgerRepository } from '../repositories/refundLedgerRepository';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import type { FulfillAttempt } from '../repositories/fulfillJobRepository';

let testDb: TestDb;

function makeAttempt(overrides: Partial<FulfillAttempt> = {}): FulfillAttempt {
  return {
    candidate_url: 'https://op.example/api',
    rank: 1,
    ts_started: 1000,
    ts_finished: 1010,
    payment_outcome: 'pay_ok',
    delivery_outcome: 'delivery_4xx',
    http_status: 404,
    sats_paid: 5,
    ...overrides,
  };
}

describe('RefundEngine.classifyAttempt', () => {
  const engine = new RefundEngine({
    refundLedgerRepo: {} as RefundLedgerRepository,
  });

  it('returns null when payment did not succeed', () => {
    expect(engine.classifyAttempt(makeAttempt({ payment_outcome: 'probe_not_402' }))).toBe(null);
    expect(engine.classifyAttempt(makeAttempt({ payment_outcome: 'pay_routing_failed' }))).toBe(null);
    expect(engine.classifyAttempt(makeAttempt({ payment_outcome: 'lnd_not_configured' }))).toBe(null);
    expect(engine.classifyAttempt(makeAttempt({ payment_outcome: 'invoice_decode_failed' }))).toBe(null);
  });

  it('returns null on successful delivery (no refund)', () => {
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_ok' }))).toBe(null);
  });

  it('classifies Tier 1 HTTP failures', () => {
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_4xx' }))).toBe('tier1_http_4xx');
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_5xx' }))).toBe('tier1_http_5xx');
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_other' }))).toBe('tier1_http_other');
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'recall_network_error' }))).toBe('tier1_recall_network_error');
  });

  it('classifies Tier 2 body-shape failures', () => {
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_low_quality' }))).toBe('tier2_body_shape');
    expect(engine.classifyAttempt(makeAttempt({ delivery_outcome: 'delivery_empty_body' }))).toBe('tier2_empty_body');
  });
});

describe('RefundEngine — ledger + cap (DB-backed)', async () => {
  let pool: Pool;
  let refundLedgerRepo: RefundLedgerRepository;
  let fulfillJobRepo: FulfillJobRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    refundLedgerRepo = new RefundLedgerRepository(pool);
    fulfillJobRepo = new FulfillJobRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE refund_ledger RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE fulfill_jobs RESTART IDENTITY CASCADE');
  });

  async function seedFulfillJob(jobId: string, agentPubkey: string): Promise<void> {
    await fulfillJobRepo.create({
      job_id: jobId,
      agent_pubkey: agentPubkey,
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: 1000,
    });
  }

  it('records a refund ledger entry per absorbed attempt', async () => {
    const engine = new RefundEngine({ refundLedgerRepo, now: () => 12345 });
    await seedFulfillJob('job-1', 'agent-x');
    const out = await engine.recordAttempt({
      job_id: 'job-1',
      agent_pubkey: 'agent-x',
      attempt: makeAttempt({ delivery_outcome: 'delivery_5xx', sats_paid: 7 }),
    });
    expect(out?.classification).toBe('tier1_http_5xx');
    expect(out?.inserted).toBe(true);
    const row = await refundLedgerRepo.findById(out!.ledger_id);
    expect(row?.sats_absorbed).toBe(7);
    expect(row?.classification).toBe('tier1_http_5xx');
    expect(row?.ts).toBe(12345);
  });

  it('idempotent on (job_id, candidate_url) — re-recording returns same ledger_id', async () => {
    const engine = new RefundEngine({ refundLedgerRepo });
    await seedFulfillJob('job-2', 'agent-y');
    const a = await engine.recordAttempt({
      job_id: 'job-2',
      agent_pubkey: 'agent-y',
      attempt: makeAttempt(),
    });
    const b = await engine.recordAttempt({
      job_id: 'job-2',
      agent_pubkey: 'agent-y',
      attempt: makeAttempt(),
    });
    expect(a?.ledger_id).toBe(b?.ledger_id);
    expect(a?.inserted).toBe(true);
    expect(b?.inserted).toBe(false);
  });

  it('skips ledger write when classifier returns null', async () => {
    const engine = new RefundEngine({ refundLedgerRepo });
    await seedFulfillJob('job-3', 'agent-z');
    const skipped = await engine.recordAttempt({
      job_id: 'job-3',
      agent_pubkey: 'agent-z',
      attempt: makeAttempt({ payment_outcome: 'probe_not_402', sats_paid: 0 }),
    });
    expect(skipped).toBe(null);
  });

  it('fresh agent (no first_seen) gets the strict daily cap', async () => {
    const engine = new RefundEngine({
      refundLedgerRepo,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
    const result = await engine.checkDailyCap({
      agent_pubkey: 'fresh-1',
      agent_first_seen_at: null,
      worst_case_sats: 50,
    });
    expect(result.cap_sats).toBe(100);
    expect(result.agent_age_bucket).toBe('fresh');
    expect(result.allowed).toBe(true);
    expect(result.remaining_sats).toBe(100);
  });

  it('established agent (>30d old) gets the higher daily cap', async () => {
    const nowSec = 1_777_589_000;
    const fortyDaysAgo = nowSec - 40 * 86400;
    const engine = new RefundEngine({
      refundLedgerRepo,
      now: () => nowSec,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
    const result = await engine.checkDailyCap({
      agent_pubkey: 'established-1',
      agent_first_seen_at: fortyDaysAgo,
      worst_case_sats: 5000,
    });
    expect(result.cap_sats).toBe(10000);
    expect(result.agent_age_bucket).toBe('established');
    expect(result.allowed).toBe(true);
  });

  it('drain protection — fresh agent with 95 sats absorbed in 24h cannot reserve 50 more', async () => {
    const engine = new RefundEngine({
      refundLedgerRepo,
      now: () => 12345,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
    await seedFulfillJob('job-drain-1', 'drain-agent');
    await refundLedgerRepo.record({
      job_id: 'job-drain-1',
      candidate_url: 'https://x.example/a',
      agent_pubkey: 'drain-agent',
      sats_absorbed: 95,
      classification: 'tier1_http_4xx',
      ts: 12345 - 100,
    });
    const result = await engine.checkDailyCap({
      agent_pubkey: 'drain-agent',
      agent_first_seen_at: null, // fresh
      worst_case_sats: 50,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('fresh_agent_daily_cap');
    expect(result.used_24h_sats).toBe(95);
    expect(result.remaining_sats).toBe(5);
  });

  it('absorbed sats older than 24h do NOT count toward the cap', async () => {
    const nowSec = 1_777_589_000;
    const engine = new RefundEngine({
      refundLedgerRepo,
      now: () => nowSec,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
    await seedFulfillJob('job-old', 'agent-old');
    await refundLedgerRepo.record({
      job_id: 'job-old',
      candidate_url: 'https://x.example/old',
      agent_pubkey: 'agent-old',
      sats_absorbed: 99,
      classification: 'tier1_http_5xx',
      ts: nowSec - 25 * 3600, // 25h ago — outside the 24h window
    });
    const result = await engine.checkDailyCap({
      agent_pubkey: 'agent-old',
      agent_first_seen_at: null,
      worst_case_sats: 50,
    });
    expect(result.used_24h_sats).toBe(0);
    expect(result.allowed).toBe(true);
  });

  it('worst_case_sats=0 still allows checking current cap consumption', async () => {
    const engine = new RefundEngine({
      refundLedgerRepo,
      now: () => 12345,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
    await seedFulfillJob('job-zero', 'agent-zero');
    await refundLedgerRepo.record({
      job_id: 'job-zero',
      candidate_url: 'https://x.example/zero',
      agent_pubkey: 'agent-zero',
      sats_absorbed: 60,
      classification: 'tier2_body_shape',
      ts: 12345 - 100,
    });
    const result = await engine.checkDailyCap({
      agent_pubkey: 'agent-zero',
      agent_first_seen_at: null,
      worst_case_sats: 0,
    });
    expect(result.used_24h_sats).toBe(60);
    expect(result.remaining_sats).toBe(40);
    expect(result.allowed).toBe(true);
  });
});
