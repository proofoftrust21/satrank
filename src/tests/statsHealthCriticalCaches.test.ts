// Regression tests for /api/health cacheHealth: exact-key critical match
// and warm-up freshness tracking. Prior behavior used a prefix match against
// "agents:top", so any caller populating `agents:top:3:0:p_success` (a limit
// outside the warm-up plan) aged out forever and flipped health to "error"
// without any real degradation. These tests pin the new contract.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TrendService } from '../services/trendService';
import {
  StatsService,
  CRITICAL_CACHE_KEYS,
  CRITICAL_CACHE_TTL_MS,
  TOP_SORT_AXES,
  TOP_WARMUP_LIMITS,
} from '../services/statsService';
import * as memoryCache from '../cache/memoryCache';
import type { HealthResponse } from '../types';

function buildStatsService(db: Database.Database): StatsService {
  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  return new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
}

/** `cacheHealth` is declared optional on `HealthResponse` but statsService
 *  always returns it. Narrow + assert so tests can access fields without `!`
 *  and still fail loudly if the production shape ever drops the field. */
function cacheHealthOf(h: HealthResponse): NonNullable<HealthResponse['cacheHealth']> {
  expect(h.cacheHealth).toBeDefined();
  return h.cacheHealth as NonNullable<HealthResponse['cacheHealth']>;
}

/** Populate every critical key through memoryCache so getFreshnessReport sees
 *  them as freshly refreshed. Used to simulate a healthy post-warmup state. */
function populateAllCriticalKeys(now: Date): void {
  vi.setSystemTime(now);
  for (const key of CRITICAL_CACHE_KEYS) {
    memoryCache.setFresh(key, { stub: key }, CRITICAL_CACHE_TTL_MS);
  }
}

describe('CRITICAL_CACHE_KEYS shape', () => {
  it('contains stats:network + exactly 3 limits × 4 sort_by leaderboard combos', () => {
    expect(CRITICAL_CACHE_KEYS).toContain('stats:network');
    expect(CRITICAL_CACHE_KEYS).toHaveLength(1 + TOP_WARMUP_LIMITS.length * TOP_SORT_AXES.length);
    for (const limit of TOP_WARMUP_LIMITS) {
      for (const axis of TOP_SORT_AXES) {
        expect(CRITICAL_CACHE_KEYS).toContain(`agents:top:${limit}:0:${axis}`);
      }
    }
  });

  it('excludes one-off leaderboard variants outside the warm-up plan', () => {
    expect(CRITICAL_CACHE_KEYS).not.toContain('agents:top:3:0:p_success');
    expect(CRITICAL_CACHE_KEYS).not.toContain('agents:top:7:0:n_obs');
    expect(CRITICAL_CACHE_KEYS).not.toContain('agents:top:100:0:window_freshness');
  });

  it('excludes health:snapshot (self-referential, would flap on poll cadence)', () => {
    expect(CRITICAL_CACHE_KEYS).not.toContain('health:snapshot');
  });
});

describe('StatsService.getHealth cacheHealth (exact-key match)', () => {
  let db: Database.Database;
  let statsService: StatsService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    statsService = buildStatsService(db);
    memoryCache.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    memoryCache.clear();
    db.close();
  });

  it('reports cacheHealth.degraded=false when every critical key is fresh', () => {
    populateAllCriticalKeys(new Date('2026-04-20T12:00:00Z'));
    // 10s later — well within TTL×3
    vi.setSystemTime(new Date('2026-04-20T12:00:10Z'));

    const cacheHealth = cacheHealthOf(statsService.getHealth());
    expect(cacheHealth.degraded).toBe(false);
    expect(cacheHealth.critical).toEqual([]);
  });

  it('reports cacheHealth.degraded=true when ANY critical key exceeds TTL×3', () => {
    populateAllCriticalKeys(new Date('2026-04-20T12:00:00Z'));
    // Advance past TTL×3 (= 900s at 300s TTL)
    vi.setSystemTime(new Date('2026-04-20T12:15:01Z'));

    const cacheHealth = cacheHealthOf(statsService.getHealth());
    expect(cacheHealth.degraded).toBe(true);
    expect(cacheHealth.critical.length).toBeGreaterThan(0);
    // Every flagged key must be in CRITICAL_CACHE_KEYS (no prefix spill-over)
    for (const entry of cacheHealth.critical) {
      expect(CRITICAL_CACHE_KEYS).toContain(entry.key);
    }
  });

  it('keeps cacheHealth.degraded=false when only a non-critical one-off key is stale', () => {
    const now = new Date('2026-04-20T12:00:00Z');
    populateAllCriticalKeys(now);
    // One-off caller populates a limit=3 variant — NOT in CRITICAL_CACHE_KEYS.
    memoryCache.setFresh('agents:top:3:0:p_success', { stub: 'noop' }, CRITICAL_CACHE_TTL_MS);
    // Advance 50 min — the limit=3 entry is now 50 min stale, critical ones too old? No —
    // we just refreshed the criticals at `now` and the limit=3 one at `now` too. Refresh
    // criticals again to keep them fresh while letting the limit=3 age out.
    vi.setSystemTime(new Date('2026-04-20T12:30:00Z'));
    for (const key of CRITICAL_CACHE_KEYS) {
      memoryCache.setFresh(key, { stub: key }, CRITICAL_CACHE_TTL_MS);
    }
    // Now jump 20 min forward — criticals only 20 min old (< 15 min TTL×3 cutoff? 20>15).
    // Tighten: criticals refreshed at 12:30, we sit at 12:40 → criticals 10 min old, OK.
    // limit=3 key last touched at 12:00 → 40 min stale.
    vi.setSystemTime(new Date('2026-04-20T12:40:00Z'));

    const cacheHealth = cacheHealthOf(statsService.getHealth());
    expect(cacheHealth.degraded).toBe(false);
    expect(cacheHealth.critical).toEqual([]);
  });

  it('reports cacheHealth.degraded=true when a critical key has ≥3 consecutive refresh failures', async () => {
    populateAllCriticalKeys(new Date('2026-04-20T12:00:00Z'));
    // Move past TTL so subsequent getOrCompute calls hit the stale path and
    // schedule a background refresh. Each refresh throws → bumps
    // consecutiveFailures. Serialise the attempts with awaits so the
    // "refreshing" dedup guard releases between iterations.
    vi.setSystemTime(new Date('2026-04-20T12:05:01Z'));
    const boomKey = 'stats:network';
    for (let i = 0; i < 3; i++) {
      memoryCache.getOrCompute(boomKey, CRITICAL_CACHE_TTL_MS, () => {
        throw new Error('simulated refresh failure');
      });
      await new Promise(resolve => setImmediate(resolve));
    }
    // health:snapshot is itself cached for 3s — invalidate so the assertion
    // observes the post-failure state rather than a pre-failure snapshot.
    memoryCache.invalidate('health:snapshot');

    const cacheHealth = cacheHealthOf(statsService.getHealth());
    const flagged = cacheHealth.critical.find(c => c.key === boomKey);
    expect(flagged).toBeDefined();
    expect(flagged!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(cacheHealth.degraded).toBe(true);
  });

  it('keeps cacheHealth.degraded=false on cold boot when critical keys have never been populated', () => {
    // memoryCache.clear() in beforeEach guarantees no freshness entries exist.
    // Before warm-up completes, the health check must NOT report degraded —
    // otherwise every boot would fail for ~1s until warm-up finishes.
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

    const cacheHealth = cacheHealthOf(statsService.getHealth());
    expect(cacheHealth.degraded).toBe(false);
    expect(cacheHealth.critical).toEqual([]);
  });
});

describe('memoryCache.setFresh', () => {
  beforeEach(() => {
    memoryCache.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    memoryCache.clear();
  });

  it('stores the value AND marks the key as freshly refreshed', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    memoryCache.setFresh('k', { a: 1 }, 10_000);
    expect(memoryCache.get<{ a: number }>('k')).toEqual({ a: 1 });

    const report = memoryCache.getFreshnessReport();
    const entry = report.find(r => r.key === 'k');
    expect(entry).toBeDefined();
    expect(entry!.ageSec).toBe(0);
    expect(entry!.consecutiveFailures).toBe(0);
  });

  it('advances the freshness clock on every call (unlike plain set)', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    memoryCache.setFresh('k', 'v1', 60_000);

    vi.setSystemTime(new Date('2026-04-20T12:00:30Z'));
    let entry = memoryCache.getFreshnessReport().find(r => r.key === 'k');
    expect(entry!.ageSec).toBe(30);

    memoryCache.setFresh('k', 'v2', 60_000); // refresh
    entry = memoryCache.getFreshnessReport().find(r => r.key === 'k');
    expect(entry!.ageSec).toBe(0);
  });

  it('plain set() does NOT touch freshness tracking', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    memoryCache.set('plain', 'v', 60_000);

    const entry = memoryCache.getFreshnessReport().find(r => r.key === 'plain');
    expect(entry).toBeUndefined();
  });
});
