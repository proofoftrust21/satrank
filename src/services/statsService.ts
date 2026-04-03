// Global network statistics
import type Database from 'better-sqlite3';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { TrendService } from './trendService';
import type { HealthResponse, NetworkStats } from '../types';

const startTime = Date.now();

// Must match the latest migration version in migrations.ts
const EXPECTED_SCHEMA_VERSION = 10;

export class StatsService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private snapshotRepo: SnapshotRepository,
    private db: Database.Database,
    private trendService: TrendService,
  ) {}

  getHealth(): HealthResponse {
    let dbStatus: 'ok' | 'error' = 'error';
    let schemaVersion = 0;

    try {
      // Real DB liveness check
      this.db.prepare('SELECT 1').get();
      dbStatus = 'ok';

      // Latest schema version
      const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
      schemaVersion = row?.v ?? 0;
    } catch {
      dbStatus = 'error';
    }

    const status: 'ok' | 'error' = dbStatus === 'ok' && schemaVersion === EXPECTED_SCHEMA_VERSION ? 'ok' : 'error';

    return {
      status,
      agentsIndexed: dbStatus === 'ok' ? this.agentRepo.count() : 0,
      totalTransactions: dbStatus === 'ok' ? this.txRepo.totalCount() : 0,
      lastUpdate: dbStatus === 'ok' ? this.snapshotRepo.getLastUpdateTime() : 0,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      schemaVersion,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
      dbStatus,
    };
  }

  getNetworkStats(): NetworkStats {
    const buckets = this.txRepo.countByBucket();

    return {
      totalAgents: this.agentRepo.count(),
      totalChannels: this.agentRepo.sumChannels(),
      nodesWithRatings: this.agentRepo.countWithRatings(),
      networkCapacityBtc: this.agentRepo.networkCapacityBtc(),
      avgScore: this.agentRepo.avgScore(),
      totalVolumeBuckets: {
        micro: buckets['micro'] ?? 0,
        small: buckets['small'] ?? 0,
        medium: buckets['medium'] ?? 0,
        large: buckets['large'] ?? 0,
      },
      trends: this.trendService.getNetworkTrends(),
    };
  }
}
