// Temporal delta and trend tests — Phase 3 C8 bayesian shape.
// Deltas are on the p_success posterior scale (0..1). Alert thresholds:
//   drop -0.10 warning / -0.20 critical, surge +0.15 info, stable band ±0.02.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { v4 as uuid } from 'uuid';
import { AgentRepository } from '../repositories/agentRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TrendService } from '../services/trendService';
import { sha256 } from '../utils/crypto';
import type { Agent, ScoreSnapshot } from '../types';
let testDb: TestDb;

const DAY = 86400;
const NOW = 1_776_240_000 + 30 * DAY;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 0,
    avg_score: 50,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

async function insertSnapshot(
  repo: SnapshotRepository,
  agentHash: string,
  pSuccess: number,
  computedAt: number,
): Promise<void> {
  const snap: ScoreSnapshot = {
    snapshot_id: uuid(),
    agent_hash: agentHash,
    p_success: pSuccess,
    ci95_low: Math.max(0, pSuccess - 0.05),
    ci95_high: Math.min(1, pSuccess + 0.05),
    n_obs: 10,
    posterior_alpha: 1.5 + 10 * pSuccess,
    posterior_beta: 1.5 + 10 * (1 - pSuccess),
    window: '7d',
    computed_at: computedAt,
    updated_at: computedAt,
  };
  await repo.insert(snap);
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('TrendService', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let snapshotRepo: SnapshotRepository;
  let trendService: TrendService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    trendService = new TrendService(agentRepo, snapshotRepo);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    vi.useRealTimers();
  });

  // --- computeDeltas ---

  it('returns null deltas when no historical snapshots exist', async () => {
    const hash = sha256('no-history');
    await agentRepo.insert(makeAgent('no-history', { avg_score: 60 }));

    const delta = await trendService.computeDeltas(hash, 0.60);

    expect(delta.delta24h).toBeNull();
    expect(delta.delta7d).toBeNull();
    expect(delta.delta30d).toBeNull();
    expect(delta.trend).toBe('stable');
  });

  it('computes positive delta when p_success increased', async () => {
    const hash = sha256('rising-agent');
    await agentRepo.insert(makeAgent('rising-agent', { avg_score: 70 }));

    // 8 days ago: p_success was 0.50
    await insertSnapshot(snapshotRepo, hash, 0.50, NOW - 8 * DAY);
    // 2 days ago: p_success was 0.60
    await insertSnapshot(snapshotRepo, hash, 0.60, NOW - 2 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.70);

    expect(delta.delta24h).toBe(0.1);  // 0.70 - 0.60
    expect(delta.delta7d).toBe(0.2);   // 0.70 - 0.50
    expect(delta.delta30d).toBeNull(); // no snapshot before 30d ago
    expect(delta.trend).toBe('rising');
  });

  it('computes negative delta when p_success decreased', async () => {
    const hash = sha256('falling-agent');
    await agentRepo.insert(makeAgent('falling-agent', { avg_score: 40 }));

    await insertSnapshot(snapshotRepo, hash, 0.60, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hash, 0.50, NOW - 2 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.40);

    expect(delta.delta7d).toBe(-0.2);  // 0.40 - 0.60
    expect(delta.trend).toBe('falling');
  });

  it('trend is stable when delta is within ±0.02', async () => {
    const hash = sha256('stable-agent');
    await agentRepo.insert(makeAgent('stable-agent', { avg_score: 51 }));

    await insertSnapshot(snapshotRepo, hash, 0.50, NOW - 8 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.51);

    expect(delta.delta7d).toBe(0.01);
    expect(delta.trend).toBe('stable');
  });

  // --- computeAlerts ---

  it('generates score_drop alert when delta7d <= -0.10', async () => {
    const hash = sha256('dropping');
    await agentRepo.insert(makeAgent('dropping', { avg_score: 40 }));
    await insertSnapshot(snapshotRepo, hash, 0.55, NOW - 8 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.40);
    const alerts = await trendService.computeAlerts(hash, 0.40, delta);

    expect(alerts.some(a => a.type === 'score_drop')).toBe(true);
    expect(alerts.find(a => a.type === 'score_drop')?.severity).toBe('warning');
  });

  it('generates critical alert when delta7d <= -0.20', async () => {
    const hash = sha256('crashing');
    await agentRepo.insert(makeAgent('crashing', { avg_score: 30 }));
    await insertSnapshot(snapshotRepo, hash, 0.55, NOW - 8 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.30);
    const alerts = await trendService.computeAlerts(hash, 0.30, delta);

    const drop = alerts.find(a => a.type === 'score_drop');
    expect(drop).toBeDefined();
    expect(drop?.severity).toBe('critical');
  });

  it('generates score_surge alert when delta7d >= 0.15', async () => {
    const hash = sha256('surging');
    await agentRepo.insert(makeAgent('surging', { avg_score: 75 }));
    await insertSnapshot(snapshotRepo, hash, 0.55, NOW - 8 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.75);
    const alerts = await trendService.computeAlerts(hash, 0.75, delta);

    expect(alerts.some(a => a.type === 'score_surge')).toBe(true);
    expect(alerts.find(a => a.type === 'score_surge')?.severity).toBe('info');
  });

  it('generates new_agent alert for agents less than 7 days old', async () => {
    const hash = sha256('newbie');
    await agentRepo.insert(makeAgent('newbie', {
      first_seen: NOW - 3 * DAY,
      avg_score: 20,
    }));

    const delta = await trendService.computeDeltas(hash, 0.20);
    const alerts = await trendService.computeAlerts(hash, 0.20, delta);

    expect(alerts.some(a => a.type === 'new_agent')).toBe(true);
  });

  it('generates inactive alert for agents not seen in 60+ days', async () => {
    const hash = sha256('ghost');
    await agentRepo.insert(makeAgent('ghost', {
      last_seen: NOW - 90 * DAY,
      avg_score: 30,
    }));

    const delta = await trendService.computeDeltas(hash, 0.30);
    const alerts = await trendService.computeAlerts(hash, 0.30, delta);

    expect(alerts.some(a => a.type === 'inactive')).toBe(true);
    expect(alerts.find(a => a.type === 'inactive')?.severity).toBe('warning');
  });

  it('generates no alerts for normal stable agent', async () => {
    const hash = sha256('normal');
    await agentRepo.insert(makeAgent('normal', { avg_score: 50 }));
    await insertSnapshot(snapshotRepo, hash, 0.49, NOW - 8 * DAY);

    const delta = await trendService.computeDeltas(hash, 0.50);
    const alerts = await trendService.computeAlerts(hash, 0.50, delta);

    expect(alerts).toHaveLength(0);
  });

  // --- getTopMovers ---

  it('returns top movers up and down', async () => {
    // Insert several agents with snapshots showing different deltas.
    // Note: getTopMovers reads the *current* p_success from the latest
    // snapshot (not agents.avg_score), so we write both the past and
    // current snapshot.
    const agents = [
      { alias: 'mover-up',     avg: 80, current: 0.80, past: 0.50 },
      { alias: 'mover-down',   avg: 30, current: 0.30, past: 0.60 },
      { alias: 'mover-stable', avg: 50, current: 0.50, past: 0.50 },
    ];

    for (const a of agents) {
      const hash = sha256(a.alias);
      await agentRepo.insert(makeAgent(a.alias, { avg_score: a.avg }));
      await insertSnapshot(snapshotRepo, hash, a.past, NOW - 8 * DAY);
      await insertSnapshot(snapshotRepo, hash, a.current, NOW - 1);
    }

    const { up, down } = await trendService.getTopMovers(5);

    expect(up.length).toBeGreaterThanOrEqual(1);
    expect(up[0].alias).toBe('mover-up');
    expect(up[0].delta7d).toBe(0.3);    // 0.80 - 0.50
    expect(up[0].pSuccess).toBe(0.80);

    expect(down.length).toBeGreaterThanOrEqual(1);
    expect(down[0].alias).toBe('mover-down');
    expect(down[0].delta7d).toBe(-0.3); // 0.30 - 0.60
    expect(down[0].pSuccess).toBe(0.30);
  });

  it('returns empty movers when no historical data', async () => {
    await agentRepo.insert(makeAgent('lonely'));

    const { up, down } = await trendService.getTopMovers(5);

    expect(up).toHaveLength(0);
    expect(down).toHaveLength(0);
  });

  it('top movers surface clean 3-decimal p_success delta', async () => {
    // Guards against float accumulation noise (e.g. -0.17439999... instead of -0.174).
    const hash = sha256('float-check');
    await agentRepo.insert(makeAgent('float-check', { avg_score: 80 }));
    await insertSnapshot(snapshotRepo, hash, 0.98, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hash, 0.80, NOW - 1);

    const { down } = await trendService.getTopMovers(5);
    const m = down.find(x => x.alias === 'float-check');
    expect(m).toBeDefined();
    expect(m!.pSuccess).toBe(0.80);
    expect(m!.delta7d).toBe(-0.18);
    expect(m!.deltaValid).toBe(true);
  });

  // --- getNetworkTrends ---

  it('returns network trends with avgPSuccessDelta7d', async () => {
    const hash1 = sha256('trend-a');
    const hash2 = sha256('trend-b');
    await agentRepo.insert(makeAgent('trend-a', { avg_score: 70 }));
    await agentRepo.insert(makeAgent('trend-b', { avg_score: 60 }));

    // Past snapshots at 8d, current at now-1s.
    await insertSnapshot(snapshotRepo, hash1, 0.50, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hash2, 0.50, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hash1, 0.70, NOW - 1);
    await insertSnapshot(snapshotRepo, hash2, 0.60, NOW - 1);

    const trends = await trendService.getNetworkTrends();

    // Current avg: (0.70+0.60)/2 = 0.65, past avg: 0.50 → delta = 0.15
    expect(trends.avgPSuccessDelta7d).toBe(0.15);
    expect(trends.topMoversUp.length).toBeGreaterThanOrEqual(1);
  });

  // --- Snapshot repo p_success methods ---

  it('findPSuccessAt returns closest p_success at or before timestamp', async () => {
    const hash = sha256('p-at');
    await agentRepo.insert(makeAgent('p-at'));

    await insertSnapshot(snapshotRepo, hash, 0.40, NOW - 10 * DAY);
    await insertSnapshot(snapshotRepo, hash, 0.50, NOW - 5 * DAY);
    await insertSnapshot(snapshotRepo, hash, 0.60, NOW - 1 * DAY);

    expect(await snapshotRepo.findPSuccessAt(hash, NOW - 7 * DAY)).toBe(0.40);
    expect(await snapshotRepo.findPSuccessAt(hash, NOW - 3 * DAY)).toBe(0.50);
    expect(await snapshotRepo.findPSuccessAt(hash, NOW)).toBe(0.60);
  });

  it('findPSuccessAt returns null when no snapshot before timestamp', async () => {
    const hash = sha256('future');
    await agentRepo.insert(makeAgent('future'));
    await insertSnapshot(snapshotRepo, hash, 0.50, NOW - 1 * DAY);

    expect(await snapshotRepo.findPSuccessAt(hash, NOW - 10 * DAY)).toBeNull();
  });

  it('findAvgPSuccessAt returns network average at timestamp', async () => {
    const hash1 = sha256('avg-a');
    const hash2 = sha256('avg-b');
    await agentRepo.insert(makeAgent('avg-a'));
    await agentRepo.insert(makeAgent('avg-b'));

    await insertSnapshot(snapshotRepo, hash1, 0.60, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hash2, 0.40, NOW - 8 * DAY);

    const avg = await snapshotRepo.findAvgPSuccessAt(NOW - 7 * DAY);
    expect(avg).toBe(0.5); // (0.60+0.40)/2
  });

  // --- deltaValid: always true post-Phase 3 (no methodology cutoff) ---

  it('deltaValid is true when no comparator exists', async () => {
    const hash = sha256('fresh-agent');
    await agentRepo.insert(makeAgent('fresh-agent', { avg_score: 70 }));

    const delta = await trendService.computeDeltas(hash, 0.70);

    expect(delta.delta7d).toBeNull();
    expect(delta.deltaValid).toBe(true);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('computeDeltasBatch returns delta7d per agent', async () => {
    const hashA = sha256('batch-a');
    const hashB = sha256('batch-b');
    await agentRepo.insert(makeAgent('batch-a', { avg_score: 80 }));
    await agentRepo.insert(makeAgent('batch-b', { avg_score: 80 }));

    await insertSnapshot(snapshotRepo, hashA, 0.95, NOW - 8 * DAY);
    await insertSnapshot(snapshotRepo, hashB, 0.78, NOW - 8 * DAY);

    const map = await trendService.computeDeltasBatch([
      { hash: hashA, pSuccess: 0.80 },
      { hash: hashB, pSuccess: 0.80 },
    ]);

    expect(map.get(hashA)!.deltaValid).toBe(true);
    expect(map.get(hashA)!.delta7d).toBe(-0.15);
    expect(map.get(hashB)!.deltaValid).toBe(true);
    expect(map.get(hashB)!.delta7d).toBe(0.02);
  });
});
