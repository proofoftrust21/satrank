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
  ) {}

  async decide(
    targetHash: string,
    callerHash: string,
    amountSats?: number,
  ): Promise<DecideResponse> {
    const startMs = Date.now();

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
    if (this.probeRepo) {
      const uptime = this.probeRepo.computeUptime(targetHash, SEVEN_DAYS_SEC);
      if (uptime !== null) {
        pAvailable = uptime;
      }
    }

    // P_empirical — historical success rate from reports
    const { rate: empiricalRate, dataPoints } = this.attestationRepo.weightedSuccessRate(targetHash);
    const hasEmpirical = dataPoints >= EMPIRICAL_THRESHOLD;
    const pEmpirical = hasEmpirical ? empiricalRate : pTrust; // fallback to proxy

    // Composite success rate
    const basis: 'proxy' | 'empirical' = hasEmpirical ? 'empirical' : 'proxy';
    let successRate: number;
    if (hasEmpirical) {
      // Empirical mode: weight empirical data heavily, but still factor routability and availability
      successRate = pEmpirical * 0.5 + pRoutable * 0.25 + pAvailable * 0.25;
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

    const latencyMs = Date.now() - startMs;

    return {
      go,
      successRate: Math.round(successRate * 1000) / 1000, // 3 decimal places
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
      latencyMs,
    };
  }
}
