// Report engine — outcome feedback (success / failure / timeout)
// Converts success/failure/timeout into weighted attestations
import { createHash, timingSafeEqual } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { ScoringService } from './scoringService';
import type { BayesianScoringService } from './bayesianScoringService';
import type { Attestation, ReportRequest, ReportResponse, ReportOutcome, AttestationCategory } from '../types';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import { windowBucket } from '../utils/dualWriteLogger';
import { NotFoundError, ValidationError, DuplicateReportError } from '../errors';
import { logger } from '../logger';
import { reportSubmittedTotal } from '../middleware/metrics';
import { sha256 } from '../utils/crypto';
import type { PreimagePoolTier } from '../repositories/preimagePoolRepository';
import { tierToReporterWeight } from '../repositories/preimagePoolRepository';

// Dérive l'agent_hash d'un reporter anonyme à partir du payment_hash de la
// preimage pool. Stable, déterministe, unique par preimage. Utilisé pour :
//   - attester_hash dans attestations (FK agents.public_key_hash)
//   - sender_hash dans transactions (FK agents.public_key_hash)
//   - reporter_identity retourné dans la réponse (préfixé "preimage_pool:")
export function anonymousReporterHash(paymentHash: string): string {
  return sha256(`preimage_pool:${paymentHash}`);
}

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
    /** Optionnel — quand fourni, chaque report insère une observation dans les
     *  aggregates bayesiens (operator + endpoint, 3 fenêtres). Décloisonné du
     *  dualWriteMode (Q1 Phase 3) : l'ingestion se fait même en mode='off'
     *  pour que le scoring ait du signal. Fallback silencieux quand absent —
     *  les tests unitaires qui n'ont pas besoin du pipeline bayésien peuvent
     *  omettre la dépendance. */
    private bayesian?: BayesianScoringService,
  ) {}

  /** Looks up decide_log to decide the tx source:
   *    'intent' — this report closes out a prior /api/decide call from the
   *               same L402 token on the same target. Outcome is the truth
   *               value of that intent per §4 cases 1 & 2 of PHASE-1-DESIGN.
   *    'report' — no matching decide_log row; the report is a standalone
   *               observation (user-driven POST without a prior /decide).
   *  Returns 'report' if the DB handle is unavailable, the token's
   *  paymentHash wasn't passed, or the query errors — classification is
   *  best-effort and must never break report submission. */
  private classifySource(
    l402PaymentHash: Buffer | null | undefined,
    targetHash: string,
  ): 'intent' | 'report' {
    if (!this.db || !l402PaymentHash) return 'report';
    try {
      const row = this.db.prepare(
        'SELECT 1 FROM decide_log WHERE payment_hash = ? AND target_hash = ? LIMIT 1',
      ).get(l402PaymentHash, targetHash);
      return row ? 'intent' : 'report';
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'decide_log lookup failed, falling back to source=report',
      );
      return 'report';
    }
  }

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
    // Constant-time comparison to prevent byte-by-byte timing oracle on preimage guesses.
    let verified = false;
    if (input.paymentHash && input.preimage) {
      const hashBuf = createHash('sha256').update(Buffer.from(input.preimage, 'hex')).digest();
      const expectedBuf = Buffer.from(input.paymentHash, 'hex');
      verified = hashBuf.length === expectedBuf.length && timingSafeEqual(hashBuf, expectedBuf);
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
        // endpoint_hash = operator_id = target agent_hash. Sans target_url
        // disponible dans /api/report, on utilise le hash de l'agent comme clé
        // de reachability — cohérent avec probeCrawler (pubkey_hash sert de
        // double clé endpoint+operator pour les nodes sans URL). Indispensable
        // pour que `bayesianVerdictService.loadObservations` retrouve les rows
        // report quand il filtre par endpoint_hash = target.
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
        // §4: if the submitter's L402 token has a matching decide_log row
        // for this target, the report closes out a prior /decide intent.
        // Otherwise it's a standalone observation.
        const source = this.classifySource(input.l402PaymentHash, input.target);
        const enrichment: DualWriteEnrichment = {
          endpoint_hash: input.target,
          operator_id: input.target,
          source,
          window_bucket: windowBucket(now),
        };
        this.txRepo.insertWithDualWrite(
          reportTx,
          enrichment,
          this.dualWriteMode,
          source === 'intent' ? 'decideService' : 'reportService',
          this.dualWriteLogger,
        );

        // Bridge report → bayesian. Q1 : l'ingestion est systématique, ignore
        // le flag dualWriteMode. Q4 : la pondération par tier (novice/contributor/
        // reliable/trusted côté identifié, preimage low/medium/high côté anonyme)
        // est appliquée à la LECTURE via weightForSource — pas à l'ingestion.
        // Ici on pousse une observation brute success/failure ; le reporter_tier
        // entre dans le calcul quand buildVerdict charge les obs. Les intents
        // (decide_log) NE sont PAS ingérés — mapTransactionSourceToBayesian(intent)
        // = null et ils ne doivent pas compter comme observation réussie.
        if (this.bayesian && source === 'report') {
          this.bayesian.ingestTransactionOutcome({
            endpointHash: input.target,
            operatorId: input.target,
            success: input.outcome === 'success',
            timestamp: now,
          });
        }
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

  /** Phase 2 voie 3 — report anonyme depuis preimage_pool.
   *
   *  Pré-condition : le caller a déjà :
   *    1. vérifié que sha256(preimage) === paymentHash,
   *    2. trouvé l'entrée dans preimage_pool via findByPaymentHash,
   *    3. consommé l'entrée via consumeAtomic (UPDATE WHERE consumed_at IS NULL).
   *  Ces trois étapes restent au niveau du controller parce qu'elles conditionnent
   *  les codes HTTP (400 PREIMAGE_UNKNOWN, 409 DUPLICATE_REPORT) que le service
   *  ne doit pas émettre directement.
   *
   *  Cette méthode crée/upsert l'agent synthétique (source='manual',
   *  hash=sha256('preimage_pool:' + paymentHash)), insère la transaction avec
   *  source='report' + status='verified', puis attache l'attestation pondérée
   *  par tierToReporterWeight(tier). Renvoie le même shape que submit() plus
   *  reporter_identity, confidence_tier et reporter_weight_applied. */
  submitAnonymous(input: {
    reportId: string;
    target: string;
    paymentHash: string;
    tier: PreimagePoolTier;
    outcome: ReportOutcome;
    amountBucket?: 'micro' | 'small' | 'medium' | 'large';
    memo?: string;
  }): {
    reportId: string;
    verified: boolean;
    weight: number;
    timestamp: number;
    reporter_identity: string;
    confidence_tier: PreimagePoolTier;
    reporter_weight_applied: number;
  } {
    const now = Math.floor(Date.now() / 1000);

    const target = this.agentRepo.findByHash(input.target);
    if (!target) throw new NotFoundError('Agent (target)', input.target);

    const reporterHash = anonymousReporterHash(input.paymentHash);

    // Self-report via pool : impossible en pratique (payer = receiver ne peut
    // pas être son propre agent synthétique — hash dérivé de paymentHash), mais
    // on garde la vérif par cohérence.
    if (reporterHash === input.target) {
      throw new ValidationError('An agent cannot report on itself');
    }

    const weight = tierToReporterWeight(input.tier);
    const score = OUTCOME_SCORE[input.outcome];
    const category = OUTCOME_CATEGORY[input.outcome];

    // tx_id déterministe — une preimage = un report anonyme (consumeAtomic
    // garantit déjà l'unicité mais on double-garde avec le PRIMARY KEY tx_id).
    const txId = `preimage_pool:${input.paymentHash}`;

    const attestation: Attestation = {
      attestation_id: input.reportId,
      tx_id: txId,
      attester_hash: reporterHash,
      subject_hash: input.target,
      score,
      tags: input.memo ? JSON.stringify([input.memo.slice(0, 280)]) : null,
      evidence_hash: input.paymentHash,
      timestamp: now,
      category,
      verified: 1,
      weight,
    };

    const doInsert = () => {
      // Upsert synthetic agent pour satisfaire la FK attester_hash/sender_hash
      const existingReporter = this.agentRepo.findByHash(reporterHash);
      if (!existingReporter) {
        this.agentRepo.insert({
          public_key_hash: reporterHash,
          public_key: null,
          alias: `anon:${input.paymentHash.slice(0, 8)}`,
          first_seen: now,
          last_seen: now,
          source: 'manual',
          total_transactions: 0,
          total_attestations_received: 0,
          avg_score: 0,
          capacity_sats: null,
          positive_ratings: 0,
          negative_ratings: 0,
          lnplus_rank: 0,
          hubness_rank: 0,
          betweenness_rank: 0,
          hopness_rank: 0,
          query_count: 0,
          unique_peers: null,
          last_queried_at: null,
        });
      }

      // Synthetic transaction — preimage=null (S2), status='verified' car la
      // preimage vient d'une pool entry prouvée, source='report' systématique.
      const existingTx = this.txRepo.findById(txId);
      if (!existingTx) {
        const reportTx = {
          tx_id: txId,
          sender_hash: reporterHash,
          receiver_hash: input.target,
          amount_bucket: input.amountBucket ?? 'micro',
          timestamp: now,
          payment_hash: input.paymentHash,
          preimage: null,
          status: 'verified' as const,
          protocol: 'bolt11' as const,
        };
        const enrichment: DualWriteEnrichment = {
          endpoint_hash: input.target,
          operator_id: input.target,
          source: 'report',
          window_bucket: windowBucket(now),
        };
        // Phase 2 anonyme : always write the 4 v31 columns. Le chemin anonyme
        // est né en v32 et n'a pas à participer au rollout dual-write du chemin
        // legacy — on force mode='active' pour garantir source='report'.
        this.txRepo.insertWithDualWrite(
          reportTx,
          enrichment,
          'active',
          'reportService',
          this.dualWriteLogger,
        );

        // Bridge anonymous report → bayesian aggregates. Même contrat que la
        // voie identifiée : observation brute, la pondération par preimage tier
        // (low/medium/high) est appliquée à la lecture.
        if (this.bayesian) {
          this.bayesian.ingestTransactionOutcome({
            endpointHash: input.target,
            operatorId: input.target,
            success: input.outcome === 'success',
            timestamp: now,
          });
        }
      }

      this.attestationRepo.insert(attestation);

      if (!existingTx) {
        this.agentRepo.incrementTotalTransactions(input.target);
      }
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

    reportSubmittedTotal.inc({
      verified: '1',
      outcome: input.outcome,
    });

    return {
      reportId: input.reportId,
      verified: true,
      weight: Math.round(weight * 1000) / 1000,
      timestamp: now,
      reporter_identity: `preimage_pool:${input.paymentHash}`,
      confidence_tier: input.tier,
      reporter_weight_applied: weight,
    };
  }
}
