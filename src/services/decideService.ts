// Decision engine — GO / NO-GO with success probability
// Transforms SatRank from information service to decision infrastructure
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { ScoringService } from './scoringService';
import type { TrendService } from './trendService';
import type { RiskService } from './riskService';
import type { VerdictService } from './verdictService';
import type { SurvivalService } from './survivalService';
import type { DecideResponse, VerdictFlag, Verdict, ConfidenceLevel, PathfindingResult } from '../types';
import { SEVEN_DAYS_SEC } from '../utils/constants';
import { logger } from '../logger';
const EMPIRICAL_THRESHOLD = 10; // min data points before using empirical basis

// Sigmoid function: maps score (0-100) to probability (0-1), centered at 50
function sigmoid(score: number, midpoint: number = 50, steepness: number = 0.1): number {
  return 1 / (1 + Math.exp(-steepness * (score - midpoint)));
}

export class DecideService {
  constructor(
    private agentRepo: AgentRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private riskService: RiskService,
    private verdictService: VerdictService,
    private probeRepo?: ProbeRepository,
    private lndClient?: LndGraphClient,
    private survivalService?: SurvivalService,
  ) {}

  async decide(
    targetHash: string,
    callerHash: string,
    amountSats?: number,
  ): Promise<DecideResponse> {
    const startMs = Date.now();

    // Mark as hot node for priority probing
    this.agentRepo.touchLastQueried(targetHash);

    // Get the full verdict (reuses pathfinding, personal trust, flags, risk profile)
    const verdictResult = await this.verdictService.getVerdict(targetHash, callerHash);

    // P_trust — sigmoid of the trust score, centered at 50
    const scoreResult = this.scoringService.getScore(targetHash);
    const pTrust = sigmoid(scoreResult.total);

    // P_routable — is there a Lightning route from caller to target?
    let pRoutable = 0.5; // default when no pathfinding data
    if (verdictResult.pathfinding) {
      pRoutable = verdictResult.pathfinding.reachable ? 1.0 : 0.0;
    }

    // P_available — probe uptime over 7 days
    let pAvailable = 0.5; // default when no probe data
    let lastProbeAgeMs: number | null = null;
    if (this.probeRepo) {
      const uptime = this.probeRepo.computeUptime(targetHash, SEVEN_DAYS_SEC);
      if (uptime !== null) {
        pAvailable = uptime;
      }
      const lastProbe = this.probeRepo.findLatest(targetHash);
      if (lastProbe) {
        lastProbeAgeMs = Math.round(Date.now() - lastProbe.probed_at * 1000);
      }
    }

    // P_empirical — historical success rate from reports
    const { rate: empiricalRate, dataPoints, uniqueReporters } = this.attestationRepo.weightedSuccessRate(targetHash);
    // Require both sufficient data points AND diverse reporters to avoid single-agent self-reporting
    const hasEmpirical = dataPoints >= EMPIRICAL_THRESHOLD && uniqueReporters >= 5;
    const pEmpirical = hasEmpirical ? empiricalRate : pTrust; // fallback to proxy

    // Composite success rate
    const basis: 'proxy' | 'empirical' = hasEmpirical ? 'empirical' : 'proxy';
    let successRate: number;
    if (hasEmpirical) {
      // Empirical mode: P_empirical dominates, but P_trust stays as safety net (node health)
      successRate = pEmpirical * 0.45 + pTrust * 0.10 + pRoutable * 0.225 + pAvailable * 0.225;
    } else {
      // Proxy mode: trust score as primary signal
      successRate = pTrust * 0.4 + pRoutable * 0.3 + pAvailable * 0.3;
    }

    // Clamp to [0, 1]
    successRate = Math.max(0, Math.min(1, successRate));

    // GO decision: successRate >= 0.5 AND no critical flags
    const hasCritical = verdictResult.flags.includes('fraud_reported') ||
      verdictResult.flags.includes('negative_reputation');
    const go = successRate >= 0.5 && !hasCritical;

    const survival = this.survivalService
      ? this.survivalService.compute(targetHash)
      : { score: 100, prediction: 'stable' as const, signals: { scoreTrajectory: 'no data', probeStability: 'no data', gossipFreshness: 'no data' } };

    const latencyMs = Date.now() - startMs;

    return {
      go,
      successRate: Math.round(successRate * 1000) / 1000,
      components: {
        trustScore: Math.round(pTrust * 1000) / 1000,
        routable: Math.round(pRoutable * 1000) / 1000,
        available: Math.round(pAvailable * 1000) / 1000,
        empirical: Math.round(pEmpirical * 1000) / 1000,
      },
      basis,
      confidence: scoreResult.confidence,
      verdict: verdictResult.verdict,
      flags: verdictResult.flags,
      pathfinding: verdictResult.pathfinding,
      riskProfile: verdictResult.riskProfile,
      reason: verdictResult.reason,
      survival,
      lastProbeAgeMs,
      latencyMs,
    };
  }
}
