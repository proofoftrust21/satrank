// Composite scoring engine — the core of SatRank
// Score 0-100 computed from 5 weighted components, with reinforced anti-gaming
// All tunable constants are in src/config/scoring.ts
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ScoreComponents, ConfidenceLevel } from '../types';
import { logger } from '../logger';
import { computePopularityBonus } from '../utils/scoring';
import { scoreComputeDuration } from '../middleware/metrics';
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
  LNPLUS_BONUS_CAP,
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
  MAX_ATTESTATIONS_PER_AGENT,
  PROBE_UNREACHABLE_PENALTY,
  PROBE_FRESHNESS_TTL,
  REPORT_SIGNAL_MIN_REPORTS,
  REPORT_SIGNAL_CAP,
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
    private db?: Database.Database,
    private probeRepo?: ProbeRepository,
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
    const startHr = process.hrtime.bigint();
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
        ? this.computeLightningReputation(agent.hubness_rank, agent.betweenness_rank, agent.capacity_sats, agent.total_transactions)
        : this.computeReputation(agentHash, now),
      seniority: this.computeSeniority(agent.first_seen, now),
      regularity: isLightningGraph
        ? this.computeLightningRegularity(agentHash, agent.last_seen, now)
        : this.computeRegularity(agentHash),
      diversity: isLightningGraph
        ? this.computeLightningDiversity(agent.capacity_sats, agent.unique_peers)
        : this.computeDiversity(agentHash),
    };

    // Observer agents without attestations have reputation=0. Renormalize to avoid
    // penalizing 30% of the score for a signal that requires community adoption.
    // LN nodes don't need this — their reputation is objective (centrality + peer trust).
    const noAttestationRep = !isLightningGraph && components.reputation === 0;
    let total: number;
    if (noAttestationRep) {
      const w = { volume: WEIGHTS.volume / 0.70, seniority: WEIGHTS.seniority / 0.70, regularity: WEIGHTS.regularity / 0.70, diversity: WEIGHTS.diversity / 0.70 };
      total = Math.round(
        components.volume * w.volume +
        components.seniority * w.seniority +
        components.regularity * w.regularity +
        components.diversity * w.diversity
      );
    } else {
      total = Math.round(
        components.volume * WEIGHTS.volume +
        components.reputation * WEIGHTS.reputation +
        components.seniority * WEIGHTS.seniority +
        components.regularity * WEIGHTS.regularity +
        components.diversity * WEIGHTS.diversity
      );
    }

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

    // LN+ community ratings bonus — social signal, max +8 pts
    // Separate from the reputation component (which is now objective: centrality + peer trust)
    if (isLightningGraph && agent.positive_ratings > 0) {
      const ratingsRatio = agent.positive_ratings / (agent.positive_ratings + agent.negative_ratings + 1);
      const lnplusBonus = Math.min(LNPLUS_BONUS_CAP, Math.round(Math.log2(agent.positive_ratings + 1) * ratingsRatio * 3));
      if (lnplusBonus > 0) {
        total = Math.min(100, total + lnplusBonus);
      }
    }

    // Probe-based unreachability penalty — distinct signal from regularity because
    // a node that is DOWN right now (latest probe failed) deserves an extra hit beyond
    // whatever its uptime-over-7-days says. Low-latency / short-hop bonuses were removed
    // because they double-counted what the new multi-axis regularity already measures.
    if (this.probeRepo) {
      const probe = this.probeRepo.findLatest(agentHash);
      if (probe && (now - probe.probed_at) < PROBE_FRESHNESS_TTL && probe.reachable === 0) {
        total = Math.max(0, total - PROBE_UNREACHABLE_PENALTY);
      }
    }

    const confidence = this.deriveConfidence(agent.total_transactions, agent.total_attestations_received);

    // Persist snapshot + update denormalized agents.avg_score atomically
    const persist = () => {
      this.snapshotRepo.insert({
        snapshot_id: uuid(),
        agent_hash: agentHash,
        score: total,
        components: JSON.stringify(components),
        computed_at: now,
      });
      this.agentRepo.updateStats(agentHash, agent.total_transactions, agent.total_attestations_received, total, agent.first_seen, agent.last_seen);
    };

    if (this.db) {
      this.db.transaction(persist)();
    } else {
      persist();
    }

    scoreComputeDuration.observe(Number(process.hrtime.bigint() - startHr) / 1e9);
    logger.debug({ agentHash, total, components }, 'Score computed');

    return { total, components, confidence, computedAt: now };
  }

  // --- Lightning graph scoring ---

  private computeLightningVolume(channels: number, _maxNetworkChannels: number): number {
    if (channels === 0) return 0;
    // Log scale with fixed reference (500 channels = 100).
    // Spreads the full 0-100 range across the real network distribution.
    // 5ch → 26, 20ch → 48, 50ch → 63, 100ch → 74, 500ch → 100
    const LN_VOLUME_REFERENCE = 500;
    return Math.min(100, Math.round(Math.log(channels + 1) / Math.log(LN_VOLUME_REFERENCE + 1) * 100));
  }

  private computeLightningRegularity(agentHash: string, lastSeen: number, now: number): number {
    // Multi-axis consistency measure — uptime is necessary but not sufficient.
    //
    //   regularity = uptime * 70 + latency_consistency * 20 + hop_stability * 10
    //
    // uptime              = reachable probes / total probes over the last 7 days
    // latency_consistency = exp(-stddev/mean) over reachable latencies (1.0 = rock steady)
    // hop_stability       = 1 - clamp(stddev_hops / 3, 0, 1)  (1.0 = same route every time)
    //
    // Rationale: a node that is always reachable but whose latency varies wildly or whose
    // routing paths flap is less reliable than one that is rock steady. Pure uptime alone
    // saturates (~77% of scored agents at 100) and stops differentiating the top cluster.
    //
    // Nodes without enough probe history (< 3 probes) fall back to the gossip-recency
    // formula so freshly-discovered agents still get a meaningful score.
    if (this.probeRepo) {
      const totalProbes = this.probeRepo.countByTarget(agentHash);
      if (totalProbes >= 3) {
        const uptime = this.probeRepo.computeUptime(agentHash, 7 * 86400) ?? 0;
        const latencyStats = this.probeRepo.getLatencyStats(agentHash, 7 * 86400);
        const hopStats = this.probeRepo.getHopStats(agentHash, 7 * 86400);

        // latency_consistency: exp(-cv). Neutral 0.5 if sample too small.
        let latencyConsistency = 0.5;
        if (latencyStats.count >= 3 && latencyStats.mean > 0) {
          const cv = latencyStats.stddev / latencyStats.mean;
          latencyConsistency = Math.exp(-cv);
        }

        // hop_stability: tight stddev on hop counts. Neutral 0.5 if sample too small.
        let hopStability = 0.5;
        if (hopStats.count >= 3) {
          hopStability = 1 - Math.min(1, hopStats.stddev / 3);
        }

        const score = uptime * 70 + latencyConsistency * 20 + hopStability * 10;
        return Math.min(100, Math.round(score));
      }
    }
    // Fallback: gossip recency with 90-day decay (for nodes too new to have probe history)
    const daysSinceUpdate = (now - lastSeen) / 86400;
    if (daysSinceUpdate <= 0) return 100;
    return Math.min(100, Math.round(100 * Math.exp(-daysSinceUpdate / 90)));
  }

  private computeLightningDiversity(capacitySats: number | null, uniquePeers: number | null): number {
    // Diversity = how many distinct nodes you share channels with.
    //
    //   diversity = log(unique_peers + 1) / log(501) * 100   (when unique_peers > 0)
    //
    // Rationale: a node with 100 BTC concentrated on 2 peers offers no routing diversity.
    // A node with 0.5 BTC spread across 20 peers is a real diversity contributor. Capacity
    // is a correlated but weaker proxy; peer count is the real signal.
    //
    // Reference point: 500 peers → 100 (ACINQ / Kraken scale).
    //   1 peer   → 11       50 peers  → 63       500 peers → 100
    //   10 peers → 38       200 peers → 85
    //
    // Nodes without peer data (fresh agents the LND crawler hasn't yet seen, or the tiny
    // subset missing from the v12→v15 migration window) fall back to the legacy capacity
    // formula so they still receive a score instead of a hard zero.
    if (uniquePeers !== null && uniquePeers !== undefined && uniquePeers > 0) {
      return Math.min(100, Math.round(Math.log(uniquePeers + 1) / Math.log(501) * 100));
    }
    // Fallback: capacity-based
    if (!capacitySats || capacitySats <= 0) return 0;
    const btc = capacitySats / SATS_PER_BTC;
    const score = (Math.log10(btc * LN_DIVERSITY_BTC_MULTIPLIER + 1) / Math.log10(LN_DIVERSITY_LOG_BASE)) * 100;
    return Math.min(100, Math.round(score));
  }

  // Reputation for Lightning nodes: centrality + peer trust (objective, on-chain signals)
  // LN+ ratings are a separate bonus applied after the base score.
  private computeLightningReputation(hubnessRank: number, betweennessRank: number, capacitySats: number | null, channels: number): number {
    // Centrality (max 50 pts): how well-connected is this node in the graph?
    // Hubness and betweenness each contribute up to 25 pts with exponential decay
    let centrality = 0;
    if (hubnessRank > 0) centrality += 25 * Math.exp(-hubnessRank / 100);
    if (betweennessRank > 0) centrality += 25 * Math.exp(-betweennessRank / 100);

    // Peer trust (max 50 pts): BTC per channel as inbound confidence proxy
    // Others lock real sats in channels with you — that's skin-in-the-game trust
    let peerTrust = 0;
    if (capacitySats && capacitySats > 0 && channels > 0) {
      const btcPerChannel = capacitySats / SATS_PER_BTC / channels;
      peerTrust = Math.min(50, Math.round(Math.log10(btcPerChannel * 100 + 1) / Math.log10(201) * 50));
    }

    return Math.min(100, Math.round(centrality + peerTrust));
  }

  private computeVolume(count: number): number {
    if (count === 0) return 0;
    const score = (Math.log(count + 1) / Math.log(VOLUME_LOG_BASE)) * 100;
    return Math.min(100, Math.round(score));
  }

  // Reputation with reinforced anti-gaming
  // Batch attester lookups to avoid N+1 queries
  private computeReputation(agentHash: string, now: number): number {
    const REPORT_CATEGORIES = new Set(['successful_transaction', 'failed_transaction', 'unresponsive']);
    const allAttestations = this.attestationRepo.findBySubject(agentHash, MAX_ATTESTATIONS_PER_AGENT, 0);
    // Exclude report-category attestations from the general reputation loop —
    // they flow through computeReportSignal() instead (avoids double-counting)
    const attestations = allAttestations.filter(a => !REPORT_CATEGORIES.has(a.category));
    if (attestations.length === 0) {
      // No general attestations — report signal alone can still contribute
      return Math.min(100, Math.max(0, this.computeReportSignal(agentHash)));
    }

    if (attestations.length >= MAX_ATTESTATIONS_PER_AGENT) {
      logger.warn({ agentHash, limit: MAX_ATTESTATIONS_PER_AGENT }, 'Attestation count truncated to limit for agent');
    }

    const mutualAgents = new Set(this.attestationRepo.findMutualAttestations(agentHash));
    const clusterMembers = new Set(this.attestationRepo.findCircularCluster(agentHash));
    // Extended cycle detection — catches 4+ hop cycles (A→B→C→D→A)
    const extendedCycleMembers = new Set(this.attestationRepo.findCycleMembers(agentHash, 4));

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
      // Intentional double penalty: weight reduction (0.05x) limits the attestation's
      // contribution to the weighted average, while the score cap (40) prevents a single
      // high-score mutual attestation from dominating even at reduced weight. Both layers
      // are needed: weight alone doesn't prevent artificial 100-score attestations from
      // skewing the average; cap alone doesn't prevent flooding with many mutual attestations.
      if (mutualAgents.has(att.attester_hash)) {
        weight *= MUTUAL_ATTESTATION_PENALTY;
        effectiveScore = Math.min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP);
      }

      // Anti-gaming: circular cluster (A->B->C->A)
      // Same double penalty rationale as mutual attestations above.
      if (clusterMembers.has(att.attester_hash)) {
        weight *= CIRCULAR_CLUSTER_PENALTY;
        effectiveScore = Math.min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP);
      }

      // Anti-gaming: extended cycles (4+ hops, e.g. A→B→C→D→A)
      // Same penalty as 3-hop clusters — applied only if not already caught above
      if (!mutualAgents.has(att.attester_hash) && !clusterMembers.has(att.attester_hash) && extendedCycleMembers.has(att.attester_hash)) {
        weight *= CIRCULAR_CLUSTER_PENALTY;
        effectiveScore = Math.min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP);
      }

      weightedSum += effectiveScore * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) {
      // No attestations — report signal alone can still contribute
      return Math.min(100, Math.max(0, this.computeReportSignal(agentHash)));
    }
    const attestationScore = Math.round(weightedSum / totalWeight);
    const reportAdjustment = this.computeReportSignal(agentHash);
    return Math.min(100, Math.max(0, attestationScore + reportAdjustment));
  }

  /** Compute the report-based signal for the reputation component.
   *  Returns a value in [-REPORT_SIGNAL_CAP, +REPORT_SIGNAL_CAP].
   *  Only contributes when >= REPORT_SIGNAL_MIN_REPORTS reports exist (anti-manipulation).
   *  Preimage-verified reports receive 2x weight (baked into reportSignalStats). */
  private computeReportSignal(agentHash: string): number {
    const stats = this.attestationRepo.reportSignalStats(agentHash);
    if (stats.total < REPORT_SIGNAL_MIN_REPORTS) return 0;

    const totalWeighted = stats.weightedSuccesses + stats.weightedFailures;
    if (totalWeighted === 0) return 0;

    // ratio: 0.0 (all failures) to 1.0 (all successes)
    const successRatio = stats.weightedSuccesses / totalWeighted;
    // Map 0.5 (neutral) to 0, 1.0 to +CAP, 0.0 to -CAP
    const adjustment = (successRatio - 0.5) * 2 * REPORT_SIGNAL_CAP;
    return Math.round(Math.min(REPORT_SIGNAL_CAP, Math.max(-REPORT_SIGNAL_CAP, adjustment)));
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

    // Ensure ascending order — DB returns ORDER BY timestamp ASC but defensive sort
    timestamps.sort((a, b) => a - b);

    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    // Near-zero mean (< 1 second) means transactions are quasi-simultaneous — perfectly regular
    if (mean < 1) return 100;

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
