// Business logic for agents
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { BayesianVerdictService } from './bayesianVerdictService';
import type { AgentScoreResponse, Agent, ProbeData, BayesianScoreBlock, BayesianWindow, ScoreEvidence } from '../types';
import { NotFoundError } from '../errors';
import { computePopularityBonus } from '../utils/scoring';

export type SortByField = 'p_success' | 'n_obs' | 'ci95_width' | 'window_freshness';

export interface TopAgentEntry {
  publicKeyHash: string;
  alias: string | null;
  totalTransactions: number;
  source: string;
  bayesian: BayesianScoreBlock;
}

const WINDOW_FRESHNESS_RANK: Record<BayesianWindow, number> = { '24h': 2, '7d': 1, '30d': 0 };

/** Leaderboard ordering. Ties break on p_success DESC so two rows with the
 *  same primary key still land in a deterministic, user-meaningful order. */
function compareByAxis(a: TopAgentEntry, b: TopAgentEntry, axis: SortByField): number {
  const ties = () => b.bayesian.p_success - a.bayesian.p_success;
  switch (axis) {
    case 'p_success': {
      const d = b.bayesian.p_success - a.bayesian.p_success;
      return d !== 0 ? d : b.bayesian.n_obs - a.bayesian.n_obs;
    }
    case 'n_obs': {
      const d = b.bayesian.n_obs - a.bayesian.n_obs;
      return d !== 0 ? d : ties();
    }
    case 'ci95_width': {
      const wa = a.bayesian.ci95_high - a.bayesian.ci95_low;
      const wb = b.bayesian.ci95_high - b.bayesian.ci95_low;
      const d = wa - wb;
      return d !== 0 ? d : ties();
    }
    case 'window_freshness': {
      const d = WINDOW_FRESHNESS_RANK[b.bayesian.window] - WINDOW_FRESHNESS_RANK[a.bayesian.window];
      return d !== 0 ? d : ties();
    }
  }
}

export class AgentService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private bayesianVerdict: BayesianVerdictService,
    private probeRepo?: ProbeRepository,
  ) {}

  getAgentScore(publicKeyHash: string): AgentScoreResponse {
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) throw new NotFoundError('Agent', publicKeyHash);

    const verifiedTx = this.txRepo.countVerifiedByAgent(publicKeyHash);
    const uniqueCounterparties = this.txRepo.countUniqueCounterparties(publicKeyHash);
    const attestationsCount = this.attestationRepo.countBySubject(publicKeyHash);
    const avgAttestationScore = this.attestationRepo.avgScoreBySubject(publicKeyHash);

    const bayesian = this.toBayesianBlock(publicKeyHash);

    return {
      agent: {
        publicKeyHash: agent.public_key_hash,
        alias: agent.alias,
        firstSeen: agent.first_seen,
        lastSeen: agent.last_seen,
        source: agent.source,
      },
      bayesian,
      stats: {
        totalTransactions: agent.total_transactions,
        verifiedTransactions: verifiedTx,
        uniqueCounterparties,
        attestationsReceived: attestationsCount,
        avgAttestationScore: Math.round(avgAttestationScore * 10) / 10,
      },
      evidence: this.buildEvidence(agent, verifiedTx),
      alerts: [],
    };
  }

  /** Project the BayesianVerdictService output onto the canonical public shape
   *  (BayesianScoreBlock). Source-of-truth adapter for every agent response. */
  toBayesianBlock(publicKeyHash: string): BayesianScoreBlock {
    const v = this.bayesianVerdict.buildVerdict({ targetHash: publicKeyHash });
    return {
      p_success: v.p_success,
      ci95_low: v.ci95_low,
      ci95_high: v.ci95_high,
      n_obs: v.n_obs,
      verdict: v.verdict,
      window: v.window,
      sources: v.sources,
      convergence: v.convergence,
    };
  }

  buildEvidence(agentHashOrAgent: string | Agent, verifiedTxCount?: number): ScoreEvidence {
    const agent = typeof agentHashOrAgent === 'string'
      ? this.agentRepo.findByHash(agentHashOrAgent)
      : agentHashOrAgent;
    if (!agent) {
      return { transactions: { count: 0, verifiedCount: 0, sample: [] }, lightningGraph: null, reputation: null, popularity: { queryCount: 0, bonusApplied: 0 }, probe: null };
    }
    if (verifiedTxCount === undefined) {
      verifiedTxCount = this.txRepo.countVerifiedByAgent(agent.public_key_hash);
    }
    const recentTx = this.txRepo.findRecentByAgent(agent.public_key_hash, 5);
    const totalTxCount = agent.total_transactions;

    const isLightning = agent.source === 'lightning_graph';
    const hasLnplusData = agent.positive_ratings > 0 || agent.negative_ratings > 0 || agent.lnplus_rank > 0 || agent.hubness_rank > 0 || agent.betweenness_rank > 0;

    const popularityBonus = computePopularityBonus(agent.query_count);

    return {
      transactions: {
        count: totalTxCount,
        verifiedCount: verifiedTxCount,
        sample: recentTx.map(tx => ({
          txId: tx.tx_id,
          protocol: tx.protocol,
          amountBucket: tx.amount_bucket,
          verified: tx.status === 'verified',
          timestamp: tx.timestamp,
        })),
      },
      lightningGraph: isLightning && agent.public_key ? {
        publicKey: agent.public_key,
        channels: agent.total_transactions,
        capacitySats: agent.capacity_sats ?? 0,
        sourceUrl: `https://mempool.space/lightning/node/${agent.public_key}`,
      } : null,
      reputation: isLightning && hasLnplusData && agent.public_key ? {
        positiveRatings: agent.positive_ratings,
        negativeRatings: agent.negative_ratings,
        lnplusRank: agent.lnplus_rank,
        hubnessRank: agent.hubness_rank,
        betweennessRank: agent.betweenness_rank,
        sourceUrl: `https://lightningnetwork.plus/nodes/${agent.public_key}`,
      } : null,
      popularity: {
        queryCount: agent.query_count,
        bonusApplied: popularityBonus,
      },
      probe: this.buildProbeData(agent.public_key_hash),
    };
  }

  private buildProbeData(agentHash: string): ProbeData | null {
    if (!this.probeRepo) return null;
    // tier-1k for display reachability — consistent with scoring & verdict.
    // Fall back to any latest probe for timestamps if no tier-1k data.
    const latest = this.probeRepo.findLatestAtTier(agentHash, 1000) ?? this.probeRepo.findLatest(agentHash);
    if (!latest) return null;
    return {
      reachable: latest.reachable === 1,
      latencyMs: latest.latency_ms,
      hops: latest.hops,
      estimatedFeeMsat: latest.estimated_fee_msat,
      failureReason: latest.failure_reason,
      probedAt: latest.probed_at,
    };
  }

  getTopAgents(limit: number, offset: number, sortBy: SortByField = 'p_success'): TopAgentEntry[] {
    // Candidate pool: every sort axis is Bayesian, so we pull a wider pool and
    // re-sort in JS. Pre-DB Bayesian aggregation lands in Commit 8; for now
    // the 5-min leaderboard cache absorbs the O(N) posterior computation.
    const POOL_CAP = 500;
    const poolSize = Math.min(POOL_CAP, limit + offset + 100);
    const agents = this.agentRepo.findTopByScore(poolSize, 0);
    if (agents.length === 0) return [];

    const enriched: TopAgentEntry[] = agents.map(a => ({
      publicKeyHash: a.public_key_hash,
      alias: a.alias,
      totalTransactions: a.total_transactions,
      source: a.source,
      bayesian: this.toBayesianBlock(a.public_key_hash),
    }));

    enriched.sort((a, b) => compareByAxis(a, b, sortBy));
    return enriched.slice(offset, offset + limit);
  }

  searchByAlias(alias: string, limit: number, offset: number) {
    return this.agentRepo.searchByAlias(alias, limit, offset);
  }
}
