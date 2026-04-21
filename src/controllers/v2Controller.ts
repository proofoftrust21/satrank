// Decision API controller — report, profile
// Phase 10 (2026-04-20) — `/api/decide` and `/api/best-route` were removed;
// their 410 Gone handlers live in controllers/legacyGoneController.ts.
// The DecideService remains alive but no longer injected here (IntentService
// and mcp/server wire their own instances).
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';

/** Convert the L402 Authorization preimage into its payment_hash Buffer.
 *  Returns null when the header is missing, malformed, or not an L402 token
 *  (e.g. X-API-Key path). Consumed by the Tier 2 bonus balance credit. */
function extractL402PaymentHashFromAuth(authHeader: string | undefined): Buffer | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  if (!match) return null;
  return crypto.createHash('sha256').update(Buffer.from(match[1], 'hex')).digest();
}
import type { ReportService } from '../services/reportService';
import type { AgentService } from '../services/agentService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { PreimagePoolRepository } from '../repositories/preimagePoolRepository';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import { logger } from '../logger';
import type { ScoringService } from '../services/scoringService';
import type { TrendService } from '../services/trendService';
import type { RiskService } from '../services/riskService';
import type { SurvivalService } from '../services/survivalService';
import type { ChannelFlowService } from '../services/channelFlowService';
import type { FeeVolatilityService } from '../services/feeVolatilityService';
import type { ReportBonusService } from '../services/reportBonusService';
import { agentIdentifierSchema, reportSchema, anonymousReportSchema } from '../middleware/validation';
import { formatZodError } from '../utils/zodError';
import { ValidationError, ConflictError } from '../errors';
import { v4 as uuidv4 } from 'uuid';
import type { AnonymousReportRequest } from '../middleware/auth';
import { normalizeIdentifier, resolveIdentifier } from '../utils/identifier';
import { SEVEN_DAYS_SEC, DAY } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL } from '../config/scoring';
import { logTokenQuery } from '../utils/tokenQueryLog';

export class V2Controller {
  constructor(
    private reportService: ReportService,
    private agentService: AgentService,
    private agentRepo: AgentRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private riskService: RiskService,
    private probeRepo?: ProbeRepository,
    private survivalService?: SurvivalService,
    private channelFlowService?: ChannelFlowService,
    private feeVolatilityService?: FeeVolatilityService,
    private pool?: Pool,
    // Tier 2 economic incentive. Optional so dev/test can skip it; when omitted
    // the controller never attempts to credit bonuses (identical to
    // REPORT_BONUS_ENABLED=false behavior).
    private reportBonusService?: ReportBonusService,
    // Phase 2 voie 3 : pool d'autorisation des reports anonymes. Optional
    // pour rester backwards-compatible — sans lui, les reports anonymes sont
    // refusés (cf. reportAnonymous).
    private preimagePoolRepo?: PreimagePoolRepository,
  ) {}

  report = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Phase 2 voie 3 — dispatch : si le middleware a marqué la requête comme
      // anonyme, délègue à reportAnonymous. Sinon, chemin legacy authentifié.
      const anonReq = req as AnonymousReportRequest;
      if (anonReq.isAnonymousReport) {
        await this.reportAnonymous(anonReq, res, next);
        return;
      }

      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const target = normalizeIdentifier(parsed.data.target);
      const reporter = normalizeIdentifier(parsed.data.reporter);

      // L402 token's payment_hash (raw sha256 digest Buffer) — null under
      // API-key auth. Consumed by both ReportService (source classification
      // via token_query_log lookup) and the Tier 2 bonus credit path; hoisted
      // above submit() so it's available to both without re-parsing the
      // header.
      const l402PaymentHash = extractL402PaymentHashFromAuth(req.headers.authorization);

      const result = await this.reportService.submit({
        target: target.hash,
        reporter: reporter.hash,
        outcome: parsed.data.outcome,
        paymentHash: parsed.data.paymentHash,
        preimage: parsed.data.preimage,
        amountBucket: parsed.data.amountBucket,
        memo: parsed.data.memo,
        l402PaymentHash: l402PaymentHash ?? undefined,
      });

      // Tier 2 bonus — gated by REPORT_BONUS_ENABLED env, auto-rollback, and
      // the anti-sybil eligibility gates inside the service. `null` when the
      // bonus service is not wired (test env) or when no bonus was earned.
      let bonus: { credited: boolean; sats?: number; gate?: string } | null = null;
      if (this.reportBonusService) {
        const creditResult = await this.reportBonusService.maybeCredit({
          reporterHash: reporter.hash,
          req,
          verified: result.verified,
          paymentHash: l402PaymentHash,
        });
        if (creditResult.credited) {
          bonus = { credited: true, sats: creditResult.sats, gate: creditResult.gate };
        } else {
          // Expose the gate decision even when nothing was credited so the
          // client knows whether they were eligible (useful for UX hints).
          bonus = { credited: false, gate: creditResult.gate };
        }
      }

      res.status(201).json({ data: { ...result, bonus } });
    } catch (err) {
      next(err);
    }
  };

  /** Phase 2 voie 3 — report anonyme via preimage_pool.
   *  Le middleware createReportDispatchAuth a déjà :
   *    - détecté X-L402-Preimage (ou body.preimage sans reporter),
   *    - posé req.isAnonymousReport = true + req.anonymousPreimage.
   *  Ici : validation stricte du payload (anonymousReportSchema), voie 3 opt-in
   *  (insertIfAbsent tier='low' source='report' si bolt11Raw valide), lookup
   *  obligatoire dans preimage_pool, consumeAtomic puis submitAnonymous. */
  private reportAnonymous = async (req: AnonymousReportRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.preimagePoolRepo) {
        throw new ValidationError('Anonymous reports are not enabled on this instance');
      }

      const parsed = anonymousReportSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      // La preimage vient prioritairement du header X-L402-Preimage (pattern
      // L402 standard) et fallback sur body.preimage. Le middleware a déjà
      // tranché : req.anonymousPreimage est la source de vérité.
      const preimage = req.anonymousPreimage ?? parsed.data.preimage;
      if (!preimage || !/^[a-f0-9]{64}$/.test(preimage)) {
        throw new ValidationError('preimage must be 64 hex chars');
      }

      // Dérive payment_hash = sha256(preimage) côté serveur — jamais trust le
      // client sur cette relation cryptographique.
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

      // Voie 3 — self-declared : si bolt11Raw fourni, parse et vérifie que son
      // payment_hash matche celui dérivé de la preimage. Sinon on pollue le
      // pool avec des invoices non-reliées à la preimage soumise.
      if (parsed.data.bolt11Raw) {
        try {
          const parsedInvoice = parseBolt11(parsed.data.bolt11Raw);
          if (parsedInvoice.paymentHash !== paymentHash) {
            throw new ValidationError('BOLT11_MISMATCH: bolt11Raw payment_hash does not match sha256(preimage)');
          }
          await this.preimagePoolRepo.insertIfAbsent({
            paymentHash,
            bolt11Raw: parsed.data.bolt11Raw,
            firstSeen: Math.floor(Date.now() / 1000),
            confidenceTier: 'low',
            source: 'report',
          });
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          if (err instanceof InvalidBolt11Error) {
            throw new ValidationError('bolt11Raw could not be parsed');
          }
          logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Anonymous: preimage_pool insert failed');
        }
      }

      // Lookup — si pas de match, l'agent doit fournir un bolt11Raw pour
      // auto-peupler, ou payer un endpoint crawlé par 402index.
      const entry = await this.preimagePoolRepo.findByPaymentHash(paymentHash);
      if (!entry) {
        throw new ValidationError(
          'PREIMAGE_UNKNOWN: payment_hash not found in pool. Submit bolt11Raw to self-declare, ' +
          'or pay an L402 endpoint crawled by our registry (e.g. via 402index.io).',
        );
      }

      const reportId = uuidv4();

      // Consumption one-shot atomique : seule la première requête concurrente
      // réussit ; les autres voient consumed_at ≠ NULL et récupèrent 409.
      const consumed = await this.preimagePoolRepo.consumeAtomic(
        paymentHash, reportId, Math.floor(Date.now() / 1000),
      );
      if (!consumed) {
        throw new ConflictError(
          'DUPLICATE_REPORT: this preimage has already been consumed by another report',
          'DUPLICATE_REPORT',
        );
      }

      const target = normalizeIdentifier(parsed.data.target);

      const result = await this.reportService.submitAnonymous({
        reportId,
        target: target.hash,
        paymentHash,
        tier: entry.confidence_tier,
        outcome: parsed.data.outcome,
        amountBucket: parsed.data.amountBucket,
        memo: parsed.data.memo,
      });

      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  profile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idParsed = agentIdentifierSchema.safeParse(req.params.id);
      if (!idParsed.success) throw new ValidationError(formatZodError(idParsed.error, req.params.id, { fallbackField: 'id' }));

      const { hash } = await resolveIdentifier(idParsed.data, p => this.agentRepo.findByPubkey(p));

      const agent = await this.agentRepo.findByHash(hash);
      if (!agent) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
        return;
      }

      // Token→target binding for /api/report — a profile fetch counts as
      // "interest in this target" so the caller can later report outcomes.
      await logTokenQuery(this.pool, req.headers.authorization, hash, req.requestId);

      // Canonical public score is the Bayesian posterior. Composite `scoreResult`
      // still feeds the internal risk classifier (regularity input); the 7d
      // delta is now on p_success scale, calibrated against the empirical
      // posterior distribution (see scripts/analyzeDeltaDistribution.ts).
      const bayesian = await this.agentService.toBayesianBlock(hash);
      const scoreResult = await this.scoringService.getScore(hash);
      const delta = await this.trendService.computeDeltas(hash, bayesian.p_success);
      const rank = await this.agentRepo.getRank(hash);
      const reports = await this.attestationRepo.countReportsByOutcome(hash);
      const successRate = reports.total > 0 ? reports.successes / reports.total : 0;

      // Probe uptime over 7 days
      let probeUptime: number | null = null;
      if (this.probeRepo) {
        probeUptime = await this.probeRepo.computeUptime(hash, SEVEN_DAYS_SEC);
      }

      const riskProfile = this.riskService.classifyAgent(
        agent, delta, { regularity: scoreResult.components.regularity },
      );

      // C6: pass agent object to avoid redundant DB lookup
      const evidence = await this.agentService.buildEvidence(agent);

      // M2: shared base flags — same thresholds as verdictService
      const now = Math.floor(Date.now() / 1000);
      const flags = computeBaseFlags(agent, delta, now);

      // Add DB-dependent flags (fraud, dispute, unreachable)
      const fraudCount = await this.attestationRepo.countByCategoryForSubject(hash, ['fraud']);
      const disputeCount = await this.attestationRepo.countByCategoryForSubject(hash, ['dispute']);
      if (fraudCount > 0) flags.push('fraud_reported');
      if (disputeCount > 0) flags.push('dispute_reported');
      if (this.probeRepo) {
        // tier-1k probe only — higher tiers surface via maxRoutableAmount
        const probe = await this.probeRepo.findLatestAtTier(hash, 1000);
        if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
          // Same guard as verdictService: fresh gossip + SAFE verdict = positional failure, not dead node
          const gossipFresh = (now - agent.last_seen) < DAY;
          if (!gossipFresh || bayesian.verdict !== 'SAFE') {
            flags.push('unreachable');
          }
        }
      }

      // Drain flags from channel snapshots
      if (this.channelFlowService) {
        flags.push(...(await this.channelFlowService.computeDrainFlags(hash)));
      }

      // Predictive signals
      const survival = this.survivalService
        ? await this.survivalService.compute(agent)
        : { score: 100, prediction: 'stable' as const, signals: { scoreTrajectory: 'no data', probeStability: 'no data', gossipFreshness: 'no data' } };
      const channelFlow = this.channelFlowService ? await this.channelFlowService.computeFlow(hash) : null;
      const capacityHealth = this.channelFlowService ? await this.channelFlowService.computeCapacityHealth(hash) : null;
      const feeVolatility = this.feeVolatilityService ? await this.feeVolatilityService.compute(hash) : null;

      // Reporter stats: how ACTIVELY this agent has submitted reports (as
      // attester). Separate from `reports` above (which counts reports about
      // this agent as subject). The Trusted Reporter badge is a pure visibility
      // incentive — no scoring impact, no economic reward, zero gaming surface.
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * DAY;
      const reporter = await this.attestationRepo.reporterStats(hash, thirtyDaysAgo);
      const TRUSTED_REPORTER_THRESHOLD = 20;
      // Always return a badge string so agents don't have to null-check.
      // `novice` is the default for agents that have never submitted a report
      // (sim #9 FINDING #11 — `null` forced a defensive guard on every client).
      const reporterBadge =
        reporter.verified >= TRUSTED_REPORTER_THRESHOLD ? 'trusted_reporter' :
        reporter.submitted >= 5 ? 'active_reporter' :
        reporter.submitted >= 1 ? 'reporter' :
        'novice';

      res.json({
        data: {
          agent: {
            publicKeyHash: agent.public_key_hash,
            alias: agent.alias,
            publicKey: agent.public_key,
            firstSeen: agent.first_seen,
            lastSeen: agent.last_seen,
            source: agent.source,
          },
          bayesian,
          rank,
          reports: {
            total: reports.total,
            successes: reports.successes,
            failures: reports.failures,
            timeouts: reports.timeouts,
            successRate: Math.round(successRate * 1000) / 1000,
          },
          reporterStats: {
            badge: reporterBadge,
            submitted30d: reporter.submitted,
            verified30d: reporter.verified,
            breakdown: { successes: reporter.successes, failures: reporter.failures, timeouts: reporter.timeouts },
          },
          probeUptime: probeUptime !== null ? Math.round(probeUptime * 1000) / 1000 : null,
          survival,
          channelFlow,
          capacityHealth,
          feeVolatility,
          riskProfile,
          evidence,
          flags,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
