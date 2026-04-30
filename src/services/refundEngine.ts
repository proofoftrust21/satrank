// Phase 2 (2026-05-01) — RefundEngine.
//
// Central decision logic for the fulfill-proxy refund path. Three jobs:
//   1. Classify a fulfill attempt that paid an operator but didn't deliver
//      to the agent. Tier 1 (HTTP non-2xx) is auto-classified; Tier 2
//      (body-shape failure on 2xx) is also auto but operators can dispute.
//   2. Record each absorbed-sat event in refund_ledger (idempotent on
//      job_id + candidate_url).
//   3. Enforce the per-agent daily refund cap. Agents younger than
//      AGENT_AGE_FRESH_DAYS are limited to FRESH_AGENT_DAILY_CAP_SATS of
//      absorbed payments per 24h to prevent drain attacks.
//
// All public methods are pure functions of (input, repo) — no globals.
import { logger } from '../logger';
import type {
  RefundLedgerRepository,
  RefundClassification,
} from '../repositories/refundLedgerRepository';
import type { FulfillAttempt } from '../repositories/fulfillJobRepository';

/** Agents younger than this are considered "fresh" and get the strict
 *  daily refund cap. 30 days matches the Sim 7 follow-up sandbox windows
 *  and gives genuine new operators time to accumulate trust. */
const AGENT_AGE_FRESH_DAYS = 30;
const ONE_DAY_SEC = 24 * 3600;

export interface RefundEngineConfig {
  /** Cap on absorbed sats per agent per 24h for agents younger than
   *  AGENT_AGE_FRESH_DAYS. Default 100; overridable via env / deps. */
  freshAgentDailyCapSats: number;
  /** Cap for established agents (older than AGENT_AGE_FRESH_DAYS). Default
   *  10000 — generous but bounded so a compromised long-tenured key
   *  can't drain the pool overnight. */
  establishedAgentDailyCapSats: number;
}

export const DEFAULT_REFUND_ENGINE_CONFIG: RefundEngineConfig = {
  freshAgentDailyCapSats: parseInt(process.env.FULFILL_FRESH_AGENT_DAILY_CAP ?? '100', 10),
  establishedAgentDailyCapSats: parseInt(process.env.FULFILL_ESTABLISHED_DAILY_CAP ?? '10000', 10),
};

export interface RefundEngineDeps {
  refundLedgerRepo: RefundLedgerRepository;
  config?: RefundEngineConfig;
  now?: () => number;
}

export interface DailyCapCheckInput {
  agent_pubkey: string;
  /** First-seen timestamp for this agent (epoch seconds). Null when we have
   *  no record — treated as a fresh agent (strict cap). */
  agent_first_seen_at: number | null;
  /** Sats this fulfill might absorb in the worst case (sum of paid invoices
   *  across the candidates we'd attempt). The cap is reservation-aware. */
  worst_case_sats: number;
}

export interface DailyCapResult {
  allowed: boolean;
  cap_sats: number;
  used_24h_sats: number;
  remaining_sats: number;
  agent_age_bucket: 'fresh' | 'established';
  /** Set when allowed=false to explain to the caller / agent. */
  reason?: 'fresh_agent_daily_cap' | 'established_agent_daily_cap';
}

export class RefundEngine {
  private readonly config: RefundEngineConfig;
  private readonly now: () => number;

  constructor(private readonly deps: RefundEngineDeps) {
    this.config = deps.config ?? DEFAULT_REFUND_ENGINE_CONFIG;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Pure classifier: given a fulfill attempt's outcome, return the matching
   *  ledger classification or null when this attempt doesn't represent an
   *  absorbed payment (= we never paid, no refund event). */
  classifyAttempt(attempt: FulfillAttempt): RefundClassification | null {
    if (attempt.payment_outcome !== 'pay_ok') {
      // No sats were paid → no refund event.
      return null;
    }
    switch (attempt.delivery_outcome) {
      case 'delivery_ok':
        return null; // Successful delivery — no refund.
      case 'delivery_4xx':
        return 'tier1_http_4xx';
      case 'delivery_5xx':
        return 'tier1_http_5xx';
      case 'delivery_other':
        return 'tier1_http_other';
      case 'recall_network_error':
        return 'tier1_recall_network_error';
      case 'delivery_low_quality':
        return 'tier2_body_shape';
      case 'delivery_empty_body':
        return 'tier2_empty_body';
      case 'delivery_skipped':
        // Defensive: this shouldn't happen with payment_outcome=pay_ok, but
        // if it does we record as tier1_http_other so accounting balances.
        logger.warn(
          { attempt },
          'RefundEngine: unexpected delivery_skipped with pay_ok — recording as tier1_http_other',
        );
        return 'tier1_http_other';
    }
    logger.warn({ attempt }, 'RefundEngine: unknown delivery_outcome');
    return 'tier1_http_other';
  }

  /** Record a single absorbed-sat event. Idempotent: re-recording the same
   *  (job_id, candidate_url) returns the existing ledger_id. */
  async recordAttempt(input: {
    job_id: string;
    agent_pubkey: string;
    attempt: FulfillAttempt;
  }): Promise<{ ledger_id: number; inserted: boolean; classification: RefundClassification } | null> {
    const classification = this.classifyAttempt(input.attempt);
    if (classification === null) return null;
    if (input.attempt.sats_paid <= 0) {
      logger.warn(
        { job_id: input.job_id, attempt: input.attempt },
        'RefundEngine: classification says refund but sats_paid<=0 — skipping ledger entry',
      );
      return null;
    }
    const heuristicReasons = input.attempt.detail
      ? { detail: String(input.attempt.detail).slice(0, 256) }
      : {};
    const result = await this.deps.refundLedgerRepo.record({
      job_id: input.job_id,
      candidate_url: input.attempt.candidate_url,
      agent_pubkey: input.agent_pubkey,
      sats_absorbed: input.attempt.sats_paid,
      classification,
      heuristic_reasons: heuristicReasons,
      http_status: input.attempt.http_status,
      preimage: input.attempt.preimage ?? null,
      ts: this.now(),
    });
    return { ledger_id: result.ledger_id, inserted: result.inserted, classification };
  }

  /** Check whether the agent has headroom under the daily refund cap. Called
   *  before fulfill creates a job — if denied, the caller returns 429.
   *
   *  The cap is on USED + WORST-CASE: we reserve the worst-case spend so a
   *  burst of fulfills can't exceed the cap by racing past the check.
   *  worst_case_sats may be 0 if the controller doesn't have a hint yet
   *  (in which case we just check used_24h vs cap). */
  async checkDailyCap(input: DailyCapCheckInput): Promise<DailyCapResult> {
    const nowSec = this.now();
    const ageDays =
      input.agent_first_seen_at != null
        ? (nowSec - input.agent_first_seen_at) / ONE_DAY_SEC
        : 0;
    const ageBucket: 'fresh' | 'established' =
      ageDays < AGENT_AGE_FRESH_DAYS ? 'fresh' : 'established';
    const cap =
      ageBucket === 'fresh'
        ? this.config.freshAgentDailyCapSats
        : this.config.establishedAgentDailyCapSats;
    const used = await this.deps.refundLedgerRepo.agentAbsorbedSatsSince(
      input.agent_pubkey,
      nowSec - ONE_DAY_SEC,
    );
    const remaining = Math.max(0, cap - used);
    const projected = used + Math.max(0, input.worst_case_sats);
    const allowed = projected <= cap;
    return {
      allowed,
      cap_sats: cap,
      used_24h_sats: used,
      remaining_sats: remaining,
      agent_age_bucket: ageBucket,
      reason: allowed
        ? undefined
        : ageBucket === 'fresh'
          ? 'fresh_agent_daily_cap'
          : 'established_agent_daily_cap',
    };
  }
}
