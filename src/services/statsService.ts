// Global network statistics
import type Database from 'better-sqlite3';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { TrendService } from './trendService';
import type { HealthResponse, NetworkStats } from '../types';
import * as memoryCache from '../cache/memoryCache';
import { getFreshnessReport } from '../cache/memoryCache';
import { featureFlags } from '../config';

/** Critical caches monitored for staleness. Each entry expects a fresh refresh
 *  every TTL — if ageSec exceeds TTL×3, something is wrong (refresh failing). */
const CRITICAL_CACHES: Array<{ keyPrefix: string; expectedTtlSec: number }> = [
  { keyPrefix: 'stats:network', expectedTtlSec: 300 },   // 5 min TTL
  { keyPrefix: 'agents:top', expectedTtlSec: 300 },      // 5 min TTL
  { keyPrefix: 'health:snapshot', expectedTtlSec: 3 },   // 3 sec TTL
];

const startTime = Date.now();

const NETWORK_STATS_CACHE_KEY = 'stats:network';
// 5 minutes — long enough that refresh blocks are rare given the ~15s rebuild
// cost, short enough that values reflect recent crawler activity. Data freshness
// is ultimately bounded by the 30-min probe cycle anyway.
const NETWORK_STATS_TTL_MS = 5 * 60_000;

// Must match the latest migration version in migrations.ts
const EXPECTED_SCHEMA_VERSION = 28;

export class StatsService {
  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private snapshotRepo: SnapshotRepository,
    private db: Database.Database,
    private trendService: TrendService,
    private probeRepo?: ProbeRepository,
    private serviceEndpointRepo?: ServiceEndpointRepository,
  ) {}

  getHealth(): HealthResponse {
    // Cached for 3s — under load, /health is polled constantly by healthcheck
    // agents and monitoring. The heavy COUNT(*) on snapshots doesn't need to
    // run per request. Stale-while-revalidate: response is always instant.
    return memoryCache.getOrCompute<HealthResponse>('health:snapshot', 3_000, () => {
      let dbStatus: 'ok' | 'error' = 'error';
      let schemaVersion = 0;

      try {
        this.db.prepare('SELECT 1').get();
        dbStatus = 'ok';
        const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
        schemaVersion = row?.v ?? 0;
      } catch {
        dbStatus = 'error';
      }

      const status: 'ok' | 'error' = dbStatus === 'ok' && schemaVersion === EXPECTED_SCHEMA_VERSION ? 'ok' : 'error';

      // Cache freshness: flag any critical cache that's > 3x its TTL old or failing repeatedly
      const freshness = getFreshnessReport();
      const critical: Array<{ key: string; ageSec: number; consecutiveFailures: number }> = [];
      for (const { keyPrefix, expectedTtlSec } of CRITICAL_CACHES) {
        const matches = freshness.filter(f => f.key.startsWith(keyPrefix));
        for (const m of matches) {
          if (m.ageSec > expectedTtlSec * 3 || m.consecutiveFailures >= 3) {
            critical.push(m);
          }
        }
      }
      const cacheHealth = { degraded: critical.length > 0, critical };
      const finalStatus: 'ok' | 'error' = status === 'ok' && !cacheHealth.degraded ? 'ok' : status;

      return {
        status: finalStatus,
        agentsIndexed: dbStatus === 'ok' ? this.agentRepo.count() : 0,
        staleAgents: dbStatus === 'ok' ? this.agentRepo.countStale() : 0,
        totalTransactions: dbStatus === 'ok' ? this.txRepo.totalCount() : 0,
        lastUpdate: dbStatus === 'ok' ? this.snapshotRepo.getLastUpdateTime() : 0,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        schemaVersion,
        expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
        dbStatus,
        features: featureFlags,
        cacheHealth,
      };
    });
  }

  getNetworkStats(): NetworkStats {
    // Stale-while-revalidate — first caller on a cold key waits; afterwards
    // subscribers always get an instant response while refreshes happen in
    // the background on expiry.
    return memoryCache.getOrCompute<NetworkStats>(NETWORK_STATS_CACHE_KEY, NETWORK_STATS_TTL_MS, () => {
      const buckets = this.txRepo.countByBucket();
      const nodesProbed = this.probeRepo?.countProbedAgents() ?? 0;
      const verifiedReachable = this.probeRepo?.countReachable() ?? 0;

      return {
        totalAgents: this.agentRepo.count(),
        totalEndpoints: this.agentRepo.countBySource('lightning_graph'),
        nodesProbed,
        phantomRate: nodesProbed > 0 ? Math.round((1 - verifiedReachable / nodesProbed) * 100) : 0,
        verifiedReachable,
        probes24h: this.probeRepo?.countProbesLast24h() ?? 0,
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
        serviceSources: this.serviceEndpointRepo?.countBySource() ?? { '402index': 0, 'self_registered': 0, 'ad_hoc': 0 },
      };
    });
  }
}
