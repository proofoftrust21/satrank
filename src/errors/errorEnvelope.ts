// Phase 11A.2 (2026-05-04) — structured error envelope.
//
// Per autonomy audit 2026-05-04 (lens L4 Failure recovery, sev-5 gap
// "no-programmatic-next-action-hints"). Sim 13 a02 finance lane bricked
// because the agent received a generic error, hardcoded a per-release
// recovery strategy, and could not autonomously decide to widen its
// search or abandon the lane. Each error now carries a typed next_action
// hint the SDK can turn into an executable strategy.
//
// USAGE PATTERN
//
//   import { sendError } from '../errors/errorEnvelope';
//
//   sendError(res, 'invalid_auth');
//   sendError(res, 'pay_invoice_replayed', { retry_after_ms: 5_000 });
//
// The (additive) envelope shape is :
//   {
//     "error": "<machine-readable code>",
//     "message": "<human-readable description>",
//     "next_action": "retry" | "retry_other_operator" | ...,
//     "retry_after_ms"?: number,
//     "evidence_ref"?: string,
//     "details"?: <free-form, only when caller passes it>,
//     "requestId"?: "<reqId from middleware if available>"
//   }
//
// BACKWARDS COMPATIBILITY
//
// The existing routes returned `{ error: "<code>" }` or
// `{ error: "<code>", message: "..." }`. This envelope is ADDITIVE :
// `error` stays a string (the code), and we add `next_action`,
// `retry_after_ms`, `evidence_ref` as siblings. Tests that assert
// `body.error === 'invalid_auth'` keep passing ; SDK 1.6 reads the new
// fields ; pre-1.6 SDKs ignore them. Zero breaking change for callers.

import type { Response, Request } from 'express';

/**
 * What the agent should do in response to this error. Six values cover
 * every recovery path in the audit's L4 lens :
 *
 *   - `retry`                 : transient, same operator, wait + retry
 *   - `retry_other_operator`  : this operator misbehaving, ask intent again
 *   - `blacklist_operator`    : sustained pattern of failure, persist locally
 *   - `claim_bond`            : delivery violation, file claim against bond
 *   - `abort_lane`            : whole category failing, change strategy
 *   - `wait`                  : transient infra issue, exponential backoff
 */
export type NextAction =
  | 'retry'
  | 'retry_other_operator'
  | 'blacklist_operator'
  | 'claim_bond'
  | 'abort_lane'
  | 'wait';

/** Machine-readable codes, grouped by surface. The set is closed so SDKs
 *  can switch on them exhaustively. New codes require a code-side bump. */
export type ErrorCode =
  // ===== auth / shape =====
  | 'invalid_auth'                  // NIP-98 missing or signature failed
  | 'invalid_body'                  // Zod validation failed
  | 'invalid_job_id'                // path param malformed
  | 'invalid_pubkey'                // hex check failed
  | 'invalid_intent_hash'           // job rebound to wrong job_id
  | 'invalid_registration'          // operator registration shape gate failed
  | 'operator_pubkey_mismatch'      // NIP-98 pubkey ≠ declared operator_pubkey
  // ===== state / lifecycle =====
  | 'fulfill_disabled'              // FULFILL_ENABLED=false
  | 'operator_registration_disabled'// FULFILL_ENABLED=false (Phase 10)
  | 'pool_circuit_breaker_open'     // pool absorption exceeded threshold
  | 'agent_balance_insufficient'    // token_balance v1 short
  | 'job_not_found'                 // /execute against unknown job
  | 'job_already_settled'           // idempotency race
  | 'job_expired'                   // hold invoice past expiry
  // ===== rate-limit / SLA =====
  | 'rate_limited'                  // 30/min cap hit
  | 'sla_unreachable'               // max_latency_ms < min budget
  | 'aborted_for_sla'               // pre-pay deadline gate fired
  // ===== external dependencies =====
  | 'lnd_unavailable'               // node down / RPC error
  | 'pay_invoice_replayed'          // operator returned pre-existing payment_hash
  | 'no_candidates'                 // intentService returned 0
  | 'all_candidates_failed'         // every attempt failed
  | 'recall_network_error'          // tier-1 HTTP error in recall
  | 'recall_5xx'                    // tier-1 5xx in recall
  | 'recall_4xx'                    // tier-1 4xx in recall (operator-side)
  | 'delivery_validator_violation'  // 200 + non-conforming body shape
  | 'delivery_low_quality'          // 200 + heuristic mismatch
  | 'delivery_empty_body'           // 200 + empty
  // ===== claim / dispute (Phase 7) =====
  | 'claim_not_found'
  | 'claim_already_paid'
  | 'claim_dispute_window_expired'
  // ===== generic =====
  | 'internal_error';

interface ErrorRule {
  next_action: NextAction;
  /** Default HTTP status if caller doesn't override. */
  http_status: number;
  /** Default message if caller doesn't override. */
  message: string;
  /** When set, instructs the agent to wait this many ms before retrying.
   *  Caller can still override per-call. */
  retry_after_ms?: number;
}

const RULES: Record<ErrorCode, ErrorRule> = {
  invalid_auth:                   { next_action: 'abort_lane',          http_status: 401, message: 'NIP-98 authentication missing or invalid' },
  invalid_body:                   { next_action: 'abort_lane',          http_status: 400, message: 'request body did not match the schema' },
  invalid_job_id:                 { next_action: 'abort_lane',          http_status: 400, message: 'job_id is malformed' },
  invalid_pubkey:                 { next_action: 'abort_lane',          http_status: 400, message: 'pubkey is malformed' },
  invalid_intent_hash:            { next_action: 'abort_lane',          http_status: 400, message: 'intent_hash does not match the job' },
  invalid_registration:           { next_action: 'abort_lane',          http_status: 400, message: 'operator registration shape gate failed' },
  operator_pubkey_mismatch:       { next_action: 'abort_lane',          http_status: 403, message: 'NIP-98 pubkey must match operator_pubkey field' },
  fulfill_disabled:               { next_action: 'abort_lane',          http_status: 503, message: 'fulfill is disabled on this oracle' },
  operator_registration_disabled: { next_action: 'abort_lane',          http_status: 503, message: 'operator registration is disabled on this oracle' },
  pool_circuit_breaker_open:      { next_action: 'wait',                http_status: 503, message: 'pool circuit breaker is open — try again later', retry_after_ms: 60_000 },
  agent_balance_insufficient:     { next_action: 'abort_lane',          http_status: 402, message: 'agent balance insufficient — top up via /api/agent/deposit' },
  job_not_found:                  { next_action: 'abort_lane',          http_status: 404, message: 'job_id is unknown to this oracle' },
  job_already_settled:            { next_action: 'retry',               http_status: 409, message: 'job is already settled — read /api/fulfill/:job_id for the result' },
  job_expired:                    { next_action: 'retry',               http_status: 410, message: 'hold invoice expired before settlement' },
  rate_limited:                   { next_action: 'wait',                http_status: 429, message: 'agent rate-limit reached', retry_after_ms: 5_000 },
  sla_unreachable:                { next_action: 'abort_lane',          http_status: 400, message: 'max_latency_ms is below the minimum budget — cannot guarantee SLA' },
  aborted_for_sla:                { next_action: 'retry_other_operator',http_status: 504, message: 'pre-pay deadline elapsed before LND settle' },
  lnd_unavailable:                { next_action: 'wait',                http_status: 502, message: 'LND RPC is unavailable', retry_after_ms: 30_000 },
  pay_invoice_replayed:           { next_action: 'retry_other_operator',http_status: 502, message: 'operator returned a pre-existing payment_hash — likely replay attack', retry_after_ms: 5_000 },
  no_candidates:                  { next_action: 'abort_lane',          http_status: 404, message: '/api/intent returned no candidates for this category' },
  all_candidates_failed:          { next_action: 'retry_other_operator',http_status: 502, message: 'all attempts failed — try a different category or wait' },
  recall_network_error:           { next_action: 'retry_other_operator',http_status: 502, message: 'tier-1 HTTP error during recall' },
  recall_5xx:                     { next_action: 'retry_other_operator',http_status: 502, message: 'operator endpoint returned 5xx during recall' },
  recall_4xx:                     { next_action: 'blacklist_operator',  http_status: 502, message: 'operator endpoint returned 4xx during recall — likely schema mismatch on operator side' },
  delivery_validator_violation:   { next_action: 'claim_bond',          http_status: 502, message: 'operator returned 200 with non-conforming body — bond claim available' },
  delivery_low_quality:           { next_action: 'retry_other_operator',http_status: 502, message: 'operator returned 200 but body did not match expected shape' },
  delivery_empty_body:            { next_action: 'retry_other_operator',http_status: 502, message: 'operator returned empty body' },
  claim_not_found:                { next_action: 'abort_lane',          http_status: 404, message: 'claim_id is unknown' },
  claim_already_paid:             { next_action: 'abort_lane',          http_status: 409, message: 'claim has already been settled' },
  claim_dispute_window_expired:   { next_action: 'abort_lane',          http_status: 410, message: '24h dispute window has elapsed' },
  internal_error:                 { next_action: 'wait',                http_status: 500, message: 'internal error — see requestId for log lookup', retry_after_ms: 10_000 },
};

export interface SendErrorOpts {
  /** Override the default HTTP status. */
  http_status?: number;
  /** Override the default message. */
  message?: string;
  /** Hint to the agent about when to retry, in ms. */
  retry_after_ms?: number;
  /** Pointer back to the evidence bundle (Phase 8) when relevant. */
  evidence_ref?: string;
  /** Free-form extra payload, e.g. zod issues, lookup result. */
  details?: unknown;
}

/** Flat additive envelope. `error` stays a string (the code) so existing
 *  assertions keep passing ; the rest is new. */
export interface ErrorEnvelope {
  error: ErrorCode;
  message: string;
  next_action: NextAction;
  retry_after_ms?: number;
  evidence_ref?: string;
  details?: unknown;
  requestId?: string;
}

export function buildErrorEnvelope(code: ErrorCode, opts: SendErrorOpts = {}, requestId?: string): ErrorEnvelope {
  const rule = RULES[code];
  const env: ErrorEnvelope = {
    error: code,
    message: opts.message ?? rule.message,
    next_action: rule.next_action,
  };
  const retry = opts.retry_after_ms ?? rule.retry_after_ms;
  if (retry !== undefined) env.retry_after_ms = retry;
  if (opts.evidence_ref !== undefined) env.evidence_ref = opts.evidence_ref;
  if (opts.details !== undefined) env.details = opts.details;
  if (requestId !== undefined) env.requestId = requestId;
  return env;
}

export function sendError(res: Response, code: ErrorCode, opts: SendErrorOpts = {}): void {
  const rule = RULES[code];
  const httpStatus = opts.http_status ?? rule.http_status;
  // Pull requestId from the request if the upstream middleware attached one.
  const req = (res as Response & { req?: Request & { requestId?: string } }).req;
  const requestId = req?.requestId;
  res.status(httpStatus).json(buildErrorEnvelope(code, opts, requestId));
}

/** Map a fulfillService refund-path `reason` string to a NextAction so a
 *  refunded response (HTTP 502, status='refunded') can still hint the agent
 *  about recovery without changing the existing payload shape. */
export function reasonToNextAction(reason: string | null | undefined): NextAction {
  if (!reason) return 'retry_other_operator';
  if (reason === 'job_not_found') return 'abort_lane';
  if (reason === 'wrong_mode') return 'abort_lane';
  if (reason === 'owner_mismatch') return 'abort_lane';
  if (reason === 'no_candidates') return 'abort_lane';
  if (reason === 'max_latency_unreachable') return 'abort_lane';
  if (reason === 'all_candidates_failed') return 'retry_other_operator';
  if (reason.startsWith('refund_bolt11')) return 'abort_lane';
  if (reason === 'pool_circuit_breaker_open') return 'wait';
  if (reason === 'agent_balance_insufficient') return 'abort_lane';
  return 'retry_other_operator';
}

/** Map an internal fulfillService outcome to the matching error code.
 *  Used by /api/fulfill when an attempt set ends in failure to expose
 *  the dominant failure mode. */
export function fulfillOutcomeToErrorCode(
  payment_outcome: string | null,
  delivery_outcome: string | null,
): ErrorCode {
  if (payment_outcome === 'pay_invoice_replayed') return 'pay_invoice_replayed';
  if (payment_outcome === 'aborted_for_sla') return 'aborted_for_sla';
  if (delivery_outcome === 'delivery_validator_violation') return 'delivery_validator_violation';
  if (delivery_outcome === 'delivery_low_quality') return 'delivery_low_quality';
  if (delivery_outcome === 'delivery_empty_body') return 'delivery_empty_body';
  if (delivery_outcome === 'delivery_5xx') return 'recall_5xx';
  if (delivery_outcome === 'delivery_4xx') return 'recall_4xx';
  if (delivery_outcome === 'recall_network_error') return 'recall_network_error';
  return 'all_candidates_failed';
}
