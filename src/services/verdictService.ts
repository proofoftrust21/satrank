// Verdict engine — SAFE / RISKY / UNKNOWN in < 200ms
// The binary decision an agent needs before accepting a transaction
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { ScoringService } from './scoringService';
import type { TrendService } from './trendService';
import type { RiskService } from './riskService';
import type { VerdictResponse, VerdictFlag, Verdict, ConfidenceLevel, PersonalTrust, PathfindingResult } from '../types';
import { DAY } from '../utils/constants';
import { computeBaseFlags } from '../utils/flags';
import { PROBE_FRESHNESS_TTL, VERDICT_SAFE_THRESHOLD } from '../config/scoring';
import { config } from '../config';
import { logger } from '../logger';
const POSITIVE_ATTESTATION_MIN_SCORE = 70;
const PATH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PATH_CACHE_MAX_SIZE = 1000;

const CONFIDENCE_MAP: Record<ConfidenceLevel, number> = {
  very_low: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  very_high: 0.9,
};

export class VerdictService {
  private pathCache = new Map<string, { result: PathfindingResult; expiresAt: number }>();

  constructor(
    private agentRepo: AgentRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private riskService: RiskService,
    private probeRepo?: ProbeRepository,
    private lndClient?: LndGraphClient,
  ) {}

  async getVerdict(publicKeyHash: string, callerPubkey?: string, pathfindingSourcePubkey?: string): Promise<VerdictResponse> {
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) {
      return {
        verdict: 'UNKNOWN',
        confidence: 0,
        reason: 'Agent not found in the SatRank index',
        flags: [],
        personalTrust: callerPubkey ? { distance: null, sharedConnections: 0, strongestConnection: null } : null,
        riskProfile: { name: 'default', riskLevel: 'unknown', description: 'Agent not found in the SatRank index.' },
        pathfinding: null,
      };
    }

    // Increment query count — demand signal
    this.agentRepo.incrementQueryCount(publicKeyHash);

    const scoreResult = this.scoringService.getScore(publicKeyHash);
    const delta = this.trendService.computeDeltas(publicKeyHash, scoreResult.total);

    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - agent.first_seen) / DAY;

    // Compute flags — M2: shared base flags to avoid drift with v2Controller
    const flags: VerdictFlag[] = computeBaseFlags(agent, delta, now);

    // Check structured negative attestations (fraud / dispute)
    const fraudCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['fraud']);
    const disputeCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['dispute']);
    if (fraudCount > 0) flags.push('fraud_reported');
    if (disputeCount > 0) flags.push('dispute_reported');

    // Check probe reachability — unreachable node is a risk signal (fresh probes only)
    if (this.probeRepo) {
      const probe = this.probeRepo.findLatest(publicKeyHash);
      if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
        flags.push('unreachable');
      }
    }

    // Determine verdict
    const confidenceNum = CONFIDENCE_MAP[scoreResult.confidence];
    const hasCriticalFlags = flags.includes('fraud_reported') || flags.includes('negative_reputation');

    let verdict: Verdict;
    // RISKY requires evidence of risk, not just absence of data.
    // Low score + very_low confidence = UNKNOWN (insufficient data), not RISKY.
    const hasRiskEvidence = hasCriticalFlags ||
      flags.includes('unreachable') ||
      (delta.delta7d !== null && delta.delta7d < -15) ||
      (scoreResult.total < 30 && confidenceNum >= CONFIDENCE_MAP.low);
    if (hasRiskEvidence) {
      verdict = 'RISKY';
    } else if (
      scoreResult.total >= VERDICT_SAFE_THRESHOLD &&
      !hasCriticalFlags &&
      confidenceNum >= CONFIDENCE_MAP.medium
    ) {
      verdict = 'SAFE';
    } else {
      // Score below SAFE threshold but above RISKY evidence — insufficient signal
      verdict = 'UNKNOWN';
    }

    // Personal trust graph
    const personalTrust = callerPubkey
      ? this.computePersonalTrust(callerPubkey, publicKeyHash)
      : null;

    // Risk profile
    const riskProfile = this.riskService.classifyAgent(
      agent, delta, { regularity: scoreResult.components.regularity },
    );

    // Personalized pathfinding — real-time route query from source to target.
    // Source priority: pathfindingSourcePubkey (walletProvider/callerNodePubkey) > caller's own LN pubkey.
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

    // Build human-readable reason
    const reason = this.buildReason(agent, scoreResult.total, delta.delta7d, ageDays, flags);

    return { verdict, confidence: confidenceNum, reason, flags, personalTrust, riskProfile, pathfinding };
  }

  async computePathfinding(
    callerLnPubkey: string,
    targetLnPubkey: string,
    callerHash: string,
    targetHash: string,
  ): Promise<PathfindingResult | null> {
    if (!this.lndClient) return null;

    // Check cache
    const cacheKey = `${callerHash}:${targetHash}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
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

      // Cache result — enforce max size with LRU-style eviction
      this.pathCache.set(cacheKey, { result, expiresAt: Date.now() + PATH_CACHE_TTL_MS });

      if (this.pathCache.size > PATH_CACHE_MAX_SIZE) {
        const now = Date.now();
        for (const [key, entry] of this.pathCache) {
          if (entry.expiresAt <= now) this.pathCache.delete(key);
        }
        // If still over limit after TTL eviction, drop oldest entries (Map iterates in insertion order)
        if (this.pathCache.size > PATH_CACHE_MAX_SIZE) {
          const excess = this.pathCache.size - PATH_CACHE_MAX_SIZE;
          let removed = 0;
          for (const key of this.pathCache.keys()) {
            if (removed >= excess) break;
            this.pathCache.delete(key);
            removed++;
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
    // Distance 0 — caller directly attested the target
    const callerAttested = this.attestationRepo.findPositivelyAttestedBy(callerPubkey, POSITIVE_ATTESTATION_MIN_SCORE);
    if (callerAttested.includes(targetHash)) {
      const callerAgent = this.agentRepo.findByHash(callerPubkey);
      return {
        distance: 0,
        sharedConnections: 0,
        strongestConnection: callerAgent?.alias ?? (callerPubkey.slice(0, 10) + '...'),
      };
    }

    // Distance 1 — find agents attested by caller who also attested target
    const targetAttesters = this.attestationRepo.findPositiveAttestersOf(targetHash, POSITIVE_ATTESTATION_MIN_SCORE);
    const targetAttesterHashes = new Set(targetAttesters.map(a => a.attester_hash));

    const sharedAtDistance1 = callerAttested.filter(h => targetAttesterHashes.has(h));

    if (sharedAtDistance1.length > 0) {
      // Find strongest connection (highest score attester among shared)
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

    // Distance 2 — agents attested by caller → agents they attested → did any of those attest target?
    // Cap intermediaries to prevent unbounded N+1 DB queries
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

    // No connection found
    return { distance: null, sharedConnections: 0, strongestConnection: null };
  }

  private buildReason(
    agent: { total_transactions: number; positive_ratings: number; negative_ratings: number },
    score: number,
    delta7d: number | null,
    ageDays: number,
    flags: VerdictFlag[],
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
      const disputes = agent.negative_ratings;
      parts.push(`${disputes} disputes`);
    }
    parts.push(`${Math.round(ageDays)}d history`);
    if (delta7d !== null && delta7d !== 0) {
      const dir = delta7d > 0 ? '+' : '';
      parts.push(`score ${dir}${delta7d} in 7d`);
    } else {
      parts.push('score stable');
    }
    return parts.join(', ');
  }
}
