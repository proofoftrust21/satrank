// Decision API controller — decide, report, profile
import type { Request, Response, NextFunction } from 'express';
import type { DecideService } from '../services/decideService';
import type { ReportService } from '../services/reportService';
import type { AgentService } from '../services/agentService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { ServiceProbeRepository } from '../repositories/serviceProbeRepository';
import type { ScoringService } from '../services/scoringService';
import type { TrendService } from '../services/trendService';
import type { RiskService } from '../services/riskService';
import type { SurvivalService } from '../services/survivalService';
import type { ChannelFlowService } from '../services/channelFlowService';
import type { FeeVolatilityService } from '../services/feeVolatilityService';
import type { VerdictService } from '../services/verdictService';
import { agentIdentifierSchema, decideSchema, reportSchema, bestRouteSchema } from '../middleware/validation';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { normalizeIdentifier } from '../utils/identifier';
import { SEVEN_DAYS_SEC } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL } from '../config/scoring';
import { WALLET_PROVIDERS } from '../config/walletProviders';

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
    private verdictService?: VerdictService,
    private serviceEndpointRepo?: ServiceEndpointRepository,
    private serviceProbeRepo?: ServiceProbeRepository,
  ) {}

  decide = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const target = normalizeIdentifier(parsed.data.target);
      const caller = normalizeIdentifier(parsed.data.caller);

      // Resolve pathfinding source: callerNodePubkey > walletProvider > caller's own pubkey
      const pathfindingSourcePubkey = parsed.data.callerNodePubkey
        ?? (parsed.data.walletProvider ? WALLET_PROVIDERS[parsed.data.walletProvider] : undefined);

      const result = await this.decideService.decide(
        target.hash,
        caller.hash,
        parsed.data.amountSats,
        pathfindingSourcePubkey,
        parsed.data.serviceUrl,
      );

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  bestRoute = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = bestRouteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      if (!this.verdictService) {
        res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Pathfinding not configured' } });
        return;
      }

      const startMs = Date.now();
      const caller = normalizeIdentifier(parsed.data.caller);
      const callerAgent = this.agentRepo.findByHash(caller.hash);
      // Resolve pathfinding source: callerNodePubkey > walletProvider > caller's own pubkey
      const callerLnPubkey = parsed.data.callerNodePubkey
        ?? (parsed.data.walletProvider ? WALLET_PROVIDERS[parsed.data.walletProvider] : undefined)
        ?? callerAgent?.public_key
        ?? caller.pubkey;

      if (!callerLnPubkey) {
        // Degraded response: return scores without pathfinding
        const targetInfos = parsed.data.targets.map(t => {
          const norm = normalizeIdentifier(t);
          const agent = this.agentRepo.findByHash(norm.hash);
          return { hash: norm.hash, agent };
        });
        const candidates = targetInfos
          .filter(t => t.agent)
          .map(t => {
            const scoreResult = this.scoringService.getScore(t.hash);
            const verdict = scoreResult.total >= 47 ? 'SAFE' as const : scoreResult.total >= 30 ? 'UNKNOWN' as const : 'RISKY' as const;
            return { publicKeyHash: t.hash, alias: t.agent!.alias, score: scoreResult.total, verdict, pathfinding: null };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        res.json({
          data: {
            candidates,
            totalQueried: parsed.data.targets.length,
            reachableCount: 0,
            unreachableCount: parsed.data.targets.length,
            pathfindingContext: 'Caller has no known Lightning pubkey. Candidates ranked by score only (no pathfinding). Add walletProvider or callerNodePubkey to POST /api/decide for positional pathfinding.',
            latencyMs: Date.now() - startMs,
          },
        });
        return;
      }

      // Resolve all targets in parallel
      const targetInfos = parsed.data.targets.map(t => {
        const norm = normalizeIdentifier(t);
        const agent = this.agentRepo.findByHash(norm.hash);
        return { hash: norm.hash, pubkey: agent?.public_key ?? norm.pubkey, agent };
      });

      // queryRoutes in parallel for all targets with LN pubkeys
      const pathResults = await Promise.all(
        targetInfos.map(async (t) => {
          if (!t.pubkey || !t.agent) return { ...t, pathfinding: null };
          const pf = await this.verdictService!.computePathfinding(callerLnPubkey, t.pubkey, caller.hash, t.hash);
          return { ...t, pathfinding: pf };
        }),
      );

      const serviceUrls = parsed.data.serviceUrls;
      const hasServiceData = serviceUrls && Object.keys(serviceUrls).length > 0;

      // Filter to reachable, enrich with score + verdict, sort by composite rank
      const allReachable = pathResults
        .filter(r => r.pathfinding?.reachable && r.agent)
        .map(r => {
          const scoreResult = this.scoringService.getScore(r.hash);
          const verdict = scoreResult.total >= 47 ? 'SAFE' as const : scoreResult.total >= 30 ? 'UNKNOWN' as const : 'RISKY' as const;

          // Route quality (0-100) from pathfinding
          const hops = r.pathfinding!.hops ?? 99;
          const hopPenalty = Math.max(12, 100 - (hops - 1) * 8);
          const alternatives = r.pathfinding!.alternatives ?? 1;
          const altBonus = Math.min(100, 80 + alternatives * 10);
          const routeQuality = hopPenalty * 0.6 + altBonus * 0.4;

          // Trust score (0-100)
          const trust = scoreResult.total;

          // HTTP health (0-100) from service_endpoints
          let httpHealth = 50; // neutral default
          const url = serviceUrls?.[r.hash];
          const endpoint = url
            ? this.serviceEndpointRepo?.findByUrl(url)
            : this.serviceEndpointRepo?.findByAgent(r.hash)?.[0]; // auto-lookup from registry
          if (endpoint && endpoint.check_count >= 1) {
            httpHealth = Math.round((endpoint.success_count / endpoint.check_count) * 100);
          }

          // Paid probe signal (0 or 100)
          let probeSignal = 50; // neutral default
          const probeUrl = url ?? endpoint?.url;
          if (probeUrl && this.serviceProbeRepo) {
            const probe = this.serviceProbeRepo.findLatest(probeUrl);
            if (probe?.body_valid) probeSignal = 100;
            else if (probe && probe.paid_sats > 0 && !probe.body_valid) probeSignal = 0;
          }

          // Composite rank: multi-dimensional when service data available
          const rankScore = hasServiceData
            ? routeQuality * 0.35 + trust * 0.25 + httpHealth * 0.25 + probeSignal * 0.15
            : routeQuality * 0.50 + trust * 0.50; // graceful degradation

          return {
            publicKeyHash: r.hash,
            alias: r.agent!.alias,
            score: scoreResult.total,
            verdict,
            pathfinding: r.pathfinding!,
            _rankScore: rankScore,
          };
        })
        .sort((a, b) => b._rankScore - a._rankScore);
      const candidates = allReachable
        .slice(0, 3)
        .map(({ _rankScore, ...rest }) => rest);

      const totalQueried = parsed.data.targets.length;
      const reachableCount = allReachable.length;

      res.json({
        data: {
          candidates,
          totalQueried,
          reachableCount,
          unreachableCount: totalQueried - reachableCount,
          pathfindingContext: 'Pathfinding runs from the SatRank node position in the Lightning graph (limited outbound channels). Low reachability (e.g. 3/20) reflects graph topology, not target node quality. Targets unreachable from SatRank may be fully reachable from your node.',
          latencyMs: Date.now() - startMs,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  report = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

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
      if (!idParsed.success) throw new ValidationError(formatZodError(idParsed.error, req.params.id, { fallbackField: 'id' }));

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
