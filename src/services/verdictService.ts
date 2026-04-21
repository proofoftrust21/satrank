// Verdict engine — Bayesian shape (Phase 3).
// Returns canonical Bayesian posterior (p_success, ci95, sources, convergence)
// plus operational overlays (flags, pathfinding, riskProfile) that agents need
// to act on the verdict. The composite score is retired from public responses.
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { ScoringService, ScoreResult } from './scoringService';
import type { TrendService } from './trendService';
import type { RiskService } from './riskService';
import type { BayesianVerdictService } from './bayesianVerdictService';
import type { OperatorService, OperatorResourceLookup } from './operatorService';
import type { VerdictResponse, VerdictFlag, Verdict, PersonalTrust, PathfindingResult } from '../types';
import { DAY } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { computeAdvisoryReport } from './advisoryService';
import { PROBE_FRESHNESS_TTL } from '../config/scoring';
import { config } from '../config';
import { logger } from '../logger';
import { verdictTotal } from '../middleware/metrics';

const POSITIVE_ATTESTATION_MIN_SCORE = 70;
const PATH_CACHE_TTL_MS = 5 * 60 * 1000;
const PATH_CACHE_MAX_SIZE = 1000;
/** Window for uptime-based reachability fed into the advisory report. Matches
 *  the bayesian τ (7 days) so reachability decays on the same time horizon. */
const REACHABILITY_WINDOW_SEC = 7 * 24 * 3600;

export class VerdictService {
  private pathCache = new Map<string, { result: PathfindingResult; expiresAt: number; lastAccess: number }>();

  constructor(
    private agentRepo: AgentRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private riskService: RiskService,
    private bayesianVerdict: BayesianVerdictService,
    private probeRepo?: ProbeRepository,
    private lndClient?: LndGraphClient,
    // Phase 7 C11+C12 — optionnel : permet d'exposer operator_id (verified) et
    // d'attacher un advisory OPERATOR_UNVERIFIED aux verdicts. Optional parce
    // qu'initialement VerdictService n'avait pas cette dépendance (wire-up
    // additive dans src/app.ts).
    private operatorService?: OperatorService,
  ) {}

  async getVerdict(
    publicKeyHash: string,
    callerPubkey?: string,
    pathfindingSourcePubkey?: string,
    source: string = 'unknown',
    // Kept for signature compatibility with callers that already ran getScore()
    // (v2Controller etc.). Used for the internal risk overlay only — never
    // exposed in the public response.
    precomputedScore?: ScoreResult,
  ): Promise<VerdictResponse> {
    const agent = await this.agentRepo.findByHash(publicKeyHash);
    if (!agent) {
      verdictTotal.inc({ verdict: 'INSUFFICIENT', source });
      return buildMissingAgentResponse(callerPubkey);
    }

    await this.agentRepo.incrementQueryCount(publicKeyHash);

    const bayes = await this.bayesianVerdict.buildVerdict({ targetHash: publicKeyHash });

    // Delta is now computed on bayes.p_success — the 7d comparator is read
    // from score_snapshots.p_success and thresholds are calibrated against the
    // empirical posterior distribution (see scripts/analyzeDeltaDistribution.ts).
    // The composite score is still fetched for the internal `regularity` input
    // to the risk classifier; scoring.avg_score stays as an internal column.
    const scoreResult = precomputedScore ?? (await this.scoringService.getScore(publicKeyHash));
    const delta = await this.trendService.computeDeltas(publicKeyHash, bayes.p_success);

    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - agent.first_seen) / DAY;

    const flags: VerdictFlag[] = computeBaseFlags(agent, delta, now);

    const fraudCount = await this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['fraud']);
    const disputeCount = await this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['dispute']);
    if (fraudCount > 0) flags.push('fraud_reported');
    if (disputeCount > 0) flags.push('dispute_reported');

    if (this.probeRepo) {
      const probe = await this.probeRepo.findLatestAtTier(publicKeyHash, 1000);
      if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
        // Keep the same guard as v30: gossip-fresh nodes with a strong posterior
        // are still alive on the network. The probe failure is positional.
        const gossipFresh = (now - agent.last_seen) < DAY;
        const bayesStrong = bayes.verdict === 'SAFE';
        if (!gossipFresh || !bayesStrong) {
          flags.push('unreachable');
        }
      }
    }

    let pathfinding: PathfindingResult | null = null;
    if (this.lndClient) {
      const targetLnPubkey = agent.public_key ?? null;
      const callerAgent = callerPubkey ? await this.agentRepo.findByHash(callerPubkey) : null;
      const sourcePubkey = pathfindingSourcePubkey
        ?? callerAgent?.public_key
        ?? null;

      if (sourcePubkey && targetLnPubkey) {
        const cacheCallerHash = callerPubkey ?? sourcePubkey;
        pathfinding = await this.computePathfinding(sourcePubkey, targetLnPubkey, cacheCallerHash, publicKeyHash);
        if (pathfinding && !pathfinding.reachable) {
          flags.push('unreachable_from_caller');
        }
      }
    }

    if (pathfinding?.reachable) {
      const idx = flags.indexOf('unreachable');
      if (idx !== -1) flags.splice(idx, 1);
    }

    // Verdict overlay: fraud / dispute / negative_reputation evidence escalates
    // the Bayesian verdict to at least RISKY. Evidence-based risk cannot be
    // masked by posterior uncertainty.
    const hasCriticalFlags = flags.includes('fraud_reported')
      || flags.includes('negative_reputation');
    let verdict: Verdict = bayes.verdict;
    if (hasCriticalFlags && verdict !== 'RISKY') {
      verdict = 'RISKY';
    }

    const personalTrust = callerPubkey
      ? await this.computePersonalTrust(callerPubkey, publicKeyHash)
      : null;

    const riskProfile = this.riskService.classifyAgent(
      agent, delta, { regularity: scoreResult.components.regularity },
    );

    const reason = this.buildReason(agent, bayes, flags, ageDays);

    const reachability = this.probeRepo
      ? await this.probeRepo.computeUptime(publicKeyHash, REACHABILITY_WINDOW_SEC)
      : null;

    // Phase 7 C11+C12 : lookup operator par node_pubkey (la raw LN pubkey de
    // l'agent, pas le hash). On expose operator_id uniquement si status='verified' ;
    // sinon on passe l'info à computeAdvisoryReport pour qu'il émette l'advisory.
    const operatorLookup: OperatorResourceLookup | null =
      this.operatorService && agent.public_key
        ? await this.operatorService.resolveOperatorForNode(agent.public_key)
        : null;
    const operator_id = operatorLookup?.status === 'verified' ? operatorLookup.operatorId : null;

    const advisory = computeAdvisoryReport({
      bayesian: {
        p_success: bayes.p_success,
        ci95_low: bayes.ci95_low,
        ci95_high: bayes.ci95_high,
        n_obs: bayes.n_obs,
      },
      flags,
      reachability: reachability ?? undefined,
      delta7d: delta.delta7d,
      operatorLookup,
    });

    verdictTotal.inc({ verdict, source });
    return {
      verdict,
      p_success: bayes.p_success,
      ci95_low: bayes.ci95_low,
      ci95_high: bayes.ci95_high,
      n_obs: bayes.n_obs,
      sources: bayes.sources,
      convergence: bayes.convergence,
      recent_activity: bayes.recent_activity,
      risk_profile: bayes.risk_profile,
      time_constant_days: bayes.time_constant_days,
      last_update: bayes.last_update,
      reason,
      flags,
      personalTrust,
      riskProfile,
      pathfinding,
      advisory_level: advisory.advisory_level,
      risk_score: advisory.risk_score,
      advisories: advisory.advisories,
      reachability: reachability != null ? Math.round(reachability * 1000) / 1000 : null,
      operator_id,
    };
  }

  async computePathfinding(
    callerLnPubkey: string,
    targetLnPubkey: string,
    callerHash: string,
    targetHash: string,
  ): Promise<PathfindingResult | null> {
    if (!this.lndClient) return null;

    const cacheKey = `${callerHash}:${targetHash}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      cached.lastAccess = Date.now();
      return cached.result;
    }

    try {
      const startMs = Date.now();
      const response = await this.lndClient.queryRoutes(
        targetLnPubkey,
        config.PROBE_AMOUNT_SATS,
        callerLnPubkey,
      );
      const latencyMs = Date.now() - startMs;

      const routes = response.routes ?? [];
      const hasRoute = routes.length > 0;

      const result: PathfindingResult = {
        reachable: hasRoute,
        hops: hasRoute ? routes[0].hops.length : null,
        estimatedFeeMsat: hasRoute ? (parseInt(routes[0].total_fees_msat, 10) || 0) : null,
        alternatives: routes.length,
        latencyMs,
        source: 'lnd_queryroutes',
      };

      const now = Date.now();
      this.pathCache.set(cacheKey, { result, expiresAt: now + PATH_CACHE_TTL_MS, lastAccess: now });

      if (this.pathCache.size > PATH_CACHE_MAX_SIZE) {
        for (const [key, entry] of this.pathCache) {
          if (entry.expiresAt <= now) this.pathCache.delete(key);
        }
        if (this.pathCache.size > PATH_CACHE_MAX_SIZE) {
          const sorted = [...this.pathCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
          const excess = sorted.length - PATH_CACHE_MAX_SIZE;
          for (let i = 0; i < excess; i++) {
            this.pathCache.delete(sorted[i][0]);
          }
        }
      }

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ callerHash, targetHash, error: msg }, 'Pathfinding query failed');
      return null;
    }
  }

  private async computePersonalTrust(callerPubkey: string, targetHash: string): Promise<PersonalTrust> {
    const callerAttested = await this.attestationRepo.findPositivelyAttestedBy(callerPubkey, POSITIVE_ATTESTATION_MIN_SCORE);
    if (callerAttested.includes(targetHash)) {
      const callerAgent = await this.agentRepo.findByHash(callerPubkey);
      return {
        distance: 0,
        sharedConnections: 0,
        strongestConnection: callerAgent?.alias ?? (callerPubkey.slice(0, 10) + '...'),
      };
    }

    const targetAttesters = await this.attestationRepo.findPositiveAttestersOf(targetHash, POSITIVE_ATTESTATION_MIN_SCORE);
    const targetAttesterHashes = new Set(targetAttesters.map(a => a.attester_hash));

    const sharedAtDistance1 = callerAttested.filter(h => targetAttesterHashes.has(h));

    if (sharedAtDistance1.length > 0) {
      let strongest: { hash: string; score: number } | null = null;
      for (const hash of sharedAtDistance1) {
        const attesterEntry = targetAttesters.find(a => a.attester_hash === hash);
        if (attesterEntry && (!strongest || attesterEntry.score > strongest.score)) {
          strongest = { hash, score: attesterEntry.score };
        }
      }
      const strongestAgent = strongest ? await this.agentRepo.findByHash(strongest.hash) : null;

      return {
        distance: 1,
        sharedConnections: sharedAtDistance1.length,
        strongestConnection: strongestAgent?.alias ?? (strongest ? (strongest.hash.slice(0, 10) + '...') : null),
      };
    }

    const MAX_INTERMEDIARIES = 20;
    const distance2Connections: string[] = [];
    // Sequential for-of: each iteration may short-circuit on first hit; running
    // serially respects pool limits and lets the early-exit continue to work.
    for (const intermediary of callerAttested.slice(0, MAX_INTERMEDIARIES)) {
      const intermediaryAttested = await this.attestationRepo.findPositivelyAttestedBy(intermediary, POSITIVE_ATTESTATION_MIN_SCORE);
      for (const hop2 of intermediaryAttested) {
        if (targetAttesterHashes.has(hop2) && !distance2Connections.includes(hop2)) {
          distance2Connections.push(hop2);
        }
      }
      if (distance2Connections.length > 0) break;
    }

    if (distance2Connections.length > 0) {
      const strongestAgent = await this.agentRepo.findByHash(distance2Connections[0]);
      return {
        distance: 2,
        sharedConnections: distance2Connections.length,
        strongestConnection: strongestAgent?.alias ?? (distance2Connections[0].slice(0, 10) + '...'),
      };
    }

    return { distance: null, sharedConnections: 0, strongestConnection: null };
  }

  private buildReason(
    agent: { total_transactions: number; negative_ratings: number },
    bayes: { verdict: Verdict; verdict_reason: string; p_success: number; n_obs: number; time_constant_days: number },
    flags: VerdictFlag[],
    ageDays: number,
  ): string {
    const parts: string[] = [];
    parts.push(`${agent.total_transactions} tx completed`);
    if (flags.includes('fraud_reported')) {
      parts.push('fraud reported');
    } else if (flags.includes('dispute_reported')) {
      parts.push('dispute reported');
    } else if (flags.includes('unreachable')) {
      parts.push('unreachable via route probe');
    } else {
      parts.push(`${agent.negative_ratings} disputes`);
    }
    parts.push(`${Math.round(ageDays)}d history`);
    parts.push(`p_success=${bayes.p_success.toFixed(3)} (n=${bayes.n_obs}, τ=${bayes.time_constant_days}d)`);
    return parts.join(', ');
  }
}

function buildMissingAgentResponse(callerPubkey: string | undefined): VerdictResponse {
  // Missing agent ⇒ the unknown CI (width=1) saturates uncertainty_factor to 1.0.
  // With no other signals, risk_score = 0.15 → yellow. That's a faithful overlay
  // of "we know nothing" — distinct from green (evidence of safety).
  const advisory = computeAdvisoryReport({
    bayesian: { p_success: 0.5, ci95_low: 0, ci95_high: 1, n_obs: 0 },
    flags: [],
  });
  return {
    verdict: 'INSUFFICIENT',
    p_success: 0.5,
    ci95_low: 0,
    ci95_high: 1,
    n_obs: 0,
    sources: { probe: null, report: null, paid: null },
    convergence: { converged: false, sources_above_threshold: [], threshold: 0.8 },
    recent_activity: { last_24h: 0, last_7d: 0, last_30d: 0 },
    risk_profile: 'unknown',
    time_constant_days: 7,
    last_update: 0,
    reason: 'Agent not found in the SatRank index',
    flags: [],
    personalTrust: callerPubkey ? { distance: null, sharedConnections: 0, strongestConnection: null } : null,
    riskProfile: { name: 'unrated', riskLevel: 'unknown', description: 'Agent not found in the SatRank index.' },
    pathfinding: null,
    advisory_level: advisory.advisory_level,
    risk_score: advisory.risk_score,
    advisories: advisory.advisories,
    reachability: null,
    operator_id: null,
  };
}
