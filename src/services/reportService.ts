// Report engine — outcome feedback (success / failure / timeout)
// Converts success/failure/timeout into weighted attestations
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { ScoringService } from './scoringService';
import type { Attestation, ReportRequest, ReportResponse, ReportOutcome, AttestationCategory } from '../types';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import { windowBucket } from '../utils/dualWriteLogger';
import { NotFoundError, ValidationError, DuplicateReportError } from '../errors';
import { logger } from '../logger';
import { reportSubmittedTotal } from '../middleware/metrics';

const OUTCOME_SCORE: Record<ReportOutcome, number> = {
  success: 85,
  failure: 15,
  timeout: 25,
};

const OUTCOME_CATEGORY: Record<ReportOutcome, AttestationCategory> = {
  success: 'successful_transaction',
  failure: 'failed_transaction',
  timeout: 'unresponsive',
};

const REPORT_CATEGORIES: AttestationCategory[] = ['successful_transaction', 'failed_transaction', 'unresponsive'];
const REPORT_RATE_LIMIT_WINDOW_SEC = 60; // 1 minute
const REPORT_RATE_LIMIT_MAX = 20;
const REPORT_DEDUP_WINDOW_SEC = 3600; // 1 hour
const PREIMAGE_WEIGHT_BONUS = 2.0;
const BASE_WEIGHT_FLOOR = 0.3;
const BASE_WEIGHT_MAX = 1.0;
const REPORTER_SCORE_DIVISOR = 80;

export class ReportService {
  constructor(
    private attestationRepo: AttestationRepository,
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private scoringService: ScoringService,
    private db?: Database.Database,
    private dualWriteMode: DualWriteMode = 'off',
    private dualWriteLogger?: DualWriteLogger,
  ) {}

  submit(input: ReportRequest): ReportResponse {
    const now = Math.floor(Date.now() / 1000);

    // Validate reporter exists
    const reporter = this.agentRepo.findByHash(input.reporter);
    if (!reporter) throw new NotFoundError('Agent (reporter)', input.reporter);

    // Validate target exists
    const target = this.agentRepo.findByHash(input.target);
    if (!target) throw new NotFoundError('Agent (target)', input.target);

    // Self-report not allowed
    if (input.reporter === input.target) {
      throw new ValidationError('An agent cannot report on itself');
    }

    // Preimage verification (pure computation — safe outside transaction)
    let verified = false;
    if (input.paymentHash && input.preimage) {
      const hash = createHash('sha256').update(Buffer.from(input.preimage, 'hex')).digest('hex');
      verified = hash === input.paymentHash;
      if (!verified) {
        logger.warn({ reporter: input.reporter.slice(0, 12), target: input.target.slice(0, 12) }, 'Preimage verification failed');
      }
    }

    // Reporter weight: based on reporter's own score
    const reporterScore = this.scoringService.getScore(input.reporter);
    const baseWeight = Math.max(BASE_WEIGHT_FLOOR, Math.min(BASE_WEIGHT_MAX, reporterScore.total / REPORTER_SCORE_DIVISOR));
    const weight = verified ? baseWeight * PREIMAGE_WEIGHT_BONUS : baseWeight;

    // Build attestation from report
    const score = OUTCOME_SCORE[input.outcome];
    const category = OUTCOME_CATEGORY[input.outcome];

    // H2: namespace by reporter only — one preimage can only be used once per reporter,
    // regardless of target, preventing weight inflation across multiple targets
    const txId = input.paymentHash
      ? `${input.paymentHash}:${input.reporter}`
      : `report-${uuid()}`;

    const attestation: Attestation = {
      attestation_id: uuid(),
      tx_id: txId,
      attester_hash: input.reporter,
      subject_hash: input.target,
      score,
      tags: input.memo ? JSON.stringify([input.memo.slice(0, 280)]) : null,
      evidence_hash: input.paymentHash ?? null,
      timestamp: now,
      category,
      verified: verified ? 1 : 0,
      weight,
    };

    // Atomic check-then-insert: rate limit, dedup, insert, stats update (S3)
    const doInsert = () => {
      // Rate limit: max reports per minute per reporter (only count report categories — C8)
      const recentCount = this.attestationRepo.countRecentByAttester(
        input.reporter, now - REPORT_RATE_LIMIT_WINDOW_SEC, REPORT_CATEGORIES,
      );
      if (recentCount >= REPORT_RATE_LIMIT_MAX) {
        throw new ValidationError(`Rate limit exceeded: max ${REPORT_RATE_LIMIT_MAX} reports per minute`);
      }

      // Dedup: 1 report per (reporter, target) per hour
      const recent = this.attestationRepo.findRecentReport(
        input.reporter, input.target, now - REPORT_DEDUP_WINDOW_SEC,
      );
      if (recent) {
        throw new DuplicateReportError('Report already submitted for this target within the last hour');
      }

      // Ensure synthetic transaction exists (required by FK constraint)
      // S2: do NOT store raw preimage — evidence_hash holds the paymentHash
      const existingTx = this.txRepo.findById(txId);
      if (!existingTx) {
        // operator_id = target agent_hash (already sha256 of the pubkey per
        // agents schema — matches §1.1's operator_id definition without
        // re-hashing). endpoint_hash stays NULL: /api/report carries no
        // target_url today, so we can't derive the URL's canonical hash here.
        // §5 backfill will not fill it either (source='report' rows have no
        // URL to reach back to); a future ReportRequest extension can tighten
        // this when target_url becomes available.
        const reportTx = {
          tx_id: txId,
          sender_hash: input.reporter,
          receiver_hash: input.target,
          amount_bucket: input.amountBucket ?? 'micro',
          timestamp: now,
          payment_hash: input.paymentHash ?? txId,
          preimage: null, // S2: never store raw preimage
          status: (input.outcome === 'success' ? 'verified' : 'failed') as 'verified' | 'failed',
          protocol: 'bolt11' as const,
        };
        const enrichment: DualWriteEnrichment = {
          endpoint_hash: null,
          operator_id: input.target,
          source: 'report',
          window_bucket: windowBucket(now),
        };
        this.txRepo.insertWithDualWrite(
          reportTx,
          enrichment,
          this.dualWriteMode,
          'reportService',
          this.dualWriteLogger,
        );
      }

      this.attestationRepo.insert(attestation);

      // C3: SQL increment instead of read-modify-write
      if (!existingTx) {
        this.agentRepo.incrementTotalTransactions(input.target);
      }
      // H1: only update attestation count — leave avg_score for periodic scoring job
      this.agentRepo.updateAttestationCount(
        input.target,
        this.attestationRepo.countBySubject(input.target),
      );
    };

    if (this.db) {
      this.db.transaction(doInsert)();
    } else {
      doInsert();
    }

    // Monitoring counter — always emitted, labelled by verified status and the
    // declared outcome. Drives the 30-day Tier 1 dashboard and the Tier 2
    // eligibility funnel once activated.
    reportSubmittedTotal.inc({
      verified: verified ? '1' : '0',
      outcome: input.outcome,
    });

    return {
      reportId: attestation.attestation_id,
      verified,
      weight: Math.round(weight * 1000) / 1000,
      timestamp: now,
    };
  }
}
