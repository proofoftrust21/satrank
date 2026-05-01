// Phase 7.3 (2026-05-01) — ClaimEngine: auto-claim on Tier-2 delivery outcomes.
//
// When the orchestrator records a paid attempt that fails delivery (Tier 2 +
// SLA breach + validator violation), the ClaimEngine writes an agent_claims
// row in `pending` state with a 24h dispute window. After the window the
// payout cron transitions to `paid`, slashes the operator's bond, and
// credits the agent's token_balance with `sats_paid_to_agent`.
//
// Multiplier policy (sats_paid_to_agent vs sats_slashed_from_bond):
//   - tier1_*           : 1× (refund the agent's actual payment, slash same)
//   - tier2_*           : 2× (operator delivered crap; pay agent 2× call cost)
//   - sla_breach        : 3× (agent missed an SLA they paid for, pay 3×)
//   - validator_violation: 5× (operator violated explicit contract — punitive)
// Bond pays both sides : agent gets sats_paid_to_agent ; SatRank's pool
// keeps the bond_slash − sats_paid_to_agent delta as premium revenue.
//
// Idempotency: agent_claims (job_id, attempt_index) UNIQUE so re-recording
// the same attempt is safe.
import { logger } from '../logger';
import type { Pool } from 'pg';
import type {
  AgentClaimRepository,
  AgentClaimClassification,
  AgentClaim,
} from '../repositories/agentClaimRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';
import type { FulfillJob, FulfillAttempt } from '../repositories/fulfillJobRepository';

const DISPUTE_WINDOW_SEC = 24 * 3600;

// Multiplier per classification (numerator / denominator). Slash from bond
// is sats_paid × multiplier × bond_buffer (1.5×). Agent receives sats_paid ×
// multiplier directly. Pool keeps the rest as premium.
const MULTIPLIERS: Record<AgentClaimClassification, number> = {
  tier1_http_4xx: 1,
  tier1_http_5xx: 1,
  tier1_http_other: 1,
  tier1_recall_network_error: 1,
  tier2_body_shape: 2,
  tier2_empty_body: 2,
  tier2_schema_violation: 2,
  sla_breach: 3,
  validator_violation: 5,
};

const BOND_BUFFER = 1.5;  // bond is slashed at multiplier × 1.5 to leave premium for pool

/** Map a delivery_outcome string to a claim classification. Returns null
 *  for outcomes that should NOT trigger a claim (delivery_ok, skipped). */
export function classifyDeliveryOutcome(
  delivery_outcome: string,
  payment_outcome: string,
): AgentClaimClassification | null {
  if (payment_outcome !== 'pay_ok') return null;  // didn't pay → no claim
  switch (delivery_outcome) {
    case 'delivery_ok':
      return null;
    case 'delivery_4xx':
      return 'tier1_http_4xx';
    case 'delivery_5xx':
      return 'tier1_http_5xx';
    case 'delivery_other':
      return 'tier1_http_other';
    case 'recall_network_error':
    case 'recall_body_read_error':
      return 'tier1_recall_network_error';
    case 'delivery_low_quality':
    case 'delivery_classification_error':
      return 'tier2_body_shape';
    case 'delivery_empty_body':
      return 'tier2_empty_body';
    case 'delivery_schema_violation':
      return 'tier2_schema_violation';
    case 'delivery_validator_violation':
      return 'validator_violation';
    default:
      return null;
  }
}

export interface ClaimEngineDeps {
  pool: Pool;
  claimRepo: AgentClaimRepository;
  bondRepo: OperatorBondRepository;
  now?: () => number;
}

export class ClaimEngine {
  private now: () => number;

  constructor(private readonly deps: ClaimEngineDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Called by the orchestrator after an attempt records a Tier 2+ outcome.
   *  Writes a `pending` claim against an active bond owned by the operator
   *  identified in attempt.operator_pubkey. Returns the claim row, or null if
   *  no eligible bond was found (we still log the absorbed sats via the
   *  refundEngine path; the operator simply isn't bonded yet).
   *
   *  Idempotent on (job_id, attempt_index) — re-calling with the same
   *  attempt returns the existing row. */
  async openClaimForAttempt(input: {
    job: FulfillJob;
    attempt_index: number;
    attempt: FulfillAttempt;
    sla_breach?: boolean;            // orchestrator hint for SLA path
    validator_violation_reason?: string; // optional override classification
  }): Promise<AgentClaim | null> {
    const { job, attempt_index, attempt } = input;

    let classification: AgentClaimClassification | null;
    if (input.validator_violation_reason) {
      classification = 'validator_violation';
    } else if (input.sla_breach) {
      classification = 'sla_breach';
    } else {
      classification = classifyDeliveryOutcome(attempt.delivery_outcome, attempt.payment_outcome);
    }
    if (classification === null) return null;

    if (!attempt.operator_pubkey) {
      logger.info(
        { jobId: job.job_id, attempt_index, candidate: attempt.candidate_url },
        'ClaimEngine: attempt has no operator_pubkey — cannot resolve bond, skipping claim',
      );
      return null;
    }

    // Resolve an active bond with sufficient available sats. V1 picks the
    // first active bond ; V2 may pick optimally (oldest, lowest balance, etc.).
    const bonds = await this.deps.bondRepo.findActiveByOperator(attempt.operator_pubkey);
    if (bonds.length === 0) {
      logger.info(
        {
          jobId: job.job_id,
          attempt_index,
          operator_pubkey: attempt.operator_pubkey.slice(0, 12),
          classification,
        },
        'ClaimEngine: operator has no active bond — claim deferred (catalogue may want to delist)',
      );
      return null;
    }
    const multiplier = MULTIPLIERS[classification];
    const sats_paid_to_agent = Math.max(1, Math.ceil(attempt.sats_paid * multiplier));
    const sats_slashed_from_bond = Math.max(1, Math.ceil(attempt.sats_paid * multiplier * BOND_BUFFER));

    // Pick the first bond that can absorb the slash atomically.
    let chosenBond = null;
    for (const b of bonds) {
      const avail = b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats;
      if (avail >= sats_slashed_from_bond) { chosenBond = b; break; }
    }
    if (!chosenBond) {
      logger.warn(
        {
          jobId: job.job_id,
          attempt_index,
          operator_pubkey: attempt.operator_pubkey.slice(0, 12),
          needed: sats_slashed_from_bond,
        },
        'ClaimEngine: no bond has enough available sats — operator under-funded',
      );
      return null;
    }

    const reserved = await this.deps.bondRepo.reservePending(chosenBond.bond_id, sats_slashed_from_bond);
    if (!reserved) {
      logger.warn(
        { jobId: job.job_id, bond_id: chosenBond.bond_id },
        'ClaimEngine: reservePending lost the race — skipping',
      );
      return null;
    }

    const nowSec = this.now();
    const claim = await this.deps.claimRepo.createOrGet({
      job_id: job.job_id,
      attempt_index,
      agent_pubkey: job.agent_pubkey,
      bond_id: chosenBond.bond_id,
      classification,
      sats_paid_to_agent,
      sats_slashed_from_bond,
      dispute_until: nowSec + DISPUTE_WINDOW_SEC,
      reason: input.validator_violation_reason ?? attempt.detail ?? undefined,
      created_at: nowSec,
    });
    logger.info(
      {
        claim_id: claim.claim_id,
        job_id: job.job_id,
        operator_pubkey: attempt.operator_pubkey.slice(0, 12),
        classification,
        sats_paid_to_agent,
        sats_slashed_from_bond,
        bond_id: chosenBond.bond_id,
      },
      'ClaimEngine: claim opened pending dispute window',
    );
    return claim;
  }

  /** Cron : transition `pending` claims past the dispute window to `paid` ;
   *  commit the bond slash + credit the agent's token_balance. Returns the
   *  count of paid-out claims. */
  async payoutReadyClaims(): Promise<{ paid: number; failed: number }> {
    const ready = await this.deps.claimRepo.findReadyForPayout(this.now());
    let paid = 0;
    let failed = 0;
    for (const claim of ready) {
      try {
        await this.payoutOne(claim);
        paid += 1;
      } catch (err) {
        logger.error(
          { claim_id: claim.claim_id, error: err instanceof Error ? err.message : String(err) },
          'ClaimEngine: payout failed — leaving in pending for next tick',
        );
        failed += 1;
      }
    }
    return { paid, failed };
  }

  private async payoutOne(claim: AgentClaim): Promise<void> {
    // Atomic via SQL-level guards. Order matters : commit slash first
    // (so a re-run sees pending → paid in a single direction), then credit
    // agent. If credit fails, the slash already happened ; the claim is
    // marked `paid` regardless and ops can manually rebalance via dispute.
    const slashOk = await this.deps.bondRepo.commitSlash(
      claim.bond_id,
      claim.sats_slashed_from_bond,
      this.now(),
    );
    if (!slashOk) {
      throw new Error(`bond ${claim.bond_id} commitSlash failed (no pending reserve)`);
    }
    // Credit agent's token_balance. agent_pubkey == payment_hash for V1.
    // Cast $2 explicitly to int — Postgres type inference confuses itself when
    // the same param shows up 4 times with mixed contexts.
    await this.deps.pool.query(
      `INSERT INTO token_balance (payment_hash, balance_credits, rate_sats_per_request, created_at, max_quota, remaining)
       VALUES ($1, $2::int, 1, EXTRACT(EPOCH FROM now())::int, $2::int, $2::int)
       ON CONFLICT (payment_hash) DO UPDATE
         SET balance_credits = token_balance.balance_credits + $2::int,
             remaining = token_balance.remaining + $2::int`,
      [claim.agent_pubkey, claim.sats_paid_to_agent],
    );
    await this.deps.claimRepo.setState(claim.claim_id, 'paid', this.now());
  }
}
