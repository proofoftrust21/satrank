// Verdict engine — SAFE / RISKY / UNKNOWN in < 200ms
// The binary decision an agent needs before accepting a transaction
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ScoringService } from './scoringService';
import type { TrendService } from './trendService';
import type { RiskService } from './riskService';
import type { VerdictResponse, VerdictFlag, Verdict, ConfidenceLevel, PersonalTrust } from '../types';
import { DAY } from '../utils/constants';
const POSITIVE_ATTESTATION_MIN_SCORE = 70;

const CONFIDENCE_MAP: Record<ConfidenceLevel, number> = {
  very_low: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  very_high: 0.9,
};

export class VerdictService {
  constructor(
    private agentRepo: AgentRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private riskService: RiskService,
  ) {}

  getVerdict(publicKeyHash: string, callerPubkey?: string): VerdictResponse {
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) {
      return {
        verdict: 'UNKNOWN',
        confidence: 0,
        reason: 'Agent not found in the SatRank index',
        flags: [],
        personalTrust: callerPubkey ? { distance: null, sharedConnections: 0, strongestConnection: null } : null,
        riskProfile: { name: 'default', riskLevel: 'unknown', description: 'Agent not found in the SatRank index.' },
      };
    }

    // Increment query count — demand signal
    this.agentRepo.incrementQueryCount(publicKeyHash);

    const scoreResult = this.scoringService.getScore(publicKeyHash);
    const delta = this.trendService.computeDeltas(publicKeyHash, scoreResult.total);

    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - agent.first_seen) / DAY;

    // Compute flags
    const flags: VerdictFlag[] = [];

    if (ageDays < 30) flags.push('new_agent');
    if (agent.total_transactions < 10) flags.push('low_volume');
    if (delta.delta7d !== null && delta.delta7d < -10) flags.push('rapid_decline');
    if (delta.delta7d !== null && delta.delta7d > 15) flags.push('rapid_rise');
    if (agent.negative_ratings > agent.positive_ratings) flags.push('negative_reputation');
    if (agent.query_count > 50) flags.push('high_demand');
    if (agent.lnplus_rank === 0 && agent.positive_ratings === 0) flags.push('no_reputation_data');

    // Check structured negative attestations (fraud / dispute)
    const fraudCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['fraud']);
    const disputeCount = this.attestationRepo.countByCategoryForSubject(publicKeyHash, ['dispute']);
    if (fraudCount > 0) flags.push('fraud_reported');
    if (disputeCount > 0) flags.push('dispute_reported');

    // Determine verdict
    const confidenceNum = CONFIDENCE_MAP[scoreResult.confidence];
    const hasCriticalFlags = flags.includes('fraud_reported') || flags.includes('negative_reputation');

    let verdict: Verdict;
    if (
      scoreResult.total < 30 ||
      (delta.delta7d !== null && delta.delta7d < -15) ||
      hasCriticalFlags
    ) {
      verdict = 'RISKY';
    } else if (
      scoreResult.total >= 50 &&
      !hasCriticalFlags &&
      confidenceNum >= CONFIDENCE_MAP.medium
    ) {
      verdict = 'SAFE';
    } else {
      // Score 30-49 or low confidence — insufficient signal to declare SAFE or RISKY
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

    // Build human-readable reason
    const reason = this.buildReason(agent, scoreResult.total, delta.delta7d, ageDays, flags);

    return { verdict, confidence: confidenceNum, reason, flags, personalTrust, riskProfile };
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
