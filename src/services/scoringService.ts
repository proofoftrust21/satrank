// Composite scoring engine — the core of SatRank
// Score 0-100 computed from 5 weighted components, with reinforced anti-gaming
// All tunable constants are in src/config/scoring.ts
//
// Phase 3 C8: public API exposes the Bayesian posterior only. This composite
// stays as an internal signal for the risk classifier, survival predictor,
// and top-200 mover candidate set — it is no longer snapshotted (table now
// holds bayesian-only state) and no longer surfaced in responses.
import type Database from 'better-sqlite3';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ScoreComponents, ConfidenceLevel, ReputationBreakdown } from '../types';
import { logger } from '../logger';
// computePopularityBonus removed — query_count is gameable (see modifier block)
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
  // LN+ tuning constants retained in src/config/scoring.ts for the existing
  // scoringConfig.test.ts assertions but no longer imported here after the
  // 2026-04-16 audit removed the LN+ positive-ratings multiplier.
  CENTRALITY_BONUS_MULTIPLIER,
  CENTRALITY_DECAY_CONSTANT,
  VOLUME_LOG_BASE,
  DIVERSITY_LOG_BASE,
  SENIORITY_HALF_LIFE_DAYS,
  CONFIDENCE_VERY_LOW,
  CONFIDENCE_LOW,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_HIGH,
  MAX_ATTESTATIONS_PER_AGENT,
  PROBE_UNREACHABLE_PENALTY,
  PROBE_FRESHNESS_TTL,
  REPORT_SIGNAL_MIN_REPORTS,
  REPORT_SIGNAL_CAP,
} from '../config/scoring';

export interface ScoreResult {
  total: number;
  /** 2-decimal float score. Same pipeline as `total` but without the per-stage
   *  rounding — breaks ties when 9 of the top-10 nodes compress into a 2-point
   *  band (80-82). `total` remains the official integer score for display and
   *  API consumers that expect an int; `totalFine` drives sorting and
   *  tie-breaking on the leaderboard. */
  totalFine: number;
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
    private channelSnapshotRepo?: { findLatest: (h: string) => { capacity_sats: number } | undefined; findAt: (h: string, ts: number) => { capacity_sats: number } | undefined },
    private feeSnapshotRepo?: { countFeeChanges: (nodePub: string, afterTimestamp: number) => { changes: number; channels: number } },
  ) {}

  // Returns an agent's score. Phase 3 C8: the score_snapshots cache is gone
  // (table now holds bayesian-only state). getScore recomputes on every call.
  // An in-process memo could be added if profiling shows this as a hotspot;
  // the call sites (risk classifier, survival trajectory) are already rare.
  getScore(agentHash: string): ScoreResult {
    return this.computeScore(agentHash);
  }

  // Computes the full score for an agent and persists a snapshot
  computeScore(agentHash: string): ScoreResult {
    const startHr = process.hrtime.bigint();
    const now = Math.floor(Date.now() / 1000);
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent) {
      return { total: 0, totalFine: 0, components: { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 }, confidence: 'very_low', computedAt: now };
    }

    const isLightningGraph = agent.source === 'lightning_graph';
    const verifiedTxCount = isLightningGraph ? 0 : this.txRepo.countVerifiedByAgent(agentHash);
    const maxNetworkChannels = isLightningGraph ? this.agentRepo.maxChannels() : 0;

    // Compute Reputation and its sub-signal breakdown in one pass. The
    // breakdown is emitted into components JSON so downstream audits can
    // attribute Reputation movements to individual sub-signals.
    const repResult = isLightningGraph
      ? this.computeLightningReputationBreakdown(agentHash, agent.hubness_rank, agent.betweenness_rank, agent.capacity_sats, agent.total_transactions)
      : this.computeReputationWithBreakdown(agentHash, now);

    const components: ScoreComponents = {
      volume: isLightningGraph
        ? this.computeLightningVolume(agent.total_transactions, agent.capacity_sats)
        : this.computeVolume(verifiedTxCount),
      reputation: repResult.score,
      seniority: this.computeSeniority(agent.first_seen, now),
      regularity: isLightningGraph
        ? this.computeLightningRegularity(agentHash, agent.last_seen, now)
        : this.computeRegularity(agentHash),
      diversity: isLightningGraph
        ? this.computeLightningDiversity(agent.capacity_sats, agent.unique_peers)
        : this.computeDiversity(agentHash),
      reputationBreakdown: repResult.breakdown,
    };

    // Observer agents without attestations have reputation=0. Renormalize to avoid
    // penalizing 30% of the score for a signal that requires community adoption.
    // LN nodes don't need this — their reputation is objective (centrality + peer trust).
    const noAttestationRep = !isLightningGraph && components.reputation === 0;
    // Parallel float pipeline: `totalFloat` mirrors `total`'s multiplier chain
    // without intermediate rounding. At the end, clamp and round to 2 decimals
    // to get `totalFine`. The integer `total` remains the official score
    // (API contract, compatibility), the float serves sorting/tie-breaks.
    let total: number;
    let totalFloat: number;
    if (noAttestationRep) {
      const w = { volume: WEIGHTS.volume / 0.70, seniority: WEIGHTS.seniority / 0.70, regularity: WEIGHTS.regularity / 0.70, diversity: WEIGHTS.diversity / 0.70 };
      totalFloat =
        components.volume * w.volume +
        components.seniority * w.seniority +
        components.regularity * w.regularity +
        components.diversity * w.diversity;
    } else {
      totalFloat =
        components.volume * WEIGHTS.volume +
        components.reputation * WEIGHTS.reputation +
        components.seniority * WEIGHTS.seniority +
        components.regularity * WEIGHTS.regularity +
        components.diversity * WEIGHTS.diversity;
    }
    total = Math.round(totalFloat);

    // --- Multiplicative modifiers ---
    // All post-composite adjustments are multiplicative (not additive) so a
    // low-base-score node can't reach a high total via bonus stacking alone.
    // A base-40 node × 1.15 = 46 max, not 40 + 33 = 73 as before.

    // "manual" source penalty: linear ramp from ×0.5 (0 tx) to ×1.0 (150 tx)
    if (agent.source === 'manual' && verifiedTxCount < MANUAL_SOURCE_PENALTY_THRESHOLD) {
      const ratio = verifiedTxCount / MANUAL_SOURCE_PENALTY_THRESHOLD;
      const penaltyMultiplier = MANUAL_SOURCE_MIN_MULTIPLIER + (1 - MANUAL_SOURCE_MIN_MULTIPLIER) * ratio;
      total = Math.round(total * penaltyMultiplier);
      totalFloat = totalFloat * penaltyMultiplier;
    }

    // Verified transaction bonus — ×1.0 to ×1.10 based on Observer Protocol txns
    const verifiedForBonus = isLightningGraph
      ? this.txRepo.countVerifiedByAgent(agentHash)
      : verifiedTxCount;
    if (verifiedForBonus > 0) {
      const verifiedMult = Math.min(1.10, 1.0 + verifiedForBonus * 0.003);
      total = Math.min(100, Math.round(total * verifiedMult));
      totalFloat = Math.min(100, totalFloat * verifiedMult);
    }

    // LN+ positive ratings deprecated (2026-04-16 scoring audit):
    //   - coverage only 13.9% of agents
    //   - r(positive_ratings, Reputation) = 0.25 (near-noise)
    //   - LN+ API is an external dependency without stable contract
    // Negative ratings stay actively used for the `negative_reputation` flag
    // (src/utils/flags.ts) — the signal is asymmetric: absence of a rating
    // says nothing, but a negative rating remains a meaningful fraud signal.

    // Probe-based penalty — two regimes:
    //
    // Regime 1: base tier (1k sats) UNREACHABLE → existing graduated classification
    //   Dead (gossip >30d stale): 0.65
    //   Zombie (gossip 7-30d OR 30%+ disabled): 0.80
    //   Liquidity (gossip fresh, no route): 0.90
    //
    // Regime 2: base tier REACHABLE → multi-tier liquidity signal (stable)
    //   signal = Σ(success_rate_tier × weight_tier) / Σ(weight_tier for PROBED tiers)
    //   weights: 1k=0.4, 10k=0.3, 100k=0.2 (1M excluded — see below)
    //   probeMult = max(0.65, signal)
    //
    // Sim #10 FINDING #14 — the 1M tier used to be in TIER_WEIGHTS at 0.1, but
    // routing 1M sats (0.01 BTC) in one hop requires exceptional inbound
    // liquidity that most nodes legitimately lack. Failing 1M is the norm, not
    // a trust signal. Nodes probed on all 4 tiers (ACINQ, Boltz, Kraken, bfx…)
    // were systematically getting probeMult=0.9 while nodes probed only at 1k
    // (CoinGate, IBEX…) kept probeMult=1.0 — a coverage-dependent score delta
    // that inverted the "better instrumentation = better score" direction.
    // The 1M tier stays probed for `maxRoutableAmount`, just not counted here.
    //
    // This also fixes the oscillation bug: before, findLatest() could return a
    // high-tier failure (1M sats = legitimate liquidity limit) which applied
    // the full 0.90 penalty, causing scores to swing 9 points based on which
    // tier was probed last. Now the signal aggregates all recent probes by
    // tier, weighted by agent-facing importance (smaller payments matter more).
    if (this.probeRepo) {
      const baseProbe = this.probeRepo.findLatestAtTier(agentHash, 1000);
      if (baseProbe && (now - baseProbe.probed_at) < PROBE_FRESHNESS_TTL) {
        if (baseProbe.reachable === 0) {
          // Regime 1 — base tier unreachable: existing dead/zombie/liquidity classification
          const gossipAgeSec = now - agent.last_seen;
          const THIRTY_DAYS = 30 * 86400;
          const SEVEN_DAYS = 7 * 86400;
          const channels = agent.total_transactions || 1;
          const disabledRatio = (agent.disabled_channels ?? 0) > 0
            ? (agent.disabled_channels ?? 0) / channels
            : 0;
          let probeMult: number;
          if (disabledRatio >= 0.8) probeMult = 0.65;
          else if (gossipAgeSec > THIRTY_DAYS) probeMult = 0.70;
          else if (gossipAgeSec > SEVEN_DAYS || disabledRatio >= 0.3) probeMult = 0.80;
          else probeMult = 0.90;
          total = Math.max(0, Math.round(total * probeMult));
          totalFloat = Math.max(0, totalFloat * probeMult);
        } else {
          // Regime 2 — base tier reachable: multi-tier liquidity signal
          const SEVEN_DAYS_SEC = 7 * 86400;
          const TIER_WEIGHTS = new Map<number, number>([[1000, 0.4], [10_000, 0.3], [100_000, 0.2]]);
          const rates = this.probeRepo.computeTierSuccessRates(agentHash, SEVEN_DAYS_SEC);
          let weightedSum = 0;
          let weightTotal = 0;
          for (const [tier, weight] of TIER_WEIGHTS) {
            const stats = rates.get(tier);
            if (stats && stats.total > 0) {
              weightedSum += (stats.success / stats.total) * weight;
              weightTotal += weight;
            }
          }
          if (weightTotal > 0) {
            const signal = weightedSum / weightTotal;
            const probeMult = Math.max(0.65, signal);
            if (probeMult < 1.0) {
              total = Math.max(0, Math.round(total * probeMult));
              totalFloat = Math.max(0, totalFloat * probeMult);
            }
          }
        }
      }
    }

    // Popularity bonus REMOVED — query_count is gameable (a node can query
    // itself) and provided no real trust signal. The demand signal remains
    // in last_queried_at for probe prioritization, just not in the score.

    const confidence = this.deriveConfidence(agent.total_transactions, agent.total_attestations_received);

    // Clamp the float pipeline and round to 2 decimals. `totalFine` is what we
    // persist (both columns are REAL) — the integer is always re-derivable as
    // Math.round(scoreFine) for API consumers that need it.
    const totalFine = Math.round(Math.max(0, Math.min(100, totalFloat)) * 100) / 100;

    // Phase 3 C8: snapshot persistence moved to BayesianVerdictService — the
    // score_snapshots table now holds only bayesian-posterior state. Scoring
    // keeps the denormalized agents.avg_score up to date because riskService,
    // survivalService, and the top-200 candidate set for topMovers still read
    // from it. The agents.avg_score column is internal and no longer surfaced
    // in public API responses.
    const persist = () => {
      this.agentRepo.updateStats(agentHash, agent.total_transactions, agent.total_attestations_received, totalFine, agent.first_seen, agent.last_seen);
    };

    if (this.db) {
      this.db.transaction(persist)();
    } else {
      persist();
    }

    scoreComputeDuration.observe(Number(process.hrtime.bigint() - startHr) / 1e9);
    logger.debug({ agentHash, total, totalFine, components }, 'Score computed');

    return { total, totalFine, components, confidence, computedAt: now };
  }

  // --- Lightning graph scoring ---

  private computeLightningVolume(channels: number, capacitySats: number | null): number {
    if (channels === 0) return 0;

    // 50/50 blend of channel count + total capacity (in BTC).
    // Channel count alone is gameable: 500 tiny channels of 1000 sats
    // each (0.005 BTC total) scored 100 under the old formula. Adding a
    // capacity dimension halves the attacker's score (50 from channels,
    // ~0 from capacity) while keeping real hubs at 85-95.
    //
    // Channel score: log scale, 500 channels = 100 (unchanged)
    // Capacity score: log scale, 100 BTC = 100
    //   0.005 BTC → 0.4,  0.5 BTC → 18,  10 BTC → 51,  38 BTC → 79,  100 BTC → 100
    const LN_VOLUME_CH_REF = 500;
    const LN_VOLUME_BTC_REF = 50; // 50 BTC = 100. ACINQ ~38 BTC → 93.
    const SATS = 100_000_000;

    const channelScore = Math.min(100, Math.log(channels + 1) / Math.log(LN_VOLUME_CH_REF + 1) * 100);
    const btc = (capacitySats ?? 0) / SATS;
    const capacityScore = btc > 0
      ? Math.min(100, Math.log(btc + 1) / Math.log(LN_VOLUME_BTC_REF + 1) * 100)
      : 0;

    return Math.round(channelScore * 0.5 + capacityScore * 0.5);
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

  // Reputation for Lightning nodes: centrality + peer trust + routing quality + capacity trend + fee stability
  private computeLightningReputation(
    agentHash: string,
    hubnessRank: number,
    betweennessRank: number,
    capacitySats: number | null,
    channels: number,
  ): number {
    return this.computeLightningReputationBreakdown(agentHash, hubnessRank, betweennessRank, capacitySats, channels).score;
  }

  /** Same math as computeLightningReputation, but also emits the per-sub-signal
   *  contributions so a downstream audit can answer "why did Reputation move?". */
  private computeLightningReputationBreakdown(
    agentHash: string,
    hubnessRank: number,
    betweennessRank: number,
    capacitySats: number | null,
    channels: number,
  ): { score: number; breakdown: ReputationBreakdown } {
    // --- Sub-signal 1: Centrality (0-100) ---
    // PRIMARY: sovereign PageRank computed hourly from the full LND graph.
    // Covers 100% of nodes (vs ~70% with LN+ API). Every node — including
    // a small agent with 2 channels — gets a meaningful centrality score
    // based on WHO it connects to.
    // FALLBACK: LN+ hubness/betweenness ranks when pagerank_score is not
    // yet populated (first crawl after migration, or test environments).
    const agent = this.agentRepo.findByHash(agentHash);
    const pagerankScore = agent?.pagerank_score;
    let centrality: number;
    let centralitySource: 'pagerank' | 'lnplus_ranks' | 'none';
    if (pagerankScore != null && pagerankScore > 0) {
      centrality = Math.round(pagerankScore);
      centralitySource = 'pagerank';
    } else if (hubnessRank > 0 || betweennessRank > 0) {
      centrality = 0;
      if (hubnessRank > 0) centrality += 50 * Math.exp(-hubnessRank / 100);
      if (betweennessRank > 0) centrality += 50 * Math.exp(-betweennessRank / 100);
      centrality = Math.min(100, Math.round(centrality));
      centralitySource = 'lnplus_ranks';
    } else {
      centrality = 0;
      centralitySource = 'none';
    }

    // --- Sub-signal 2: Peer trust (0-100) ---
    // Available only when the graph crawler has populated BOTH capacity and
    // channel count. On a newly-discovered node, peer trust is structurally
    // unavailable (no peers observed yet) and must be excluded from the
    // weighted average — returning 0 here would push Reputation down by
    // peerTrust's 30% share for reasons unrelated to the node's trust.
    let peerTrust = 0;
    let peerTrustAvailable = false;
    if (capacitySats && capacitySats > 0 && channels > 0) {
      const btcPerChannel = capacitySats / SATS_PER_BTC / channels;
      peerTrust = Math.min(100, Math.round(Math.log10(btcPerChannel * 100 + 1) / Math.log10(201) * 100));
      peerTrustAvailable = true;
    }

    // --- Sub-signal 3: Capacity trend (0-100) ---
    // Fallback returns 50 (neutral) when there is no channel_snapshot history
    // — always treated as available; neutral is a legitimate datum.
    const capTrend = this.computeCapacityTrend(agentHash);

    // --- Sub-signal 4: Routing quality (0-100) ---
    // Fallback returns 50 (neutral) when < 3 probes — always treated as available.
    const routingQuality = this.computeRoutingQuality(agentHash);

    // --- Sub-signal 5: Fee stability (0-100) ---
    // Fallback returns 50 (neutral) when no fee snapshots — always treated as available.
    const feeStability = this.computeFeeStability(agentHash);

    // Dynamic renormalization:
    //   Nominal weights are centrality 0.20 / peerTrust 0.30 / routingQuality 0.20
    //   / capacityTrend 0.15 / feeStability 0.15. When a sub-signal returns 0
    //   *because its data is missing* (not because of a true-zero measurement),
    //   including it in the weighted sum is a structural penalty unrelated to
    //   the node's trust. The fix is to drop the unavailable slot and scale
    //   the remaining weights back up to 1.0, so the observed signals drive
    //   the whole Reputation component.
    //
    //   Only centrality and peerTrust can be unavailable — the other three
    //   have semantically-meaningful neutral fallbacks (50) that belong in
    //   the average. This solves the 2026-04-16 audit finding that ~28% of
    //   scored LN agents lost 4-6 points of total score from missing
    //   PageRank or missing capacity data on freshly-discovered nodes.
    const NOMINAL_WEIGHTS = { centrality: 0.20, peerTrust: 0.30, routingQuality: 0.20, capacityTrend: 0.15, feeStability: 0.15 };
    const centralityAvailable = centralitySource !== 'none';
    const availSum =
      (centralityAvailable ? NOMINAL_WEIGHTS.centrality : 0) +
      (peerTrustAvailable  ? NOMINAL_WEIGHTS.peerTrust  : 0) +
      NOMINAL_WEIGHTS.routingQuality +
      NOMINAL_WEIGHTS.capacityTrend +
      NOMINAL_WEIGHTS.feeStability;

    // Renormalized weights used in the score computation AND reported verbatim
    // in the breakdown so downstream audits can see what was actually applied.
    const weights = {
      centrality:      centralityAvailable ? NOMINAL_WEIGHTS.centrality / availSum : 0,
      peerTrust:       peerTrustAvailable  ? NOMINAL_WEIGHTS.peerTrust  / availSum : 0,
      routingQuality:  NOMINAL_WEIGHTS.routingQuality / availSum,
      capacityTrend:   NOMINAL_WEIGHTS.capacityTrend  / availSum,
      feeStability:    NOMINAL_WEIGHTS.feeStability   / availSum,
    };

    const score = Math.min(100, Math.round(
      centrality      * weights.centrality +
      peerTrust       * weights.peerTrust +
      routingQuality  * weights.routingQuality +
      capTrend        * weights.capacityTrend +
      feeStability    * weights.feeStability,
    ));

    const mkSlot = (value: number, weight: number, available = true) => ({
      value,
      weight: Math.round(weight * 1000) / 1000,
      // Contribution is value × weight — operator can verify the formula by
      // summing the contribution fields; sum ≈ score (modulo rounding).
      contribution: Math.round(value * weight * 100) / 100,
      available,
    });

    const breakdown: ReputationBreakdown = {
      mode: 'lightning_graph',
      subsignals: {
        centrality:      { ...mkSlot(centrality,      weights.centrality,     centralityAvailable), source: centralitySource },
        peerTrust:       mkSlot(peerTrust,       weights.peerTrust, peerTrustAvailable),
        routingQuality:  mkSlot(routingQuality,  weights.routingQuality),
        capacityTrend:   mkSlot(capTrend,        weights.capacityTrend),
        feeStability:    mkSlot(feeStability,    weights.feeStability),
      },
    };

    return { score, breakdown };
  }

  // Capacity trend: compare latest channel_snapshot capacity with the
  // snapshot from ~7 days ago. Returns 0-100 where:
  //   0   = capacity dropped by ≥50%
  //   50  = stable (no change) or no data
  //   100 = capacity grew by ≥50%
  // The sigmoid curve is centered at 0% change, steepness tuned so a ±20%
  // weekly change maps to ~25/75 on the scale.
  private computeCapacityTrend(agentHash: string): number {
    if (!this.channelSnapshotRepo) return 50; // neutral when no repo injected

    const latest = this.channelSnapshotRepo.findLatest(agentHash);
    if (!latest) return 50;

    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const older = this.channelSnapshotRepo.findAt(agentHash, sevenDaysAgo);
    if (!older || older.capacity_sats === 0) return 50;

    const delta = (latest.capacity_sats - older.capacity_sats) / older.capacity_sats;
    // Sigmoid: maps delta ∈ [-∞,+∞] to [0,100], centered at 0, steepness=6
    // At delta=0 → 50, delta=+0.20 → ~77, delta=-0.20 → ~23, delta=+0.50 → ~95
    const trend = 100 / (1 + Math.exp(-6 * delta));
    return Math.round(trend);
  }

  // Routing quality: ABSOLUTE hop distance + ABSOLUTE latency from our
  // 1.7M+ probes. This is the proprietary signal — it measures how well
  // a node performs FROM OUR POSITION in the Lightning graph. Nobody else
  // has these measurements.
  //
  // Distinct from regularity: regularity measures CONSISTENCY (stddev of
  // latency, uptime %, hop stability). Routing quality measures the LEVEL
  // (are we 2 hops or 8 hops away? is the latency 10ms or 200ms?).
  //
  // Not manipulable: a node can't fake being 2 hops from us — that
  // requires actual channel relationships in the graph.
  //
  // Coverage: 13,242 nodes with 100+ probes. Nodes without probe data
  // get neutral (50).
  private computeRoutingQuality(agentHash: string): number {
    if (!this.probeRepo) return 50;

    const WINDOW_SEC = 7 * 86400;
    const hopStats = this.probeRepo.getHopStats(agentHash, WINDOW_SEC);
    const latStats = this.probeRepo.getLatencyStats(agentHash, WINDOW_SEC);

    // Need at least 3 reachable probes to have meaningful data
    if (hopStats.count < 3 || latStats.count < 3) return 50;

    // Hop score: 1 hop = 100, each additional hop costs 12 points, floor 4
    //   2 hops → 88, 3 → 76, 5 → 52, 8 → 16, 9+ → 4
    const hopScore = Math.max(4, Math.round(100 - (hopStats.mean - 1) * 12));

    // Latency score: 0ms = 100, degrades linearly, 300ms+ = 0
    //   10ms → 97, 30ms → 90, 73ms → 76, 150ms → 50, 300ms → 0
    const latencyScore = Math.max(0, Math.round(100 - latStats.mean / 3));

    // Blend: hops matter more than latency (hops are structural — you
    // can't reduce them without changing the graph; latency fluctuates
    // with network conditions).
    return Math.round(hopScore * 0.6 + latencyScore * 0.4);
  }

  // Fee stability: how stable are this node's routing fees over the past week?
  // Frequent fee changes signal fee sniping or unreliable routing. Stable fees
  // indicate a well-configured, reliable routing node.
  //
  // Sigmoid: 0 changes → 100, 1 change/channel → ~73, 3 → ~27, 5+ → ~5
  // Returns neutral 50 when no fee data is available.
  computeFeeStability(agentHash: string): number {
    if (!this.feeSnapshotRepo) return 50; // neutral

    // Get the agent's LN pubkey
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent?.public_key) return 50;

    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const { changes, channels } = this.feeSnapshotRepo.countFeeChanges(agent.public_key, sevenDaysAgo);

    if (channels === 0) return 50; // no fee data yet

    // changes_per_channel_per_week: 0 = perfectly stable, higher = more volatile
    const rate = changes / channels;
    // Sigmoid: 0 changes → 100, 1 change/channel → ~73, 3 → ~27, 5+ → ~5
    return Math.round(100 / (1 + Math.exp(1.5 * (rate - 2))));
  }

  private computeVolume(count: number): number {
    if (count === 0) return 0;
    const score = (Math.log(count + 1) / Math.log(VOLUME_LOG_BASE)) * 100;
    return Math.min(100, Math.round(score));
  }

  // Reputation with reinforced anti-gaming
  // Batch attester lookups to avoid N+1 queries
  private computeReputation(agentHash: string, now: number): number {
    return this.computeReputationWithBreakdown(agentHash, now).score;
  }

  /** Same math as computeReputation, but returns the breakdown (attestation
   *  count + weighted average + report signal) for audit trail. */
  private computeReputationWithBreakdown(agentHash: string, now: number): { score: number; breakdown: ReputationBreakdown } {
    const REPORT_CATEGORIES = new Set(['successful_transaction', 'failed_transaction', 'unresponsive']);
    const allAttestations = this.attestationRepo.findBySubject(agentHash, MAX_ATTESTATIONS_PER_AGENT, 0);
    // Exclude report-category attestations from the general reputation loop —
    // they flow through computeReportSignal() instead (avoids double-counting)
    const attestations = allAttestations.filter(a => !REPORT_CATEGORIES.has(a.category));
    if (attestations.length === 0) {
      // No general attestations — report signal alone can still contribute.
      // Use 50 (neutral) as the baseline, not 0: "no attestation data" is
      // semantically neutral, consistent with the lightning_graph sub-signals
      // feeStability/capacityTrend/routingQuality that also return 50 when
      // their data is missing. Returning 0 here wrongly framed missing-data
      // as a trust measurement and systematically under-weighted new observer
      // agents (Sim #10 audit: 31 agents stuck at Reputation=0).
      // rs is an adjustment in [-REPORT_SIGNAL_CAP, +REPORT_SIGNAL_CAP].
      const rs = this.computeReportSignal(agentHash);
      const score = Math.min(100, Math.max(0, 50 + rs));
      return {
        score,
        breakdown: {
          mode: 'attestations',
          attestations: { count: 0, weightedAverage: 0, reportSignal: rs },
        },
      };
    }

    if (attestations.length >= MAX_ATTESTATIONS_PER_AGENT) {
      logger.warn({ agentHash, limit: MAX_ATTESTATIONS_PER_AGENT }, 'Attestation count truncated to limit for agent');
    }

    const mutualAgents = new Set(this.attestationRepo.findMutualAttestations(agentHash));
    const clusterMembers = new Set(this.attestationRepo.findCircularCluster(agentHash));
    // Extended cycle detection — catches 4+ hop cycles (A→B→C→D→A)
    const extendedCycleMembers = new Set(this.attestationRepo.findCycleMembers(agentHash, 4));

    // Batch: load all attesters in 1 query. Phase 3 C8 dropped the composite
    // from score_snapshots, so the attester's weighting score reads from the
    // denormalized `agents.avg_score` column, which scoringService still
    // maintains on every computeScore pass.
    const attesterHashes = [...new Set(attestations.map(a => a.attester_hash))];
    const attesterAgents = this.agentRepo.findByHashes(attesterHashes);
    const attesterMap = new Map(attesterAgents.map(a => [a.public_key_hash, a]));

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
          const attesterScore = attester.avg_score;
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
      // All attesters had their weight pushed to zero by anti-gaming filters.
      // No usable attestation data → neutral 50 baseline + rs adjustment,
      // same semantics as the attestations.length === 0 branch above.
      const rs = this.computeReportSignal(agentHash);
      return {
        score: Math.min(100, Math.max(0, 50 + rs)),
        breakdown: {
          mode: 'attestations',
          attestations: { count: attestations.length, weightedAverage: 0, reportSignal: rs },
        },
      };
    }
    const attestationScore = Math.round(weightedSum / totalWeight);
    const reportAdjustment = this.computeReportSignal(agentHash);
    const finalScore = Math.min(100, Math.max(0, attestationScore + reportAdjustment));
    return {
      score: finalScore,
      breakdown: {
        mode: 'attestations',
        attestations: {
          count: attestations.length,
          weightedAverage: attestationScore,
          reportSignal: reportAdjustment,
        },
      },
    };
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

  private deriveConfidence(totalTx: number, totalAttestations: number): ConfidenceLevel {
    const dataPoints = totalTx + totalAttestations;
    if (dataPoints < CONFIDENCE_VERY_LOW) return 'very_low';
    if (dataPoints < CONFIDENCE_LOW) return 'low';
    if (dataPoints < CONFIDENCE_MEDIUM) return 'medium';
    if (dataPoints < CONFIDENCE_HIGH) return 'high';
    return 'very_high';
  }
}
