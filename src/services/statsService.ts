// Global network statistics
import type Database from 'better-sqlite3';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { TrendService } from './trendService';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { HealthResponse, NetworkStats } from '../types';
import * as memoryCache from '../cache/memoryCache';
import { getFreshnessReport } from '../cache/memoryCache';
import { featureFlags } from '../config';
import { logger } from '../logger';
import { lndReachable } from '../middleware/metrics';

/** Critical caches monitored for staleness. Each entry expects a fresh refresh
 *  every TTL — if ageSec exceeds TTL×3, something is wrong (refresh failing).
 *
 *  Rule for membership: only caches whose freshness is driven by a BACKGROUND
 *  refresh (warmup timer / stale-while-revalidate kicked by live traffic).
 *  Caches whose age is bounded by external poll rate (e.g. `health:snapshot`,
 *  3s TTL but only polled every 30s by Docker) self-trigger false positives
 *  because the age reported INSIDE the compute reflects the last-computed
 *  timestamp — always ≥ poll interval. Monitoring /api/health with itself is
 *  a semantic paradox that desensitizes real alerts, so those keys are out.
 */
const CRITICAL_CACHES: Array<{ keyPrefix: string; expectedTtlSec: number }> = [
  { keyPrefix: 'stats:network', expectedTtlSec: 300 },   // 5 min TTL, warmed on boot + on-demand refresh
  { keyPrefix: 'agents:top', expectedTtlSec: 300 },      // 5 min TTL, warmed on boot + on-demand refresh
  // health:snapshot intentionally NOT listed — see rule above.
];

const startTime = Date.now();

const NETWORK_STATS_CACHE_KEY = 'stats:network';
// 5 minutes — long enough that refresh blocks are rare given the ~15s rebuild
// cost, short enough that values reflect recent crawler activity. Data freshness
// is ultimately bounded by the 30-min probe cycle anyway.
const NETWORK_STATS_TTL_MS = 5 * 60_000;

// Must match the latest migration version in migrations.ts
const EXPECTED_SCHEMA_VERSION = 34;

// H1: if no new score_snapshots in 2h, the crawler has stopped scoring.
// Crawler's LND graph interval is 1h and bulk scoring follows; 2h = 2× that
// budget, i.e. we've missed a full cycle. Keep the threshold generous so
// transient LND unavailability doesn't flap the health status.
const SCORING_STALE_THRESHOLD_SEC = 2 * 3600;

// H2: LND health probe cache. getInfo() is cheap but still a ~10-50ms
// network call; we cache for 30s so /api/health polling doesn't pin LND.
// 3 consecutive failures = degraded (same rule as cacheHealth).
const LND_HEALTH_TTL_MS = 30_000;
const LND_UNREACHABLE_THRESHOLD = 3;

export class StatsService {
  // H2: LND health snapshot. Populated by a fire-and-forget probe kicked off
  // from getHealth() when the cached value expires. Starts in 'unknown'
  // until the first probe completes.
  private lndLastProbedAtMs = 0;
  private lndLastSuccessAtMs = 0;
  private lndConsecutiveFailures = 0;
  private lndProbeInFlight = false;

  constructor(
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    private attestationRepo: AttestationRepository,
    private snapshotRepo: SnapshotRepository,
    private db: Database.Database,
    private trendService: TrendService,
    private probeRepo?: ProbeRepository,
    private serviceEndpointRepo?: ServiceEndpointRepository,
    private lndClient?: LndGraphClient,
  ) {}

  /** Fire-and-forget LND reachability probe. Results stored on the instance
   *  for the next getHealth() call to read. Guarded by `lndProbeInFlight`
   *  so overlapping /api/health polls can't issue concurrent getInfo calls. */
  private kickLndProbe(): void {
    if (!this.lndClient || this.lndProbeInFlight) return;
    this.lndProbeInFlight = true;
    const startMs = Date.now();
    this.lndClient.getInfo()
      .then(() => {
        this.lndLastSuccessAtMs = Date.now();
        this.lndLastProbedAtMs = Date.now();
        this.lndConsecutiveFailures = 0;
        lndReachable.set(1);
      })
      .catch((err: unknown) => {
        this.lndLastProbedAtMs = Date.now();
        this.lndConsecutiveFailures++;
        lndReachable.set(0);
        if (this.lndConsecutiveFailures === LND_UNREACHABLE_THRESHOLD) {
          // Escalate exactly once when we cross the threshold — not every
          // failed probe, otherwise a prolonged outage floods the logs.
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ error: msg, consecutiveFailures: this.lndConsecutiveFailures, latencyMs: Date.now() - startMs }, 'LND reachability degraded');
        }
      })
      .finally(() => { this.lndProbeInFlight = false; });
  }

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
      if (dbStatus === 'ok' && schemaVersion !== EXPECTED_SCHEMA_VERSION) {
        // Silent until now: a DB shipped on the wrong schema looks exactly
        // like a healthy DB from the outside and drifts until a migration
        // bug is caught by a user. Escalate when the mismatch first surfaces.
        logger.warn({ schemaVersion, expected: EXPECTED_SCHEMA_VERSION }, 'Schema version mismatch — health will report error');
      }

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

      // H1: scoring staleness. score_snapshots stop advancing when the
      // crawler dies or LND graph crawl can't reach LND. Either way the API
      // is serving increasingly outdated scores; degraded health is the signal.
      const lastUpdate = dbStatus === 'ok' ? this.snapshotRepo.getLastUpdateTime() : 0;
      const nowSec = Math.floor(Date.now() / 1000);
      const scoringAgeSec = lastUpdate > 0 ? nowSec - lastUpdate : null;
      const scoringStale = scoringAgeSec !== null && scoringAgeSec > SCORING_STALE_THRESHOLD_SEC;

      // H2: kick a fresh LND probe if ours is stale. Synchronous path returns
      // the last known state; the probe updates instance state for the NEXT
      // caller. First call on a cold start sees lndStatus = 'unknown'.
      let lndStatus: 'ok' | 'degraded' | 'unknown' | 'disabled' = 'disabled';
      let lndLastProbeAgeSec: number | null = null;
      if (this.lndClient) {
        if (Date.now() - this.lndLastProbedAtMs > LND_HEALTH_TTL_MS) {
          this.kickLndProbe();
        }
        if (this.lndConsecutiveFailures >= LND_UNREACHABLE_THRESHOLD) {
          lndStatus = 'degraded';
        } else if (this.lndLastSuccessAtMs > 0) {
          lndStatus = 'ok';
        } else {
          lndStatus = 'unknown';
        }
        if (this.lndLastProbedAtMs > 0) {
          lndLastProbeAgeSec = Math.floor((Date.now() - this.lndLastProbedAtMs) / 1000);
        }
      }

      const finalStatus: 'ok' | 'error' =
        status === 'ok' && !cacheHealth.degraded && !scoringStale && lndStatus !== 'degraded'
          ? 'ok'
          : status === 'ok'
            ? 'error'
            : status;

      return {
        status: finalStatus,
        agentsIndexed: dbStatus === 'ok' ? this.agentRepo.count() : 0,
        staleAgents: dbStatus === 'ok' ? this.agentRepo.countStale() : 0,
        totalTransactions: dbStatus === 'ok' ? this.txRepo.totalCount() : 0,
        lastUpdate,
        scoringAgeSec,
        scoringStale,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        schemaVersion,
        expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
        dbStatus,
        lndStatus,
        lndLastProbeAgeSec,
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
        totalVolumeBuckets: {
          micro: buckets['micro'] ?? 0,
          small: buckets['small'] ?? 0,
          medium: buckets['medium'] ?? 0,
          large: buckets['large'] ?? 0,
        },
        serviceSources: this.serviceEndpointRepo?.countBySource() ?? { '402index': 0, 'self_registered': 0, 'ad_hoc': 0 },
      };
    });
  }
}
