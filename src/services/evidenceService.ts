// Phase 8.3 (2026-05-01) — EvidenceService composes a SatRank-signed
// evidence receipt for a successfully-fulfilled (job_id, attempt_index).
//
// Receipt payload (canonical JSON, sorted keys at every depth) :
// {
//   "agent_pubkey":   "<job.agent_pubkey>",
//   "attempt_index":  N,
//   "body_sha256":    "<job.result_body_sha256>",
//   "candidate_url":  "<attempt.candidate_url>",
//   "intent_hash":    "<job.intent_hash>",
//   "job_id":         "<job.job_id>",
//   "operator_pubkey":"<attempt.operator_pubkey | null>",
//   "preimage":       "<attempt.preimage>",
//   "sats_paid":      <attempt.sats_paid>,
//   "satrank_version":"phase8.3",
//   "ts_started":     <attempt.ts_started>,
//   "ts_finished":    <attempt.ts_finished>,
//   "ts_settled":     <job.settled_at>
// }
//
// EvidenceService.issue(job_id, attempt_index, agent_pubkey) :
//  - validates the job exists, status='success', agent_pubkey matches
//  - validates the attempt is delivery_ok (only successful deliveries get
//    a positive receipt — failures get a refund-receipt schema in 8.3.1)
//  - computes canonical JSON, signs with SignerService
//  - persists in evidence_receipts (idempotent)
//  - returns the receipt
import { logger } from '../logger';
import type { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import type { EvidenceReceiptRepository, EvidenceReceipt } from '../repositories/evidenceReceiptRepository';
import { SignerService, canonicalJson } from './signerService';

const RECEIPT_VERSION = 'phase8.3';

export type EvidenceIssueResult =
  | { status: 'ok'; receipt: EvidenceReceipt }
  | { status: 'job_not_found' }
  | { status: 'agent_mismatch' }
  | { status: 'job_not_success' }
  | { status: 'attempt_not_found' }
  | { status: 'attempt_not_delivery_ok' }
  | { status: 'signing_disabled' };

export interface EvidenceServiceDeps {
  fulfillJobRepo: FulfillJobRepository;
  receiptRepo: EvidenceReceiptRepository;
  signer: SignerService;
  now?: () => number;
}

export class EvidenceService {
  private now: () => number;

  constructor(private readonly deps: EvidenceServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async issue(
    jobId: string,
    attemptIndex: number,
    agentPubkey: string,
  ): Promise<EvidenceIssueResult> {
    if (!this.deps.signer.isAvailable()) {
      return { status: 'signing_disabled' };
    }

    // Cache hit ?
    const cached = await this.deps.receiptRepo.findByJobAttempt(jobId, attemptIndex);
    if (cached) {
      // Still verify ownership before returning.
      const job = await this.deps.fulfillJobRepo.findById(jobId);
      if (!job) return { status: 'job_not_found' };
      if (job.agent_pubkey !== agentPubkey) return { status: 'agent_mismatch' };
      return { status: 'ok', receipt: cached };
    }

    const job = await this.deps.fulfillJobRepo.findById(jobId);
    if (!job) return { status: 'job_not_found' };
    if (job.agent_pubkey !== agentPubkey) return { status: 'agent_mismatch' };
    if (job.status !== 'success') return { status: 'job_not_success' };

    const attempt = job.attempts[attemptIndex];
    if (!attempt) return { status: 'attempt_not_found' };
    if (attempt.delivery_outcome !== 'delivery_ok') return { status: 'attempt_not_delivery_ok' };

    const payload = {
      agent_pubkey: job.agent_pubkey,
      attempt_index: attemptIndex,
      body_sha256: job.result_body_sha256 ?? '',
      candidate_url: attempt.candidate_url,
      intent_hash: job.intent_hash,
      job_id: job.job_id,
      operator_pubkey: attempt.operator_pubkey ?? null,
      preimage: attempt.preimage ?? '',
      sats_paid: attempt.sats_paid,
      satrank_version: RECEIPT_VERSION,
      ts_finished: attempt.ts_finished,
      ts_settled: job.settled_at ?? this.now(),
      ts_started: attempt.ts_started,
    };
    const canonical = canonicalJson(payload);
    const signed = this.deps.signer.sign(canonical);
    const nowSec = this.now();
    const receipt = await this.deps.receiptRepo.createOrGet({
      job_id: job.job_id,
      attempt_index: attemptIndex,
      payload_canonical_json: signed.payload_canonical,
      payload_sha256: signed.payload_sha256,
      signature_b64: signed.signature,
      satrank_pubkey: signed.satrank_pubkey,
      signed_at_iso: signed.signed_at,
      signed_at: nowSec,
    });
    logger.info(
      { receipt_id: receipt.receipt_id, job_id: job.job_id, attempt_index: attemptIndex, agent_pubkey: agentPubkey.slice(0, 12) },
      'EvidenceService: receipt issued',
    );
    return { status: 'ok', receipt };
  }

  /** Look up the first successful attempt for a job (the one with delivery_ok). */
  findSuccessfulAttemptIndex(job: { attempts: { delivery_outcome: string }[] }): number | null {
    const idx = job.attempts.findIndex(a => a.delivery_outcome === 'delivery_ok');
    return idx >= 0 ? idx : null;
  }
}
