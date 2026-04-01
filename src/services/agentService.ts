// Business logic for agents
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ScoringService } from './scoringService';
import type { AgentScoreResponse } from '../types';
import { NotFoundError } from '../errors';

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
    };
  }

  getTopAgents(limit: number, offset: number) {
    return this.agentRepo.findTopByScore(limit, offset);
  }

  searchByAlias(alias: string, limit: number, offset: number) {
    return this.agentRepo.searchByAlias(alias, limit, offset);
  }
}
