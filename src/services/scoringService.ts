// Composite scoring engine — the core of SatRank
// Score 0-100 computed from 5 weighted components, with reinforced anti-gaming
// All tunable constants are in src/config/scoring.ts
import { v4 as uuid } from 'uuid';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoreComponents, ConfidenceLevel } from '../types';
import { logger } from '../logger';
import { computePopularityBonus } from '../utils/scoring';
import {
  WEIGHTS,
  ATTESTATION_HALF_LIFE,
  MIN_ATTESTER_AGE_DAYS,
  UNKNOWN_ATTESTER_WEIGHT,
  YOUNG_ATTESTER_WEIGHT,
  MUTUAL_ATTESTATION_PENALTY,
  SUSPECT_ATTESTATION_SCORE_CAP,
  CIRCULAR_CLUSTER_PENALTY,
  MANUAL_SOURCE_PENALTY_THRESHOLD,
  MANUAL_SOURCE_MIN_MULTIPLIER,
  ATTESTATION_CONCENTRATION_THRESHOLD,
  ATTESTATION_CONCENTRATION_PENALTY,
  VERIFIED_TX_BONUS_CAP,
  VERIFIED_TX_BONUS_PER_TX,
  LN_VOLUME_HEADROOM,
  LN_VOLUME_POWER,
  LN_REGULARITY_DECAY_DAYS,
  SATS_PER_BTC,
  LN_DIVERSITY_LOG_BASE,
  LN_DIVERSITY_BTC_MULTIPLIER,
  LNPLUS_RANK_MULTIPLIER,
  LNPLUS_RATINGS_WEIGHT,
  NEGATIVE_RATINGS_PENALTY,
  CENTRALITY_BONUS_MULTIPLIER,
  CENTRALITY_DECAY_CONSTANT,
  VOLUME_LOG_BASE,
  DIVERSITY_LOG_BASE,
  SENIORITY_HALF_LIFE_DAYS,
  CONFIDENCE_VERY_LOW,
  CONFIDENCE_LOW,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_HIGH,
  SCORE_CACHE_TTL,
} from '../config/scoring';

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
    const maxNetworkChannels = isLightningGraph ? this.agentRepo.maxChannels() : 0;

    const components: ScoreComponents = {
      volume: isLightningGraph
        ? this.computeLightningVolume(agent.total_transactions, maxNetworkChannels)
        : this.computeVolume(verifiedTxCount),
      reputation: isLightningGraph
        ? this.computeLightningReputation(agent.positive_ratings, agent.negative_ratings, agent.lnplus_rank, agent.hubness_rank, agent.betweenness_rank)
        : this.computeReputation(agentHash, now),
      seniority: this.computeSeniority(agent.first_seen, now),
      regularity: isLightningGraph
        ? this.computeLightningRegularity(agent.last_seen, now)
        : this.computeRegularity(agentHash),
      diversity: isLightningGraph
        ? this.computeLightningDiversity(agent.capacity_sats)
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

    // Verified transaction bonus — real Observer Protocol tx boost any agent's score
    const verifiedForBonus = isLightningGraph
      ? this.txRepo.countVerifiedByAgent(agentHash)
      : verifiedTxCount;
    if (verifiedForBonus > 0) {
      total = Math.min(100, total + Math.min(VERIFIED_TX_BONUS_CAP, Math.round(verifiedForBonus * VERIFIED_TX_BONUS_PER_TX)));
    }

    // Popularity bonus — agents that are queried more often get a small boost
    const popularityBonus = computePopularityBonus(agent.query_count);
    if (popularityBonus > 0) {
      total = Math.min(100, total + popularityBonus);
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

  private computeLightningVolume(channels: number, maxNetworkChannels: number): number {
    if (channels === 0 || maxNetworkChannels === 0) return 0;
    // Network-relative: score proportional to max, with power curve for spread
    // ACINQ (1988ch, max ~2000) → ~95, 120ch → ~30
    const reference = maxNetworkChannels * LN_VOLUME_HEADROOM;
    const ratio = Math.min(1, channels / reference);
    return Math.min(100, Math.round(Math.pow(ratio, LN_VOLUME_POWER) * 100));
  }

  private computeLightningRegularity(lastSeen: number, now: number): number {
    // Score based on recency of node update — 30-day decay
    const daysSinceUpdate = (now - lastSeen) / 86400;
    if (daysSinceUpdate <= 0) return 100;
    return Math.min(100, Math.round(100 * Math.exp(-daysSinceUpdate / LN_REGULARITY_DECAY_DAYS)));
  }

  private computeLightningDiversity(capacitySats: number | null): number {
    // Capacity as diversity proxy — more BTC locked = broader network participation
    // 59 BTC → ~92, 5 BTC → ~57, 0.05 BTC → ~6
    if (!capacitySats || capacitySats <= 0) return 0;
    const btc = capacitySats / SATS_PER_BTC;
    const score = (Math.log10(btc * LN_DIVERSITY_BTC_MULTIPLIER + 1) / Math.log10(LN_DIVERSITY_LOG_BASE)) * 100;
    return Math.min(100, Math.round(score));
  }

  // LN+ ratings-based reputation for Lightning nodes
  // See config/scoring.ts for LNPLUS_RANK_MULTIPLIER, LNPLUS_RATINGS_WEIGHT, CENTRALITY_* constants
  private computeLightningReputation(positive: number, negative: number, lnpRank: number, hubnessRank: number, betweennessRank: number): number {
    if (positive === 0 && negative === 0 && lnpRank === 0 && hubnessRank === 0 && betweennessRank === 0) return 0;
    let score = lnpRank * LNPLUS_RANK_MULTIPLIER;
    if (positive > 0) {
      const ratio = positive / (positive + negative + 1);
      score += ratio * LNPLUS_RATINGS_WEIGHT;
    }
    // Negative ratings penalty: reduces score when negatives dominate
    if (negative > 0) {
      const negRatio = negative / (positive + negative + 1);
      score -= negRatio * NEGATIVE_RATINGS_PENALTY;
    }
    if (hubnessRank > 0) score += CENTRALITY_BONUS_MULTIPLIER * Math.exp(-hubnessRank / CENTRALITY_DECAY_CONSTANT);
    if (betweennessRank > 0) score += CENTRALITY_BONUS_MULTIPLIER * Math.exp(-betweennessRank / CENTRALITY_DECAY_CONSTANT);
    return Math.min(100, Math.max(0, Math.round(score)));
  }

  private computeVolume(count: number): number {
    if (count === 0) return 0;
    const score = (Math.log(count + 1) / Math.log(VOLUME_LOG_BASE)) * 100;
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
          weight *= YOUNG_ATTESTER_WEIGHT;
        } else {
          const latestSnapshot = snapshotMap.get(att.attester_hash);
          const attesterScore = latestSnapshot ? latestSnapshot.score : attester.avg_score;
          // Anti-sybil: unknown attesters (score 0) get UNKNOWN_ATTESTER_WEIGHT
          weight *= (attesterScore / 100) || UNKNOWN_ATTESTER_WEIGHT;
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
    const score = 100 * (1 - Math.exp(-days / SENIORITY_HALF_LIFE_DAYS));
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
    const score = (Math.log(count + 1) / Math.log(DIVERSITY_LOG_BASE)) * 100;
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
    if (dataPoints < CONFIDENCE_VERY_LOW) return 'very_low';
    if (dataPoints < CONFIDENCE_LOW) return 'low';
    if (dataPoints < CONFIDENCE_MEDIUM) return 'medium';
    if (dataPoints < CONFIDENCE_HIGH) return 'high';
    return 'very_high';
  }
}
