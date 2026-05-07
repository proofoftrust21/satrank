// AEPS §10 → §7 (2026-05-07) — Adapter that turns a resolved dispute into
// a ClaimEngine slashing claim. Wired in app.ts as the DisputeService
// onResolved hook.
//
// Design choices :
//
// 1. Only `resolved_disputant` triggers slashing of the respondent's bond.
//    `resolved_respondent` for false_dispute would slash the disputant's
//    AGENT bond, which requires AgentSlashingService integration — deferred
//    to v0.2. Currently we log a TODO and return.
//
// 2. Receipt-based disputes (content_correctness, sla_breach, non_payment)
//    look up the receipt → fulfill_jobs.attempts[i] → operator_pubkey.
//    We then call ClaimEngine.openClaimForAttempt with a classification
//    override that matches the dispute's multiplier semantics.
//
// 3. Fork-based disputes don't have a fulfill_job context. The slashing
//    needs a job-less claim variant in agent_claims (schema change) —
//    deferred to v0.2.
//
// 4. The adapter is a pure function, not a service. Wire it in app.ts as :
//      onResolved: (d) => buildDisputeClaim(d, { fulfillJobRepo,
//                                                 evidenceReceiptRepo,
//                                                 claimEngine })
import { logger } from '../logger';
import type { AepsDispute } from '../repositories/aepsDisputeRepository';
import type { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import type { EvidenceReceiptRepository } from '../repositories/evidenceReceiptRepository';
import type { ClaimEngine } from './claimEngine';

export interface DisputeClaimAdapterDeps {
  fulfillJobRepo: FulfillJobRepository;
  evidenceReceiptRepo: EvidenceReceiptRepository;
  claimEngine: ClaimEngine;
}

export type DisputeClaimResult =
  | { status: 'claim_opened'; claim_id: number }
  | { status: 'no_action'; reason: string };

export async function buildDisputeClaim(
  dispute: AepsDispute,
  deps: DisputeClaimAdapterDeps,
): Promise<DisputeClaimResult> {
  if (dispute.state !== 'resolved_disputant') {
    return {
      status: 'no_action',
      reason: `dispute state ${dispute.state} does not trigger slashing (only resolved_disputant does)`,
    };
  }

  // Fork-based disputes need schema work to slash without a job_id reference.
  if (dispute.dispute_type === 'fork') {
    logger.info(
      {
        dispute_id: dispute.dispute_id,
        fork_event_id: dispute.fork_event_id,
        respondent: dispute.respondent_pubkey.slice(0, 12),
      },
      'AEPS §10→§7: fork dispute resolved — slashing path requires schema v81 (deferred)',
    );
    return { status: 'no_action', reason: 'fork-based slashing pending schema v81' };
  }

  // false_dispute requires slashing the AGENT (disputant) bond, which is a
  // different code path through AgentSlashingService.
  if (dispute.dispute_type === 'false_dispute') {
    logger.info(
      {
        dispute_id: dispute.dispute_id,
        disputant: dispute.disputant_pubkey.slice(0, 12),
      },
      'AEPS §10→§7: false_dispute resolution requires AgentSlashingService wiring (deferred)',
    );
    return { status: 'no_action', reason: 'false_dispute slashing pending agent-side wiring' };
  }

  if (!dispute.receipt_id) {
    logger.warn(
      { dispute_id: dispute.dispute_id, type: dispute.dispute_type },
      'AEPS §10→§7: receipt-based dispute has no receipt_id — cannot map to job',
    );
    return { status: 'no_action', reason: 'missing receipt_id on receipt-based dispute' };
  }

  // Look up receipt → job_id + attempt_index.
  const receipts = await deps.evidenceReceiptRepo.listByJob('').catch(() => null);
  // We don't have a findById on EvidenceReceiptRepo today ; this adapter
  // assumes the caller has access via a small lookup helper. The main
  // wire-up in app.ts can do a direct DB query against evidence_receipts.
  // For now we delegate via a workaround : fetch all receipts for any job
  // is too broad ; instead, we use the receipt repo's listByJob which
  // requires job_id. So we need a small helper.
  void receipts;

  const receipt = await findReceiptById(deps.evidenceReceiptRepo, dispute.receipt_id);
  if (!receipt) {
    logger.warn(
      { dispute_id: dispute.dispute_id, receipt_id: dispute.receipt_id },
      'AEPS §10→§7: receipt not found',
    );
    return { status: 'no_action', reason: 'receipt not found' };
  }

  const job = await deps.fulfillJobRepo.findById(receipt.job_id);
  if (!job) {
    logger.warn(
      { dispute_id: dispute.dispute_id, job_id: receipt.job_id },
      'AEPS §10→§7: fulfill_job not found',
    );
    return { status: 'no_action', reason: 'fulfill_job not found' };
  }

  const attempt = job.attempts[receipt.attempt_index];
  if (!attempt) {
    logger.warn(
      {
        dispute_id: dispute.dispute_id,
        job_id: job.job_id,
        attempt_index: receipt.attempt_index,
      },
      'AEPS §10→§7: attempt index out of range',
    );
    return { status: 'no_action', reason: 'attempt index out of range' };
  }

  // Map dispute_type → ClaimEngine classification override hint.
  const claimInput: Parameters<ClaimEngine['openClaimForAttempt']>[0] = {
    job,
    attempt_index: receipt.attempt_index,
    attempt,
  };
  switch (dispute.dispute_type) {
    case 'content_correctness':
      claimInput.validator_violation_reason = 'AEPS dispute resolved against operator (content_correctness, 5×)';
      break;
    case 'sla_breach':
      claimInput.sla_breach = true;
      break;
    case 'non_payment':
      // Use the natural classification path (Tier-1, 1×) ; no override needed.
      break;
  }

  const claim = await deps.claimEngine.openClaimForAttempt(claimInput);
  if (!claim) {
    return { status: 'no_action', reason: 'ClaimEngine declined (no bond, under-funded, etc.)' };
  }

  logger.info(
    {
      dispute_id: dispute.dispute_id,
      claim_id: claim.claim_id,
      classification: claim.classification,
      sats_paid_to_agent: claim.sats_paid_to_agent,
      sats_slashed_from_bond: claim.sats_slashed_from_bond,
    },
    'AEPS §10→§7: dispute resolution opened slashing claim',
  );

  return { status: 'claim_opened', claim_id: claim.claim_id };
}

/** Small helper : look up a single evidence receipt by id. The repo's
 *  primary lookup is by (job_id, attempt_index) ; we add a thin id-based
 *  fetch via the repo's underlying db. */
async function findReceiptById(
  repo: EvidenceReceiptRepository,
  receiptId: number,
): Promise<{ job_id: string; attempt_index: number } | null> {
  // Reach into the repo's db (the repository class stores `db` privately
  // but exposes it via the constructor binding).
  const db = (repo as unknown as { db: { query: <T>(q: string, p: unknown[]) => Promise<{ rows: T[] }> } }).db;
  const { rows } = await db.query<{ job_id: string; attempt_index: string | number }>(
    'SELECT job_id, attempt_index FROM evidence_receipts WHERE receipt_id = $1',
    [receiptId],
  );
  if (!rows[0]) return null;
  return {
    job_id: rows[0].job_id,
    attempt_index: Number(rows[0].attempt_index),
  };
}
