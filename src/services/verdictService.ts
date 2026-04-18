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
import type { VerdictResponse, VerdictFlag, Verdict, PersonalTrust, PathfindingResult } from '../types';
import { DAY } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL } from '../config/scoring';
import { config } from '../config';
import { logger } from '../logger';
import { verdictTotal } from '../middleware/metrics';

const POSITIVE_ATTESTATION_MIN_SCORE = 70;
const PATH_CACHE_TTL_MS = 5 * 60 * 1000;
const PATH_CACHE_MAX_SIZE = 1000;

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
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) {
      verdictTotal.inc({ verdict: 'INSUFFICIENT', source });
      return buildMissingAgentResponse(callerPubkey);
    }

    this.agentRepo.incrementQueryCount(publicKeyHash);

    const bayes = this.bayesianVerdict.buildVerdict({ targetHash: publicKeyHash });

    // Risk classifier + flags still need the composite internally. The value is
    // not surfaced — it feeds `regularity` for the riskProfile and delta-based
    // flags. Will be rewired in Commit 8 when the composite columns drop.
    const scoreResult = precomputedScore ?? this.scoringService.getScore(publicKeyHash);
    const delta = this.trendService.computeDeltas(publicKeyHash, scoreResult.total);

    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - agent.first_seen) / DAY;

    const flags: VerdictFlag[] = computeBaseFlags(agent, delta, now);

    const fraudCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['fraud']);
    const disputeCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['dispute']);
    if (fraudCount > 0) flags.push('fraud_reported');
    if (disputeCount > 0) flags.push('dispute_reported');

    if (this.probeRepo) {
      const probe = this.probeRepo.findLatestAtTier(publicKeyHash, 1000);
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
      const sourcePubkey = pathfindingSourcePubkey
        ?? this.agentRepo.findByHash(callerPubkey ?? '')?.public_key
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
      ? this.computePersonalTrust(callerPubkey, publicKeyHash)
      : null;

    const riskProfile = this.riskService.classifyAgent(
      agent, delta, { regularity: scoreResult.components.regularity },
    );

    const reason = this.buildReason(agent, bayes, flags, ageDays);

    verdictTotal.inc({ verdict, source });
    return {
      verdict,
      p_success: bayes.p_success,
      ci95_low: bayes.ci95_low,
      ci95_high: bayes.ci95_high,
      n_obs: bayes.n_obs,
      window: bayes.window,
      sources: bayes.sources,
      convergence: bayes.convergence,
      reason,
      flags,
      personalTrust,
      riskProfile,
      pathfinding,
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

  private computePersonalTrust(callerPubkey: string, targetHash: string): PersonalTrust {
    const callerAttested = this.attestationRepo.findPositivelyAttestedBy(callerPubkey, POSITIVE_ATTESTATION_MIN_SCORE);
    if (callerAttested.includes(targetHash)) {
      const callerAgent = this.agentRepo.findByHash(callerPubkey);
      return {
        distance: 0,
        sharedConnections: 0,
        strongestConnection: callerAgent?.alias ?? (callerPubkey.slice(0, 10) + '...'),
      };
    }

    const targetAttesters = this.attestationRepo.findPositiveAttestersOf(targetHash, POSITIVE_ATTESTATION_MIN_SCORE);
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
      const strongestAgent = strongest ? this.agentRepo.findByHash(strongest.hash) : null;

      return {
        distance: 1,
        sharedConnections: sharedAtDistance1.length,
        strongestConnection: strongestAgent?.alias ?? (strongest ? (strongest.hash.slice(0, 10) + '...') : null),
      };
    }

    const MAX_INTERMEDIARIES = 20;
    const distance2Connections: string[] = [];
    for (const intermediary of callerAttested.slice(0, MAX_INTERMEDIARIES)) {
      const intermediaryAttested = this.attestationRepo.findPositivelyAttestedBy(intermediary, POSITIVE_ATTESTATION_MIN_SCORE);
      for (const hop2 of intermediaryAttested) {
        if (targetAttesterHashes.has(hop2) && !distance2Connections.includes(hop2)) {
          distance2Connections.push(hop2);
        }
      }
      if (distance2Connections.length > 0) break;
    }

    if (distance2Connections.length > 0) {
      const strongestAgent = this.agentRepo.findByHash(distance2Connections[0]);
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
    bayes: { verdict: Verdict; verdict_reason: string; p_success: number; n_obs: number; window: string },
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
    parts.push(`p_success=${bayes.p_success.toFixed(3)} (n=${bayes.n_obs}, ${bayes.window})`);
    return parts.join(', ');
  }
}

function buildMissingAgentResponse(callerPubkey: string | undefined): VerdictResponse {
  return {
    verdict: 'INSUFFICIENT',
    p_success: 0.5,
    ci95_low: 0,
    ci95_high: 1,
    n_obs: 0,
    window: '30d',
    sources: { probe: null, report: null, paid: null },
    convergence: { converged: false, sources_above_threshold: [], threshold: 0.8 },
    reason: 'Agent not found in the SatRank index',
    flags: [],
    personalTrust: callerPubkey ? { distance: null, sharedConnections: 0, strongestConnection: null } : null,
    riskProfile: { name: 'unrated', riskLevel: 'unknown', description: 'Agent not found in the SatRank index.' },
    pathfinding: null,
  };
}
