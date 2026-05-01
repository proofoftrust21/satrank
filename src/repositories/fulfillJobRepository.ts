// Phase 1 (2026-05-01) — durable storage for /api/fulfill jobs.
//
// One row per fulfill request. Each row carries the full attempt history
// in `attempts` JSONB so the agent (and audit) can replay exactly which
// candidates were tried and how they responded — this is the load-bearing
// audit-trail primitive that makes compliance missions possible (see
// project_fulfill_proxy_plan.md mission #3).
//
// State machine:
//   in_flight  → success | refunded | aborted   (terminal)
//   success    → terminal
//   refunded   → terminal
//   aborted    → terminal
//
// Idempotency: same agent + same intent_hash + same max_sats inside a 60s
// window must reuse the prior job. Caller (FulfillService) checks first,
// falls through to a fresh insert otherwise.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type FulfillStatus = 'in_flight' | 'success' | 'refunded' | 'aborted';

export type FulfillMode = 'deposit' | 'hold';

export type HoldInvoiceState =
  | 'awaiting_payment'
  | 'accepted'
  | 'settled'
  | 'cancelled'
  | 'expired';

/** A single attempt against one candidate, persisted in attempts[]. The
 *  outcome strings reuse paidProbeRunner's vocabulary for consistency
 *  across the codebase (helps grep + log correlation). */
export interface FulfillAttempt {
  candidate_url: string;
  rank: number;
  ts_started: number;
  ts_finished: number;
  payment_outcome: string;
  delivery_outcome: string;
  http_status: number | null;
  sats_paid: number;
  preimage?: string;
  detail?: string;
}

export interface FulfillJob {
  job_id: string;
  agent_pubkey: string;
  intent_hash: string;
  max_sats: number;
  max_latency_ms: number;
  status: FulfillStatus;
  attempts: FulfillAttempt[];
  sats_spent: number;
  sats_refunded: number;
  premium_sats: number;
  preimage: string | null;
  result_body_sha256: string | null;
  reason: string | null;
  created_at: number;
  settled_at: number | null;
  /** Phase 6 — fulfill mode picked at create time. 'deposit' uses the
   *  custodial token_balance flow (Phase 1); 'hold' uses a Lightning hold
   *  invoice the agent pays per-call (non-custodial). */
  mode: FulfillMode;
  /** Phase 6 — hold-invoice fields (null when mode='deposit'). */
  hold_invoice_payment_request: string | null;
  hold_invoice_payment_hash: string | null;
  /** Stored only server-side; never returned to the agent before settle. */
  hold_invoice_preimage: string | null;
  hold_invoice_state: HoldInvoiceState | null;
  hold_invoice_expires_at: number | null;
}

export interface CreateJobInput {
  job_id: string;
  agent_pubkey: string;
  intent_hash: string;
  max_sats: number;
  max_latency_ms: number;
  created_at: number;
  /** Phase 6 — defaults to 'deposit' for back-compat. */
  mode?: FulfillMode;
  /** Phase 6 — populated only when mode='hold'. */
  hold_invoice_payment_request?: string;
  hold_invoice_payment_hash?: string;
  hold_invoice_preimage?: string;
  hold_invoice_state?: HoldInvoiceState;
  hold_invoice_expires_at?: number;
}

export interface SettleSuccessInput {
  job_id: string;
  attempts: FulfillAttempt[];
  sats_spent: number;
  premium_sats: number;
  preimage: string;
  result_body_sha256: string;
  settled_at: number;
}

export interface SettleRefundInput {
  job_id: string;
  attempts: FulfillAttempt[];
  reason: string;
  settled_at: number;
}

export interface SettleAbortInput {
  job_id: string;
  reason: string;
  settled_at: number;
  /** Best-effort partial attempts captured before the abort. */
  attempts?: FulfillAttempt[];
}

export class FulfillJobRepository {
  constructor(private db: Queryable) {}

  /** Idempotency window — a job within the last `windowSec` seconds whose
   *  (agent_pubkey, intent_hash, max_sats) match returns the existing row.
   *  The caller decides whether to reuse the result or 409 on in_flight. */
  async findRecentForIdempotency(
    agentPubkey: string,
    intentHash: string,
    maxSats: number,
    windowSec: number,
    nowSec: number,
  ): Promise<FulfillJob | null> {
    const cutoff = nowSec - windowSec;
    const { rows } = await this.db.query<FulfillJobRow>(
      `SELECT * FROM fulfill_jobs
       WHERE agent_pubkey = $1
         AND intent_hash = $2
         AND max_sats = $3
         AND created_at >= $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [agentPubkey, intentHash, maxSats, cutoff],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async findById(jobId: string): Promise<FulfillJob | null> {
    const { rows } = await this.db.query<FulfillJobRow>(
      'SELECT * FROM fulfill_jobs WHERE job_id = $1',
      [jobId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async create(input: CreateJobInput): Promise<void> {
    await this.db.query(
      `INSERT INTO fulfill_jobs
        (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms,
         status, attempts, sats_spent, sats_refunded, premium_sats, created_at,
         mode, hold_invoice_payment_request, hold_invoice_payment_hash,
         hold_invoice_preimage, hold_invoice_state, hold_invoice_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_flight', '[]'::jsonb, 0, 0, 0, $6,
               $7, $8, $9, $10, $11, $12)`,
      [
        input.job_id,
        input.agent_pubkey,
        input.intent_hash,
        input.max_sats,
        input.max_latency_ms,
        input.created_at,
        input.mode ?? 'deposit',
        input.hold_invoice_payment_request ?? null,
        input.hold_invoice_payment_hash ?? null,
        input.hold_invoice_preimage ?? null,
        input.hold_invoice_state ?? null,
        input.hold_invoice_expires_at ?? null,
      ],
    );
  }

  /** Phase 6 — update hold invoice state without touching the orchestrator
   *  status. Used when LND reports the invoice transitioned (awaiting →
   *  accepted, accepted → settled, etc.). Returns the new row. */
  async setHoldInvoiceState(jobId: string, state: HoldInvoiceState): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE fulfill_jobs SET hold_invoice_state = $2 WHERE job_id = $1',
      [jobId, state],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Phase 6 — find hold-mode jobs that are still awaiting/accepted past
   *  their expires_at. Used by the reconciliation cron to issue cancel
   *  before LND auto-expires. */
  async findExpiredHoldInvoices(nowSec: number): Promise<FulfillJob[]> {
    const { rows } = await this.db.query<FulfillJobRow>(
      `SELECT * FROM fulfill_jobs
       WHERE mode = 'hold'
         AND hold_invoice_state IN ('awaiting_payment', 'accepted')
         AND hold_invoice_expires_at IS NOT NULL
         AND hold_invoice_expires_at < $1
       ORDER BY hold_invoice_expires_at ASC
       LIMIT 50`,
      [nowSec],
    );
    return rows.map(rowToJob);
  }

  /** Atomic settle from `in_flight` → `success`. Refuses to update a job
   *  that is already terminal (status state-machine guard). */
  async settleSuccess(input: SettleSuccessInput): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE fulfill_jobs
         SET status = 'success',
             attempts = $2::jsonb,
             sats_spent = $3,
             premium_sats = $4,
             preimage = $5,
             result_body_sha256 = $6,
             settled_at = $7
       WHERE job_id = $1 AND status = 'in_flight'`,
      [
        input.job_id,
        JSON.stringify(input.attempts),
        input.sats_spent,
        input.premium_sats,
        input.preimage,
        input.result_body_sha256,
        input.settled_at,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  async settleRefund(input: SettleRefundInput): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE fulfill_jobs
         SET status = 'refunded',
             attempts = $2::jsonb,
             reason = $3,
             settled_at = $4
       WHERE job_id = $1 AND status = 'in_flight'`,
      [
        input.job_id,
        JSON.stringify(input.attempts),
        input.reason,
        input.settled_at,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  async settleAbort(input: SettleAbortInput): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE fulfill_jobs
         SET status = 'aborted',
             attempts = COALESCE($2::jsonb, attempts),
             reason = $3,
             settled_at = $4
       WHERE job_id = $1 AND status = 'in_flight'`,
      [
        input.job_id,
        input.attempts ? JSON.stringify(input.attempts) : null,
        input.reason,
        input.settled_at,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Reconciliation cron — return jobs stuck in `in_flight` past the
   *  expected end-of-life window (max_latency × 2 + safety margin). */
  async findStuckInFlight(nowSec: number, marginSec: number): Promise<FulfillJob[]> {
    const { rows } = await this.db.query<FulfillJobRow>(
      `SELECT * FROM fulfill_jobs
       WHERE status = 'in_flight'
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT 50`,
      [nowSec - marginSec],
    );
    return rows.map(rowToJob);
  }

  /** Recent counters for /api/oracle/fulfill (privacy-preserving — never
   *  exposes agent_pubkey). */
  async statsLast24h(nowSec: number): Promise<{
    total: number;
    success: number;
    refunded: number;
    aborted: number;
    in_flight: number;
    sats_spent_total: number;
    premium_sats_total: number;
  }> {
    const cutoff = nowSec - 24 * 3600;
    const { rows } = await this.db.query<{
      status: FulfillStatus;
      c: string;
      sats_spent_total: string | null;
      premium_sats_total: string | null;
    }>(
      `SELECT status,
              COUNT(*)::text AS c,
              COALESCE(SUM(sats_spent), 0)::text AS sats_spent_total,
              COALESCE(SUM(premium_sats), 0)::text AS premium_sats_total
         FROM fulfill_jobs
        WHERE created_at >= $1
        GROUP BY status`,
      [cutoff],
    );
    const out = {
      total: 0,
      success: 0,
      refunded: 0,
      aborted: 0,
      in_flight: 0,
      sats_spent_total: 0,
      premium_sats_total: 0,
    };
    for (const r of rows) {
      const c = Number(r.c);
      out.total += c;
      out[r.status] = c;
      out.sats_spent_total += Number(r.sats_spent_total ?? 0);
      out.premium_sats_total += Number(r.premium_sats_total ?? 0);
    }
    return out;
  }
}

interface FulfillJobRow {
  job_id: string;
  agent_pubkey: string;
  intent_hash: string;
  max_sats: number;
  max_latency_ms: number;
  status: FulfillStatus;
  attempts: FulfillAttempt[] | string;
  sats_spent: number;
  sats_refunded: number;
  premium_sats: number;
  preimage: string | null;
  result_body_sha256: string | null;
  reason: string | null;
  created_at: number;
  settled_at: number | null;
  mode: FulfillMode | null;
  hold_invoice_payment_request: string | null;
  hold_invoice_payment_hash: string | null;
  hold_invoice_preimage: string | null;
  hold_invoice_state: HoldInvoiceState | null;
  hold_invoice_expires_at: number | null;
}

function rowToJob(row: FulfillJobRow): FulfillJob {
  // Postgres node-pg already deserializes JSONB to JS object; defensive parse
  // for tests / mocks that hand back the raw string.
  const attempts: FulfillAttempt[] =
    typeof row.attempts === 'string' ? JSON.parse(row.attempts) : (row.attempts ?? []);
  return {
    job_id: row.job_id,
    agent_pubkey: row.agent_pubkey,
    intent_hash: row.intent_hash,
    max_sats: Number(row.max_sats),
    max_latency_ms: Number(row.max_latency_ms),
    status: row.status,
    attempts,
    sats_spent: Number(row.sats_spent),
    sats_refunded: Number(row.sats_refunded),
    premium_sats: Number(row.premium_sats),
    preimage: row.preimage,
    result_body_sha256: row.result_body_sha256,
    reason: row.reason,
    created_at: Number(row.created_at),
    settled_at: row.settled_at != null ? Number(row.settled_at) : null,
    mode: row.mode ?? 'deposit',
    hold_invoice_payment_request: row.hold_invoice_payment_request,
    hold_invoice_payment_hash: row.hold_invoice_payment_hash,
    hold_invoice_preimage: row.hold_invoice_preimage,
    hold_invoice_state: row.hold_invoice_state,
    hold_invoice_expires_at:
      row.hold_invoice_expires_at != null ? Number(row.hold_invoice_expires_at) : null,
  };
}
