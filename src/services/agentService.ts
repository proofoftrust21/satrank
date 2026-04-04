// Business logic for agents
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ScoringService } from './scoringService';
import type { TrendService } from './trendService';
import type { AgentScoreResponse, ScoreEvidence, ScoreComponents, Agent, ProbeData } from '../types';
import { NotFoundError } from '../errors';
import { computePopularityBonus } from '../utils/scoring';

export type SortByField = 'score' | 'volume' | 'reputation' | 'seniority' | 'regularity' | 'diversity';

export interface TopAgentEntry {
  publicKeyHash: string;
  alias: string | null;
  score: number;
  totalTransactions: number;
  source: string;
  components: ScoreComponents;
}

export class AgentService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
    private trendService: TrendService,
    private snapshotRepo?: SnapshotRepository,
    private probeRepo?: ProbeRepository,
  ) {}

  getAgentScore(publicKeyHash: string): AgentScoreResponse {
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) throw new NotFoundError('Agent', publicKeyHash);

    const scoreResult = this.scoringService.getScore(publicKeyHash);
    const verifiedTx = this.txRepo.countVerifiedByAgent(publicKeyHash);
    const uniqueCounterparties = this.txRepo.countUniqueCounterparties(publicKeyHash);
    const attestationsCount = this.attestationRepo.countBySubject(publicKeyHash);
    const avgAttestationScore = this.attestationRepo.avgScoreBySubject(publicKeyHash);

    const delta = this.trendService.computeDeltas(publicKeyHash, scoreResult.total);
    const alerts = this.trendService.computeAlerts(publicKeyHash, scoreResult.total, delta);

    return {
      agent: {
        publicKeyHash: agent.public_key_hash,
        alias: agent.alias,
        firstSeen: agent.first_seen,
        lastSeen: agent.last_seen,
        source: agent.source,
      },
      score: {
        total: scoreResult.total,
        components: scoreResult.components,
        confidence: scoreResult.confidence,
        computedAt: scoreResult.computedAt,
      },
      stats: {
        totalTransactions: agent.total_transactions,
        verifiedTransactions: verifiedTx,
        uniqueCounterparties,
        attestationsReceived: attestationsCount,
        avgAttestationScore: Math.round(avgAttestationScore * 10) / 10,
      },
      evidence: this.buildEvidence(agent, verifiedTx),
      delta,
      alerts,
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
    const latest = this.probeRepo.findLatest(agentHash);
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

  getTopAgents(limit: number, offset: number, sortBy: SortByField = 'score'): TopAgentEntry[] {
    // For component-based sorting, fetch a larger pool, enrich, sort, then slice
    const fetchLimit = sortBy === 'score' ? limit : Math.min(200, limit + offset + 100);
    const fetchOffset = sortBy === 'score' ? offset : 0;
    const agents = this.agentRepo.findTopByScore(fetchLimit, fetchOffset);

    if (agents.length === 0) return [];

    // Batch-fetch latest snapshots for components
    const hashes = agents.map(a => a.public_key_hash);
    const snapshotMap = this.snapshotRepo
      ? this.snapshotRepo.findLatestByAgents(hashes)
      : new Map();

    let entries: TopAgentEntry[] = agents.map(a => {
      const snap = snapshotMap.get(a.public_key_hash);
      let components: ScoreComponents = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };
      if (snap) {
        try {
          const parsed = JSON.parse(snap.components);
          if (typeof parsed === 'object' && parsed !== null && typeof parsed.volume === 'number') {
            components = parsed as ScoreComponents;
          }
        } catch { /* use default */ }
      }
      return {
        publicKeyHash: a.public_key_hash,
        alias: a.alias,
        score: a.avg_score,
        totalTransactions: a.total_transactions,
        source: a.source,
        components,
      };
    });

    // Sort by requested field
    if (sortBy !== 'score') {
      entries.sort((a, b) => b.components[sortBy] - a.components[sortBy]);
      entries = entries.slice(offset, offset + limit);
    }

    return entries;
  }

  searchByAlias(alias: string, limit: number, offset: number) {
    return this.agentRepo.searchByAlias(alias, limit, offset);
  }
}
