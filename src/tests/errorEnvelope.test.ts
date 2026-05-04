// Phase 11A.2 (2026-05-04) — error envelope tests.
//
// Validates that buildErrorEnvelope produces the expected next_action +
// retry_after_ms hints for each error code, and that fulfillOutcomeToErrorCode
// + reasonToNextAction map fulfillService outcomes to actionable codes.
import { describe, it, expect } from 'vitest';
import {
  buildErrorEnvelope,
  fulfillOutcomeToErrorCode,
  reasonToNextAction,
} from '../errors/errorEnvelope';

describe('Phase 11A.2 — error envelope', () => {
  it('invalid_auth → next_action=abort_lane, http hint preserved upstream', () => {
    const env = buildErrorEnvelope('invalid_auth');
    expect(env.error).toBe('invalid_auth');
    expect(env.next_action).toBe('abort_lane');
    expect(env.message).toMatch(/NIP-98 authentication missing/i);
    expect(env.retry_after_ms).toBeUndefined();
  });

  it('rate_limited → next_action=wait, retry_after_ms=5000 by default', () => {
    const env = buildErrorEnvelope('rate_limited');
    expect(env.next_action).toBe('wait');
    expect(env.retry_after_ms).toBe(5_000);
  });

  it('caller can override retry_after_ms', () => {
    const env = buildErrorEnvelope('rate_limited', { retry_after_ms: 30_000 });
    expect(env.retry_after_ms).toBe(30_000);
  });

  it('pay_invoice_replayed → retry_other_operator', () => {
    const env = buildErrorEnvelope('pay_invoice_replayed');
    expect(env.next_action).toBe('retry_other_operator');
    expect(env.retry_after_ms).toBe(5_000);
  });

  it('delivery_validator_violation → claim_bond (Phase 7 ClaimEngine 5x)', () => {
    const env = buildErrorEnvelope('delivery_validator_violation');
    expect(env.next_action).toBe('claim_bond');
  });

  it('recall_4xx → blacklist_operator (operator-side schema mismatch)', () => {
    const env = buildErrorEnvelope('recall_4xx');
    expect(env.next_action).toBe('blacklist_operator');
  });

  it('pool_circuit_breaker_open → wait, retry_after_ms=60000', () => {
    const env = buildErrorEnvelope('pool_circuit_breaker_open');
    expect(env.next_action).toBe('wait');
    expect(env.retry_after_ms).toBe(60_000);
  });

  it('caller can override message', () => {
    const env = buildErrorEnvelope('invalid_body', { message: 'custom reason' });
    expect(env.message).toBe('custom reason');
  });

  it('caller can attach details + evidence_ref', () => {
    const env = buildErrorEnvelope('delivery_validator_violation', {
      evidence_ref: 'evidence:abc123',
      details: { stage: 4 },
    });
    expect(env.evidence_ref).toBe('evidence:abc123');
    expect(env.details).toEqual({ stage: 4 });
  });

  it('requestId is propagated when supplied', () => {
    const env = buildErrorEnvelope('internal_error', {}, 'req-xyz');
    expect(env.requestId).toBe('req-xyz');
  });

  it('error field stays a string for back-compat', () => {
    const env = buildErrorEnvelope('invalid_auth');
    expect(typeof env.error).toBe('string');
    expect(env.error).toBe('invalid_auth');
  });
});

describe('Phase 11A.2 — fulfillOutcomeToErrorCode', () => {
  it('pay_invoice_replayed maps directly', () => {
    expect(fulfillOutcomeToErrorCode('pay_invoice_replayed', null)).toBe('pay_invoice_replayed');
  });

  it('delivery_validator_violation overrides delivery channel', () => {
    expect(fulfillOutcomeToErrorCode('pay_ok', 'delivery_validator_violation')).toBe('delivery_validator_violation');
  });

  it('aborted_for_sla outcome → aborted_for_sla code', () => {
    expect(fulfillOutcomeToErrorCode('aborted_for_sla', null)).toBe('aborted_for_sla');
  });

  it('delivery_5xx → recall_5xx', () => {
    expect(fulfillOutcomeToErrorCode('pay_ok', 'delivery_5xx')).toBe('recall_5xx');
  });

  it('delivery_4xx → recall_4xx (operator side)', () => {
    expect(fulfillOutcomeToErrorCode('pay_ok', 'delivery_4xx')).toBe('recall_4xx');
  });

  it('falls through to all_candidates_failed when nothing matches', () => {
    expect(fulfillOutcomeToErrorCode(null, null)).toBe('all_candidates_failed');
    expect(fulfillOutcomeToErrorCode('unknown', 'unknown')).toBe('all_candidates_failed');
  });
});

describe('Phase 11A.2 — reasonToNextAction', () => {
  it('terminal reasons → abort_lane', () => {
    expect(reasonToNextAction('job_not_found')).toBe('abort_lane');
    expect(reasonToNextAction('wrong_mode')).toBe('abort_lane');
    expect(reasonToNextAction('owner_mismatch')).toBe('abort_lane');
    expect(reasonToNextAction('no_candidates')).toBe('abort_lane');
    expect(reasonToNextAction('max_latency_unreachable')).toBe('abort_lane');
    expect(reasonToNextAction('refund_bolt11 must be open-amount')).toBe('abort_lane');
    expect(reasonToNextAction('agent_balance_insufficient')).toBe('abort_lane');
  });

  it('all_candidates_failed → retry_other_operator (the Sim 13 case)', () => {
    expect(reasonToNextAction('all_candidates_failed')).toBe('retry_other_operator');
  });

  it('pool_circuit_breaker_open → wait', () => {
    expect(reasonToNextAction('pool_circuit_breaker_open')).toBe('wait');
  });

  it('null/undefined fall back to retry_other_operator', () => {
    expect(reasonToNextAction(null)).toBe('retry_other_operator');
    expect(reasonToNextAction(undefined)).toBe('retry_other_operator');
  });
});
