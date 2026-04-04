// v2 API controller — decide, report, profile
import type { Request, Response, NextFunction } from 'express';
import type { DecideService } from '../services/decideService';
import type { ReportService } from '../services/reportService';
import type { AgentService } from '../services/agentService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ScoringService } from '../services/scoringService';
import type { TrendService } from '../services/trendService';
import type { RiskService } from '../services/riskService';
import type { SurvivalService } from '../services/survivalService';
import type { ChannelFlowService } from '../services/channelFlowService';
import type { FeeVolatilityService } from '../services/feeVolatilityService';
import { agentIdentifierSchema, decideSchema, reportSchema } from '../middleware/validation';
import { ValidationError } from '../errors';
import { normalizeIdentifier } from '../utils/identifier';
import { SEVEN_DAYS_SEC } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL } from '../config/scoring';

export class V2Controller {
  constructor(
    private decideService: DecideService,
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
  ) {}

  decide = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const target = normalizeIdentifier(parsed.data.target);
      const caller = normalizeIdentifier(parsed.data.caller);

      const result = await this.decideService.decide(
        target.hash,
        caller.hash,
        parsed.data.amountSats,
      );

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  report = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const target = normalizeIdentifier(parsed.data.target);
      const reporter = normalizeIdentifier(parsed.data.reporter);

      const result = this.reportService.submit({
        target: target.hash,
        reporter: reporter.hash,
        outcome: parsed.data.outcome,
        paymentHash: parsed.data.paymentHash,
        preimage: parsed.data.preimage,
        amountBucket: parsed.data.amountBucket,
        memo: parsed.data.memo,
      });

      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  profile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const idParsed = agentIdentifierSchema.safeParse(req.params.id);
      if (!idParsed.success) throw new ValidationError(idParsed.error.errors[0].message);

      const { hash } = normalizeIdentifier(idParsed.data);

      const agent = this.agentRepo.findByHash(hash);
      if (!agent) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
        return;
      }

      const scoreResult = this.scoringService.getScore(hash);
      const delta = this.trendService.computeDeltas(hash, scoreResult.total);
      const rank = this.agentRepo.getRank(hash);
      const reports = this.attestationRepo.countReportsByOutcome(hash);
      const successRate = reports.total > 0 ? reports.successes / reports.total : 0;

      // Probe uptime over 7 days
      let probeUptime: number | null = null;
      if (this.probeRepo) {
        probeUptime = this.probeRepo.computeUptime(hash, SEVEN_DAYS_SEC);
      }

      const riskProfile = this.riskService.classifyAgent(
        agent, delta, { regularity: scoreResult.components.regularity },
      );

      // C6: pass agent object to avoid redundant DB lookup
      const evidence = this.agentService.buildEvidence(agent);

      // M2: shared base flags — same thresholds as verdictService
      const now = Math.floor(Date.now() / 1000);
      const flags = computeBaseFlags(agent, delta, now);

      // Add DB-dependent flags (fraud, dispute, unreachable)
      const fraudCount = this.attestationRepo.countByCategoryForSubject(hash, ['fraud']);
      const disputeCount = this.attestationRepo.countByCategoryForSubject(hash, ['dispute']);
      if (fraudCount > 0) flags.push('fraud_reported');
      if (disputeCount > 0) flags.push('dispute_reported');
      if (this.probeRepo) {
        const probe = this.probeRepo.findLatest(hash);
        if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
          flags.push('unreachable');
        }
      }

      // Drain flags from channel snapshots
      if (this.channelFlowService) {
        flags.push(...this.channelFlowService.computeDrainFlags(hash));
      }

      // Predictive signals
      const survival = this.survivalService
        ? this.survivalService.compute(agent)
        : { score: 100, prediction: 'stable' as const, signals: { scoreTrajectory: 'no data', probeStability: 'no data', gossipFreshness: 'no data' } };
      const channelFlow = this.channelFlowService?.computeFlow(hash) ?? null;
      const capacityHealth = this.channelFlowService?.computeCapacityHealth(hash) ?? null;
      const feeVolatility = this.feeVolatilityService?.compute(hash) ?? null;

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
          score: {
            total: scoreResult.total,
            components: scoreResult.components,
            confidence: scoreResult.confidence,
            rank,
          },
          reports: {
            total: reports.total,
            successes: reports.successes,
            failures: reports.failures,
            timeouts: reports.timeouts,
            successRate: Math.round(successRate * 1000) / 1000,
          },
          probeUptime: probeUptime !== null ? Math.round(probeUptime * 1000) / 1000 : null,
          survival,
          channelFlow,
          capacityHealth,
          feeVolatility,
          delta,
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
