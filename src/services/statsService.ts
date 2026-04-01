// Global network statistics
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { HealthResponse, NetworkStats } from '../types';

const startTime = Date.now();

export class StatsService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      agentsIndexed: this.agentRepo.count(),
      totalTransactions: this.txRepo.totalCount(),
      lastUpdate: this.snapshotRepo.getLastUpdateTime(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  }

  getNetworkStats(): NetworkStats {
    const buckets = this.txRepo.countByBucket();

    return {
      totalAgents: this.agentRepo.count(),
      totalTransactions: this.txRepo.totalCount(),
      totalAttestations: this.attestationRepo.totalCount(),
      avgScore: this.agentRepo.avgScore(),
      totalVolumeBuckets: {
        micro: buckets['micro'] ?? 0,
        small: buckets['small'] ?? 0,
        medium: buckets['medium'] ?? 0,
        large: buckets['large'] ?? 0,
      },
    };
  }
}
