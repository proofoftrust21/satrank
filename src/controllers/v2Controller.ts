// Decision API controller — decide, report, profile
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';

/** Convert the L402 Authorization preimage into its payment_hash Buffer.
 *  Returns null when the header is missing, malformed, or not an L402 token
 *  (e.g. X-API-Key path). Consumed by the Tier 2 bonus balance credit. */
function extractL402PaymentHashFromAuth(authHeader: string | undefined): Buffer | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  if (!match) return null;
  return crypto.createHash('sha256').update(Buffer.from(match[1], 'hex')).digest();
}
import type { DecideService } from '../services/decideService';
import type { ReportService } from '../services/reportService';
import type { AgentService } from '../services/agentService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { ScoringService } from '../services/scoringService';
import type { TrendService } from '../services/trendService';
import type { RiskService } from '../services/riskService';
import type { SurvivalService } from '../services/survivalService';
import type { ChannelFlowService } from '../services/channelFlowService';
import type { FeeVolatilityService } from '../services/feeVolatilityService';
import type { VerdictService } from '../services/verdictService';
import type { ReportBonusService } from '../services/reportBonusService';
import { agentIdentifierSchema, decideSchema, reportSchema, bestRouteSchema } from '../middleware/validation';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { normalizeIdentifier, resolveIdentifier } from '../utils/identifier';
import { confidenceToNumber } from '../utils/confidence';
import { SEVEN_DAYS_SEC, DAY } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL, VERDICT_SAFE_THRESHOLD } from '../config/scoring';
import { WALLET_PROVIDERS } from '../config/walletProviders';
import { verdictTotal } from '../middleware/metrics';
import { logTokenQuery } from '../utils/tokenQueryLog';

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
    private db?: Database.Database,
    // Tier 2 economic incentive. Optional so dev/test can skip it; when omitted
    // the controller never attempts to credit bonuses (identical to
    // REPORT_BONUS_ENABLED=false behavior).
    private reportBonusService?: ReportBonusService,
  ) {}

  decide = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const target = resolveIdentifier(parsed.data.target, p => this.agentRepo.findByPubkey(p));
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

      // Log this target query for /api/report auth. See utils/tokenQueryLog.ts
      // for why every paid target-query path writes here, not just /api/decide.
      logTokenQuery(this.db, req.headers.authorization, target.hash, req.requestId);

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
          const norm = resolveIdentifier(t, p => this.agentRepo.findByPubkey(p));
          const agent = this.agentRepo.findByHash(norm.hash);
          return { hash: norm.hash, agent };
        });
        const candidates = targetInfos
          .filter(t => t.agent)
          .map(t => {
            const scoreResult = this.scoringService.getScore(t.hash);
            const verdict = scoreResult.total >= 47 ? 'SAFE' as const : scoreResult.total >= 30 ? 'UNKNOWN' as const : 'RISKY' as const;
            verdictTotal.inc({ verdict, source: 'best-route' });
            return { publicKeyHash: t.hash, alias: t.agent!.alias, score: scoreResult.total, verdict, pathfinding: null };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        // Token→target binding for /api/report (degraded path)
        for (const t of targetInfos) {
          logTokenQuery(this.db, req.headers.authorization, t.hash, req.requestId);
        }
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
        const norm = resolveIdentifier(t, p => this.agentRepo.findByPubkey(p));
        const agent = this.agentRepo.findByHash(norm.hash);
        return { hash: norm.hash, pubkey: agent?.public_key ?? norm.pubkey, agent };
      });

      // queryRoutes with concurrency cap (max 10 parallel LND calls to prevent saturation)
      const LND_CONCURRENCY_CAP = 10;
      const pathResults: Array<typeof targetInfos[number] & { pathfinding: Awaited<ReturnType<VerdictService['computePathfinding']>> | null }> = [];
      for (let i = 0; i < targetInfos.length; i += LND_CONCURRENCY_CAP) {
        const batch = targetInfos.slice(i, i + LND_CONCURRENCY_CAP);
        const batchResults = await Promise.all(
          batch.map(async (t) => {
            if (!t.pubkey || !t.agent) return { ...t, pathfinding: null };
            const pf = await this.verdictService!.computePathfinding(callerLnPubkey, t.pubkey, caller.hash, t.hash);
            return { ...t, pathfinding: pf };
          }),
        );
        pathResults.push(...batchResults);
      }

      const serviceUrls = parsed.data.serviceUrls;
      // Minimum checks before trusting HTTP health as a real signal.
      // Aligns with /api/services uptimeRatio threshold — 1-2 checks are noise.
      const MIN_HEALTH_CHECKS = 3;

      // Filter to reachable, enrich with score + verdict
      const allReachable = pathResults
        .filter(r => r.pathfinding?.reachable && r.agent)
        .map(r => {
          const scoreResult = this.scoringService.getScore(r.hash);
          const verdict = scoreResult.total >= 47 ? 'SAFE' as const : scoreResult.total >= 30 ? 'UNKNOWN' as const : 'RISKY' as const;
          verdictTotal.inc({ verdict, source: 'best-route' });

          // Route quality (0-100) from pathfinding
          const hops = r.pathfinding!.hops ?? 99;
          const hopPenalty = Math.max(12, 100 - (hops - 1) * 8);
          const alternatives = r.pathfinding!.alternatives ?? 1;
          const altBonus = Math.min(100, 80 + alternatives * 10);
          const routeQuality = hopPenalty * 0.6 + altBonus * 0.4;

          // Trust score (0-100)
          const trust = scoreResult.total;

          // HTTP health: only use when we have ≥3 checks on a trusted-source endpoint.
          // findByAgent already filters out ad_hoc entries (untrusted URL→agent binding).
          let httpHealth = 50;
          let hasHealth = false;
          const url = serviceUrls?.[r.hash];
          const endpoint = url
            ? this.serviceEndpointRepo?.findByUrl(url)
            : this.serviceEndpointRepo?.findByAgent(r.hash)?.[0];
          if (endpoint && endpoint.check_count >= MIN_HEALTH_CHECKS) {
            httpHealth = Math.round((endpoint.success_count / endpoint.check_count) * 100);
            hasHealth = true;
          }

          return {
            publicKeyHash: r.hash,
            alias: r.agent!.alias,
            score: scoreResult.total,
            verdict,
            pathfinding: r.pathfinding!,
            _routeQuality: routeQuality,
            _trust: trust,
            _httpHealth: httpHealth,
            _hasHealth: hasHealth,
          };
        });

      // Per-target composite: 3D (40/30/30) when THIS target has trusted health data,
      // 2D (50/50) otherwise. Avoids penalizing nodes without HTTP endpoints just
      // because another target in the same batch had one sample.
      const ranked = allReachable
        .map(r => {
          const rankScore = r._hasHealth
            ? r._routeQuality * 0.40 + r._trust * 0.30 + r._httpHealth * 0.30
            : r._routeQuality * 0.50 + r._trust * 0.50;
          return { ...r, _rankScore: rankScore };
        })
        .sort((a, b) => b._rankScore - a._rankScore);
      const candidates = ranked
        .slice(0, 3)
        .map(({ _rankScore, _routeQuality, _trust, _httpHealth, _hasHealth, ...rest }) => rest);

      const totalQueried = parsed.data.targets.length;
      const reachableCount = ranked.length;

      // Bind every queried target to the caller token so each one is eligible
      // for a later /api/report submission. Log ALL targets (not just the top
      // candidates) — the caller may want to report on any of them.
      for (const t of targetInfos) {
        logTokenQuery(this.db, req.headers.authorization, t.hash, req.requestId);
      }

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

  report = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

      // Tier 2 bonus — gated by REPORT_BONUS_ENABLED env, auto-rollback, and
      // the anti-sybil eligibility gates inside the service. `null` when the
      // bonus service is not wired (test env) or when no bonus was earned.
      let bonus: { credited: boolean; sats?: number; gate?: string } | null = null;
      if (this.reportBonusService) {
        const l402PaymentHash = extractL402PaymentHashFromAuth(req.headers.authorization);
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

  profile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const idParsed = agentIdentifierSchema.safeParse(req.params.id);
      if (!idParsed.success) throw new ValidationError(formatZodError(idParsed.error, req.params.id, { fallbackField: 'id' }));

      const { hash } = resolveIdentifier(idParsed.data, p => this.agentRepo.findByPubkey(p));

      const agent = this.agentRepo.findByHash(hash);
      if (!agent) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
        return;
      }

      // Token→target binding for /api/report — a profile fetch counts as
      // "interest in this target" so the caller can later report outcomes.
      logTokenQuery(this.db, req.headers.authorization, hash, req.requestId);

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
        // tier-1k probe only — higher tiers surface via maxRoutableAmount
        const probe = this.probeRepo.findLatestAtTier(hash, 1000);
        if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
          // Same guard as verdictService: fresh gossip + high score = positional failure, not dead node
          const gossipFresh = (now - agent.last_seen) < DAY;
          if (!gossipFresh || scoreResult.total < VERDICT_SAFE_THRESHOLD) {
            flags.push('unreachable');
          }
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

      // Reporter stats: how ACTIVELY this agent has submitted reports (as
      // attester). Separate from `reports` above (which counts reports about
      // this agent as subject). The Trusted Reporter badge is a pure visibility
      // incentive — no scoring impact, no economic reward, zero gaming surface.
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * DAY;
      const reporter = this.attestationRepo.reporterStats(hash, thirtyDaysAgo);
      const TRUSTED_REPORTER_THRESHOLD = 20;
      const reporterBadge =
        reporter.verified >= TRUSTED_REPORTER_THRESHOLD ? 'trusted_reporter' :
        reporter.submitted >= 5 ? 'active_reporter' :
        reporter.submitted >= 1 ? 'reporter' :
        null;

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
            confidence: confidenceToNumber(scoreResult.confidence),
            rank,
          },
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
            trustedThreshold: TRUSTED_REPORTER_THRESHOLD,
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
