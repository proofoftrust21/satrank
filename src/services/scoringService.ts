// Composite scoring engine — the core of SatRank
// Score 0-100 computed from 5 weighted components, with reinforced anti-gaming
import { v4 as uuid } from 'uuid';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoreComponents, ConfidenceLevel } from '../types';
import { logger } from '../logger';

// Weight of each component in the final score
const WEIGHTS = {
  volume: 0.25,
  reputation: 0.30,
  seniority: 0.15,
  regularity: 0.15,
  diversity: 0.15,
} as const;

// Half-life for exponential decay of attestations (30 days in seconds)
const ATTESTATION_HALF_LIFE = 30 * 24 * 3600;

// Minimum seniority (in days) for an attester to be credible
const MIN_ATTESTER_AGE_DAYS = 7;

// --- Anti-gaming ---

// Direct mutual attestations (A<->B): nearly eliminated
const MUTUAL_ATTESTATION_PENALTY = 0.05;

// Score cap for suspect attestations (mutual or cluster)
const SUSPECT_ATTESTATION_SCORE_CAP = 40;

// Attestations from a circular cluster (A->B->C->A)
const CIRCULAR_CLUSTER_PENALTY = 0.1;

// Penalty multiplier on final score for "manual" source agents
const MANUAL_SOURCE_PENALTY_THRESHOLD = 150;
const MANUAL_SOURCE_MIN_MULTIPLIER = 0.5;

// Attestation concentration: few sources attest a lot -> suspicious
const ATTESTATION_CONCENTRATION_THRESHOLD = 2.5;
const ATTESTATION_CONCENTRATION_PENALTY = 0.3;

// Minimum time between score recomputations (in seconds)
const SCORE_CACHE_TTL = 300; // 5 minutes

export interface ScoreResult {
  total: number;
  components: ScoreComponents;
  confidence: ConfidenceLevel;
  computedAt: number;
}

export class ScoringService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  // Returns an agent's score, using cache if the score is recent
  getScore(agentHash: string): ScoreResult {
    const now = Math.floor(Date.now() / 1000);

    // Check if a recent snapshot exists (avoids writes on every GET)
    const latest = this.snapshotRepo.findLatestByAgent(agentHash);
    if (latest && (now - latest.computed_at) < SCORE_CACHE_TTL) {
      const agent = this.agentRepo.findByHash(agentHash);
      const components = this.safeParseComponents(latest.components);
      if (components) {
        return {
          total: latest.score,
          components,
          confidence: agent
            ? this.deriveConfidence(agent.total_transactions, agent.total_attestations_received)
            : 'very_low',
          computedAt: latest.computed_at,
        };
      }
      // Corrupted components -> recompute score
    }

    return this.computeScore(agentHash);
  }

  // Computes the full score for an agent and persists a snapshot
  computeScore(agentHash: string): ScoreResult {
    const now = Math.floor(Date.now() / 1000);
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent) {
      return { total: 0, components: { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 }, confidence: 'very_low', computedAt: now };
    }

    const isLightningGraph = agent.source === 'lightning_graph';
    const verifiedTxCount = isLightningGraph ? 0 : this.txRepo.countVerifiedByAgent(agentHash);

    const components: ScoreComponents = {
      volume: isLightningGraph
        ? this.computeLightningVolume(agent.total_transactions, agent.capacity_sats)
        : this.computeVolume(verifiedTxCount),
      reputation: this.computeReputation(agentHash, now),
      seniority: this.computeSeniority(agent.first_seen, now),
      regularity: isLightningGraph
        ? this.computeLightningRegularity(agent.last_seen, now)
        : this.computeRegularity(agentHash),
      diversity: isLightningGraph
        ? this.computeLightningDiversity(agent.total_transactions)
        : this.computeDiversity(agentHash),
    };

    let total = Math.round(
      components.volume * WEIGHTS.volume +
      components.reputation * WEIGHTS.reputation +
      components.seniority * WEIGHTS.seniority +
      components.regularity * WEIGHTS.regularity +
      components.diversity * WEIGHTS.diversity
    );

    // "manual" source penalty: linear ramp from 0.5 (0 tx) to 1.0 (150 tx)
    if (agent.source === 'manual' && verifiedTxCount < MANUAL_SOURCE_PENALTY_THRESHOLD) {
      const ratio = verifiedTxCount / MANUAL_SOURCE_PENALTY_THRESHOLD;
      const penaltyMultiplier = MANUAL_SOURCE_MIN_MULTIPLIER + (1 - MANUAL_SOURCE_MIN_MULTIPLIER) * ratio;
      total = Math.round(total * penaltyMultiplier);
      logger.debug({ agentHash, source: agent.source, verifiedTxCount, penaltyMultiplier }, 'Manual source penalty applied');
    }

    const confidence = this.deriveConfidence(agent.total_transactions, agent.total_attestations_received);

    // Persist the snapshot
    this.snapshotRepo.insert({
      snapshot_id: uuid(),
      agent_hash: agentHash,
      score: total,
      components: JSON.stringify(components),
      computed_at: now,
    });

    // Update the denormalized score in the agents table
    this.agentRepo.updateStats(agentHash, agent.total_transactions, agent.total_attestations_received, total, agent.first_seen, agent.last_seen);

    logger.debug({ agentHash, total, components }, 'Score computed');

    return { total, components, confidence, computedAt: now };
  }

  // --- Lightning graph scoring ---

  private computeLightningVolume(channels: number, capacitySats: number | null): number {
    if (channels === 0) return 0;
    // Channel count on same log scale as transaction volume
    const channelScore = this.computeVolume(channels);
    // Capacity bonus: up to +20 points for high-capacity nodes (10 BTC+ = max bonus)
    const capacityBonus = capacitySats
      ? Math.min(20, Math.round(Math.log10(capacitySats / 1_000_000 + 1) * 10))
      : 0;
    return Math.min(100, channelScore + capacityBonus);
  }

  private computeLightningRegularity(lastSeen: number, now: number): number {
    // Score based on recency of node update — 30-day decay
    const daysSinceUpdate = (now - lastSeen) / 86400;
    if (daysSinceUpdate <= 0) return 100;
    return Math.min(100, Math.round(100 * Math.exp(-daysSinceUpdate / 30)));
  }

  private computeLightningDiversity(channels: number): number {
    // Each channel is with a unique peer — channels = diversity proxy
    if (channels === 0) return 0;
    const score = (Math.log(channels + 1) / Math.log(51)) * 100;
    return Math.min(100, Math.round(score));
  }

  private computeVolume(count: number): number {
    if (count === 0) return 0;
    const score = (Math.log(count + 1) / Math.log(1001)) * 100;
    return Math.min(100, Math.round(score));
  }

  // Reputation with reinforced anti-gaming
  // Batch attester lookups to avoid N+1 queries
  private computeReputation(agentHash: string, now: number): number {
    const attestations = this.attestationRepo.findBySubject(agentHash, 1000, 0);
    if (attestations.length === 0) return 0;

    const mutualAgents = new Set(this.attestationRepo.findMutualAttestations(agentHash));
    const clusterMembers = new Set(this.attestationRepo.findCircularCluster(agentHash));

    const uniqueAttesters = this.attestationRepo.countUniqueAttesters(agentHash);
    const concentrationRatio = uniqueAttesters > 0 ? attestations.length / uniqueAttesters : 0;
    const isConcentrated = concentrationRatio > ATTESTATION_CONCENTRATION_THRESHOLD;

    // Batch: load all attesters and their snapshots in 2 queries instead of 2N
    const attesterHashes = [...new Set(attestations.map(a => a.attester_hash))];
    const attesterAgents = this.agentRepo.findByHashes(attesterHashes);
    const attesterMap = new Map(attesterAgents.map(a => [a.public_key_hash, a]));
    const snapshotMap = this.snapshotRepo.findLatestByAgents(attesterHashes);

    let weightedSum = 0;
    let totalWeight = 0;

    for (const att of attestations) {
      const age = now - att.timestamp;
      let weight = Math.pow(0.5, age / ATTESTATION_HALF_LIFE);
      let effectiveScore = att.score;

      const attester = attesterMap.get(att.attester_hash);
      if (attester) {
        const attesterAgeDays = (now - attester.first_seen) / 86400;
        if (attesterAgeDays < MIN_ATTESTER_AGE_DAYS) {
          weight *= 0.05;
        } else {
          const latestSnapshot = snapshotMap.get(att.attester_hash);
          const attesterScore = latestSnapshot ? latestSnapshot.score : attester.avg_score;
          weight *= (attesterScore / 100) || 0.3;
        }
      }

      // Anti-gaming: direct mutual attestation (A<->B)
      if (mutualAgents.has(att.attester_hash)) {
        weight *= MUTUAL_ATTESTATION_PENALTY;
        effectiveScore = Math.min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP);
      }

      // Anti-gaming: circular cluster (A->B->C->A)
      if (clusterMembers.has(att.attester_hash)) {
        weight *= CIRCULAR_CLUSTER_PENALTY;
        effectiveScore = Math.min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP);
      }

      // Source concentration
      if (isConcentrated) {
        weight *= ATTESTATION_CONCENTRATION_PENALTY;
      }

      weightedSum += effectiveScore * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;
    return Math.min(100, Math.round(weightedSum / totalWeight));
  }

  private computeSeniority(firstSeen: number, now: number): number {
    const days = (now - firstSeen) / 86400;
    if (days <= 0) return 0;
    const score = 100 * (1 - Math.exp(-days / 180));
    return Math.round(score);
  }

  private computeRegularity(agentHash: string): number {
    const timestamps = this.txRepo.getTimestampsByAgent(agentHash);
    if (timestamps.length < 3) return 0;

    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean === 0) return 0;

    const variance = intervals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / mean;

    const score = 100 * Math.exp(-cv);
    return Math.min(100, Math.round(score));
  }

  private computeDiversity(agentHash: string): number {
    const count = this.txRepo.countUniqueCounterparties(agentHash);
    if (count === 0) return 0;
    const score = (Math.log(count + 1) / Math.log(51)) * 100;
    return Math.min(100, Math.round(score));
  }

  private safeParseComponents(json: string): ScoreComponents | null {
    try {
      const parsed = JSON.parse(json);
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof parsed.volume === 'number' && typeof parsed.reputation === 'number' &&
        typeof parsed.seniority === 'number' && typeof parsed.regularity === 'number' &&
        typeof parsed.diversity === 'number'
      ) {
        return parsed as ScoreComponents;
      }
      logger.warn({ json: json.slice(0, 100) }, 'Invalid ScoreComponents');
      return null;
    } catch {
      logger.warn({ json: json.slice(0, 100) }, 'JSON.parse components failed');
      return null;
    }
  }

  private deriveConfidence(totalTx: number, totalAttestations: number): ConfidenceLevel {
    const dataPoints = totalTx + totalAttestations;
    if (dataPoints < 5) return 'very_low';
    if (dataPoints < 20) return 'low';
    if (dataPoints < 100) return 'medium';
    if (dataPoints < 500) return 'high';
    return 'very_high';
  }
}
