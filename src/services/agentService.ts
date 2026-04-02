// Business logic for agents
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ScoringService } from './scoringService';
import type { AgentScoreResponse, ScoreEvidence, Agent } from '../types';
import { NotFoundError } from '../errors';
import { computePopularityBonus } from '../utils/scoring';

export class AgentService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private scoringService: ScoringService,
  ) {}

  getAgentScore(publicKeyHash: string): AgentScoreResponse {
    const agent = this.agentRepo.findByHash(publicKeyHash);
    if (!agent) throw new NotFoundError('Agent', publicKeyHash);

    const scoreResult = this.scoringService.getScore(publicKeyHash);
    const verifiedTx = this.txRepo.countVerifiedByAgent(publicKeyHash);
    const uniqueCounterparties = this.txRepo.countUniqueCounterparties(publicKeyHash);
    const attestationsCount = this.attestationRepo.countBySubject(publicKeyHash);
    const avgAttestationScore = this.attestationRepo.avgScoreBySubject(publicKeyHash);

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
    };
  }

  private buildEvidence(agent: Agent, verifiedTxCount: number): ScoreEvidence {
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
    };
  }

  getTopAgents(limit: number, offset: number) {
    return this.agentRepo.findTopByScore(limit, offset);
  }

  searchByAlias(alias: string, limit: number, offset: number) {
    return this.agentRepo.searchByAlias(alias, limit, offset);
  }
}
