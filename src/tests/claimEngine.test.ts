// Phase 7.3 + 7.5 — ClaimEngine + bond/claim repository integration tests.
// Covers: open claim on Tier 2 outcome, idempotency, bond not found, payout cron,
// dispute filing, classification mapping, validator violation 5x multiplier.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { OperatorBondRepository } from '../repositories/operatorBondRepository';
import { AgentClaimRepository } from '../repositories/agentClaimRepository';
import { ClaimEngine, classifyDeliveryOutcome } from '../services/claimEngine';
import type { FulfillJob, FulfillAttempt } from '../repositories/fulfillJobRepository';

let testDb: TestDb;
let pool: Pool;
let bondRepo: OperatorBondRepository;
let claimRepo: AgentClaimRepository;
let engine: ClaimEngine;

const OPERATOR = '02operator0000000000000000000000000000000000000000000000000000000000';
const AGENT = 'agent-test-pubkey';
const NOW = 1_700_000_000;

describe('ClaimEngine + bond/claim repos (Phase 7.3 + 7.5)', () => {
  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    bondRepo = new OperatorBondRepository(pool);
    claimRepo = new AgentClaimRepository(pool);
    engine = new ClaimEngine({ pool, claimRepo, bondRepo, now: () => NOW });
  });

  afterAll(async () => { await teardownTestPool(testDb); });

  beforeEach(async () => {
    await pool.query('TRUNCATE agent_claims, operator_bonds RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE fulfill_jobs RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE token_balance');
  });

  // ----- classifyDeliveryOutcome -----

  it('classifyDeliveryOutcome — pay_ok + delivery_low_quality → tier2_body_shape', () => {
    expect(classifyDeliveryOutcome('delivery_low_quality', 'pay_ok')).toBe('tier2_body_shape');
  });
  it('classifyDeliveryOutcome — non-paid attempts return null (no claim)', () => {
    expect(classifyDeliveryOutcome('delivery_low_quality', 'pay_routing_failed')).toBe(null);
  });
  it('classifyDeliveryOutcome — delivery_ok returns null (no claim on success)', () => {
    expect(classifyDeliveryOutcome('delivery_ok', 'pay_ok')).toBe(null);
  });
  it('classifyDeliveryOutcome — recall_body_read_error → tier1_recall_network_error', () => {
    expect(classifyDeliveryOutcome('recall_body_read_error', 'pay_ok')).toBe('tier1_recall_network_error');
  });
  it('classifyDeliveryOutcome — delivery_validator_violation → validator_violation (5x)', () => {
    expect(classifyDeliveryOutcome('delivery_validator_violation', 'pay_ok')).toBe('validator_violation');
  });

  // ----- bond reservation/slashing atomicity -----

  it('bond reservePending refuses over-reservation', async () => {
    const bond = await bondRepo.create({
      operator_pubkey: OPERATOR,
      bond_payment_hash: 'h1',
      bond_committed_sats: 100,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await bondRepo.reservePending(bond.bond_id, 80)).toBe(true);
    expect(await bondRepo.reservePending(bond.bond_id, 30)).toBe(false);  // 80+30 > 100
    expect(await bondRepo.reservePending(bond.bond_id, 20)).toBe(true);   // 80+20 = 100
    const refreshed = await bondRepo.findById(bond.bond_id);
    expect(refreshed?.bond_pending_sats).toBe(100);
    expect(refreshed?.bond_slashed_sats).toBe(0);
  });

  it('bond commitSlash converts pending to slashed atomically', async () => {
    const bond = await bondRepo.create({
      operator_pubkey: OPERATOR,
      bond_payment_hash: 'h2',
      bond_committed_sats: 100,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    await bondRepo.reservePending(bond.bond_id, 30);
    expect(await bondRepo.commitSlash(bond.bond_id, 30, NOW + 1)).toBe(true);
    const r = await bondRepo.findById(bond.bond_id);
    expect(r?.bond_pending_sats).toBe(0);
    expect(r?.bond_slashed_sats).toBe(30);
  });

  it('bond commitSlash refuses over-slash beyond pending', async () => {
    const bond = await bondRepo.create({
      operator_pubkey: OPERATOR,
      bond_payment_hash: 'h3',
      bond_committed_sats: 100,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    await bondRepo.reservePending(bond.bond_id, 10);
    expect(await bondRepo.commitSlash(bond.bond_id, 50, NOW + 1)).toBe(false);
  });

  // ----- ClaimEngine open claim -----

  async function seedJobAndBond(): Promise<{ job: FulfillJob; bondId: number }> {
    await pool.query(
      `INSERT INTO fulfill_jobs (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms, status, attempts, sats_spent, sats_refunded, premium_sats, created_at, mode)
       VALUES ('11111111-1111-1111-1111-111111111111', $1, 'h', 100, 8000, 'success', '[]'::jsonb, 0, 0, 0, $2, 'deposit')`,
      [AGENT, NOW],
    );
    const bond = await bondRepo.create({
      operator_pubkey: OPERATOR,
      bond_payment_hash: 'hbond',
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const job: FulfillJob = {
      job_id: '11111111-1111-1111-1111-111111111111',
      agent_pubkey: AGENT, intent_hash: 'h', max_sats: 100, max_latency_ms: 8000,
      status: 'success', attempts: [], sats_spent: 0, sats_refunded: 0, premium_sats: 0,
      preimage: null, result_body_sha256: null, reason: null, created_at: NOW, settled_at: NOW,
      mode: 'deposit', hold_invoice_payment_request: null, hold_invoice_payment_hash: null,
      hold_invoice_preimage: null, hold_invoice_state: null, hold_invoice_expires_at: null,
      refund_bolt11: null, refund_state: null, refund_amount_sats: null,
      refund_payment_preimage: null, refund_attempts: 0, refund_last_error: null, refund_settled_at: null,
    };
    return { job, bondId: bond.bond_id };
  }

  it('openClaimForAttempt — Tier 2 body_shape opens pending claim with 2× multiplier', async () => {
    const { job, bondId } = await seedJobAndBond();
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1,
      ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_low_quality',
      http_status: 200, sats_paid: 10, operator_pubkey: OPERATOR,
    };
    const claim = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    expect(claim).not.toBeNull();
    expect(claim?.classification).toBe('tier2_body_shape');
    expect(claim?.sats_paid_to_agent).toBe(20);   // 10 × 2
    expect(claim?.sats_slashed_from_bond).toBe(30); // 10 × 2 × 1.5 buffer
    expect(claim?.state).toBe('pending');
    expect(claim?.dispute_until).toBe(NOW + 24 * 3600);
    const refreshedBond = await bondRepo.findById(bondId);
    expect(refreshedBond?.bond_pending_sats).toBe(30);
  });

  it('openClaimForAttempt — validator_violation flag → 5× multiplier', async () => {
    const { job } = await seedJobAndBond();
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1,
      ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_validator_violation',
      http_status: 200, sats_paid: 10, operator_pubkey: OPERATOR,
    };
    const claim = await engine.openClaimForAttempt({
      job, attempt_index: 0, attempt,
      validator_violation_reason: 'has_field:text failed',
    });
    expect(claim?.classification).toBe('validator_violation');
    expect(claim?.sats_paid_to_agent).toBe(50);     // 10 × 5
    expect(claim?.sats_slashed_from_bond).toBe(75); // 10 × 5 × 1.5
  });

  it('openClaimForAttempt — idempotent on (job_id, attempt_index)', async () => {
    const { job } = await seedJobAndBond();
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1,
      ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_low_quality',
      http_status: 200, sats_paid: 10, operator_pubkey: OPERATOR,
    };
    const a = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    const b = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    expect(a?.claim_id).toBe(b?.claim_id);
  });

  it('openClaimForAttempt — operator with no bond → returns null (no claim)', async () => {
    await pool.query(
      `INSERT INTO fulfill_jobs (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms, status, attempts, sats_spent, sats_refunded, premium_sats, created_at, mode)
       VALUES ('22222222-2222-2222-2222-222222222222', $1, 'h', 100, 8000, 'success', '[]'::jsonb, 0, 0, 0, $2, 'deposit')`,
      [AGENT, NOW],
    );
    const job: FulfillJob = {
      job_id: '22222222-2222-2222-2222-222222222222',
      agent_pubkey: AGENT, intent_hash: 'h', max_sats: 100, max_latency_ms: 8000,
      status: 'success', attempts: [], sats_spent: 0, sats_refunded: 0, premium_sats: 0,
      preimage: null, result_body_sha256: null, reason: null, created_at: NOW, settled_at: NOW,
      mode: 'deposit', hold_invoice_payment_request: null, hold_invoice_payment_hash: null,
      hold_invoice_preimage: null, hold_invoice_state: null, hold_invoice_expires_at: null,
      refund_bolt11: null, refund_state: null, refund_amount_sats: null,
      refund_payment_preimage: null, refund_attempts: 0, refund_last_error: null, refund_settled_at: null,
    };
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1, ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_low_quality',
      http_status: 200, sats_paid: 10, operator_pubkey: 'unbonded-operator',
    };
    const claim = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    expect(claim).toBeNull();
  });

  // ----- payout cron -----

  it('payoutReadyClaims — past dispute window → bond slashed + agent credited', async () => {
    const { job, bondId } = await seedJobAndBond();
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1, ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_low_quality',
      http_status: 200, sats_paid: 10, operator_pubkey: OPERATOR,
    };
    const claim = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    expect(claim).not.toBeNull();
    // Force the dispute_until into the past via a direct update.
    await pool.query('UPDATE agent_claims SET dispute_until = $1', [NOW - 1]);
    const out = await engine.payoutReadyClaims();
    expect(out.paid).toBe(1);
    expect(out.failed).toBe(0);
    const finalBond = await bondRepo.findById(bondId);
    expect(finalBond?.bond_pending_sats).toBe(0);
    expect(finalBond?.bond_slashed_sats).toBe(30);
    const balance = await pool.query<{ b: string }>(
      'SELECT balance_credits::text AS b FROM token_balance WHERE payment_hash = $1',
      [AGENT],
    );
    expect(Number(balance.rows[0]?.b ?? 0)).toBe(20);
  });

  // ----- dispute -----

  it('fileDispute transitions pending → disputed and prevents payout', async () => {
    const { job } = await seedJobAndBond();
    const attempt: FulfillAttempt = {
      candidate_url: 'https://x.example/api', rank: 1, ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: 'delivery_low_quality',
      http_status: 200, sats_paid: 10, operator_pubkey: OPERATOR,
    };
    const claim = await engine.openClaimForAttempt({ job, attempt_index: 0, attempt });
    if (!claim) throw new Error('expected claim');
    expect(await claimRepo.fileDispute(claim.claim_id, NOW + 100)).toBe(true);
    // Even past dispute window, disputed claims do NOT pay out (cron filters state=pending).
    await pool.query('UPDATE agent_claims SET dispute_until = $1', [NOW - 1]);
    const out = await engine.payoutReadyClaims();
    expect(out.paid).toBe(0);
  });

  // ----- stats -----

  it('statsLast24h aggregates by state with sat totals', async () => {
    const { job } = await seedJobAndBond();
    const att = (i: number, sat: number, out: string): FulfillAttempt => ({
      candidate_url: `https://x${i}.example/api`, rank: i, ts_started: NOW, ts_finished: NOW,
      payment_outcome: 'pay_ok', delivery_outcome: out,
      http_status: 200, sats_paid: sat, operator_pubkey: OPERATOR,
    });
    await engine.openClaimForAttempt({ job, attempt_index: 0, attempt: att(1, 10, 'delivery_low_quality') });
    await engine.openClaimForAttempt({ job, attempt_index: 1, attempt: att(2, 20, 'delivery_5xx') });
    const stats = await claimRepo.statsLast24h(NOW + 60);
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
  });
});
