// Phase 12A — auto-issue evidence on fulfill success.
//
// Exercises the FulfillService private helper indirectly by constructing a
// service with a stub evidenceService, then driving it through a settle path
// via a minimal-mock surface. The autoIssueEvidence method is called in
// fire-and-forget mode, so we use a microtask flush + spy assertion pattern.
import { describe, it, expect, vi } from 'vitest';
import { FulfillService } from '../services/fulfillService';
import type { FulfillJob, FulfillJobRepository } from '../repositories/fulfillJobRepository';
import type { EvidenceService } from '../services/evidenceService';

const SUCCESSFUL_JOB: FulfillJob = {
  job_id: 'job-test-123',
  agent_pubkey: 'a'.repeat(64),
  intent_hash: 'h'.repeat(64),
  max_sats: 100,
  max_latency_ms: 5000,
  status: 'success',
  attempts: [
    {
      candidate_url: 'https://example.test/api',
      rank: 1,
      ts_started: 1_000_000,
      ts_finished: 1_000_001,
      payment_outcome: 'pay_ok',
      delivery_outcome: 'delivery_ok',
      http_status: 200,
      sats_paid: 5,
      preimage: 'p'.repeat(64),
    },
  ],
  sats_spent: 5,
  sats_refunded: 0,
  premium_sats: 1,
  preimage: 'p'.repeat(64),
  result_body_sha256: 's'.repeat(64),
  reason: null,
  created_at: 1_000_000,
  settled_at: 1_000_001,
  mode: 'deposit',
  hold_invoice_payment_request: null,
  hold_invoice_payment_hash: null,
  hold_invoice_preimage: null,
  hold_invoice_state: null,
  hold_invoice_expires_at: null,
  refund_bolt11: null,
  refund_state: null,
  refund_amount_sats: null,
  refund_payment_preimage: null,
  refund_attempts: 0,
  refund_last_error: null,
  refund_settled_at: null,
};

function makeFulfillJobRepo(job: FulfillJob): FulfillJobRepository {
  return {
    findById: vi.fn(async () => job),
  } as unknown as FulfillJobRepository;
}

function makeEvidenceService(overrides?: {
  issueResult?: 'ok' | 'job_not_found' | 'signing_disabled';
  throwOnIssue?: boolean;
}): EvidenceService & { issue: ReturnType<typeof vi.fn>; findSuccessfulAttemptIndex: ReturnType<typeof vi.fn> } {
  const issue = vi.fn(async () => {
    if (overrides?.throwOnIssue) {
      throw new Error('signing rpc down');
    }
    if (overrides?.issueResult === 'signing_disabled') {
      return { status: 'signing_disabled' as const };
    }
    if (overrides?.issueResult === 'job_not_found') {
      return { status: 'job_not_found' as const };
    }
    return {
      status: 'ok' as const,
      receipt: {
        receipt_id: 42,
        job_id: SUCCESSFUL_JOB.job_id,
        attempt_index: 0,
        agent_pubkey: SUCCESSFUL_JOB.agent_pubkey,
        operator_pubkey: null,
        candidate_url: 'https://example.test/api',
        intent_hash: SUCCESSFUL_JOB.intent_hash,
        body_sha256: 's'.repeat(64),
        preimage: 'p'.repeat(64),
        sats_paid: 5,
        ts_started: 1_000_000,
        ts_finished: 1_000_001,
        ts_settled: 1_000_001,
        signed_at: 1_000_001,
        payload_canonical_json: '{}',
        payload_sha256: 'r'.repeat(64),
        signature_hex: 'sig',
        satrank_version: 'phase8.3',
      },
    };
  });
  const findSuccessfulAttemptIndex = vi.fn((j: { attempts: { delivery_outcome: string }[] }) => {
    const idx = j.attempts.findIndex(a => a.delivery_outcome === 'delivery_ok');
    return idx >= 0 ? idx : null;
  });
  return {
    issue,
    findSuccessfulAttemptIndex,
  } as unknown as EvidenceService & {
    issue: ReturnType<typeof vi.fn>;
    findSuccessfulAttemptIndex: ReturnType<typeof vi.fn>;
  };
}

/** Access the private autoIssueEvidence method through prototype to test
 *  it in isolation. Service is constructed with the minimum deps required ;
 *  most fields are unused by autoIssueEvidence. */
function callAutoIssue(
  fulfillService: FulfillService,
  jobId: string,
  agentPubkey: string,
): void {
  // The method is private but exists on the prototype ; we cast to access it
  // for unit-test scoping. Avoids spinning up an entire fulfill path.
  (fulfillService as unknown as { autoIssueEvidence: (id: string, pk: string) => void })
    .autoIssueEvidence(jobId, agentPubkey);
}

describe('FulfillService.autoIssueEvidence (Phase 12A)', () => {
  it('calls evidenceService.issue with the successful attempt index', async () => {
    const evidenceService = makeEvidenceService();
    const fulfillJobRepo = makeFulfillJobRepo(SUCCESSFUL_JOB);
    const svc = new FulfillService({
      pool: {} as never,
      fulfillJobRepo,
      intentService: {} as never,
      lndClient: {} as never,
      evidenceService,
    });
    callAutoIssue(svc, SUCCESSFUL_JOB.job_id, SUCCESSFUL_JOB.agent_pubkey);
    // Allow the fire-and-forget microtask chain to resolve.
    await new Promise(r => setImmediate(r));
    expect(evidenceService.findSuccessfulAttemptIndex).toHaveBeenCalled();
    expect(evidenceService.issue).toHaveBeenCalledWith(
      SUCCESSFUL_JOB.job_id,
      0,
      SUCCESSFUL_JOB.agent_pubkey,
    );
  });

  it('skips when evidenceService is not wired (back-compat)', async () => {
    const fulfillJobRepo = makeFulfillJobRepo(SUCCESSFUL_JOB);
    const svc = new FulfillService({
      pool: {} as never,
      fulfillJobRepo,
      intentService: {} as never,
      lndClient: {} as never,
      // evidenceService omitted on purpose
    });
    // Should not throw even without the service wired.
    expect(() => callAutoIssue(svc, SUCCESSFUL_JOB.job_id, SUCCESSFUL_JOB.agent_pubkey)).not.toThrow();
    await new Promise(r => setImmediate(r));
    // (no observable side effect — repo.findById should not even be called)
    expect((fulfillJobRepo.findById as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('swallows errors from evidenceService.issue (must not block fulfill)', async () => {
    const evidenceService = makeEvidenceService({ throwOnIssue: true });
    const fulfillJobRepo = makeFulfillJobRepo(SUCCESSFUL_JOB);
    const svc = new FulfillService({
      pool: {} as never,
      fulfillJobRepo,
      intentService: {} as never,
      lndClient: {} as never,
      evidenceService,
    });
    callAutoIssue(svc, SUCCESSFUL_JOB.job_id, SUCCESSFUL_JOB.agent_pubkey);
    // No assertion failure should propagate; just allow microtask flush.
    await new Promise(r => setImmediate(r));
    expect(evidenceService.issue).toHaveBeenCalled();
  });

  it('skips issue when no delivery_ok attempt is present', async () => {
    const job: FulfillJob = {
      ...SUCCESSFUL_JOB,
      attempts: [
        {
          ...SUCCESSFUL_JOB.attempts[0],
          delivery_outcome: 'delivery_4xx',
        },
      ],
    };
    const evidenceService = makeEvidenceService();
    const fulfillJobRepo = makeFulfillJobRepo(job);
    const svc = new FulfillService({
      pool: {} as never,
      fulfillJobRepo,
      intentService: {} as never,
      lndClient: {} as never,
      evidenceService,
    });
    callAutoIssue(svc, job.job_id, job.agent_pubkey);
    await new Promise(r => setImmediate(r));
    // findSuccessfulAttemptIndex returns null — issue must not be called.
    expect(evidenceService.findSuccessfulAttemptIndex).toHaveBeenCalled();
    expect(evidenceService.issue).not.toHaveBeenCalled();
  });
});
