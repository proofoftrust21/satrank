// Temporal delta and trend tests
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TrendService } from '../services/trendService';
import { sha256 } from '../utils/crypto';
import { METHODOLOGY_CHANGE_AT_UNIX } from '../config/scoring';
import type { Agent, ScoreSnapshot } from '../types';

const DAY = 86400;
// Anchor the whole suite well past METHODOLOGY_CHANGE_AT_UNIX so tests that
// insert snapshots at `NOW - 8*DAY` (pre-deltaValid shape) land post-cutoff
// and keep a numeric delta7d. The cutoff-specific describes override this.
const NOW = 1_776_240_000 + 30 * DAY; // cutoff + 30 days

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

function insertSnapshot(repo: SnapshotRepository, agentHash: string, score: number, computedAt: number): void {
  repo.insert({
    snapshot_id: uuid(),
    agent_hash: agentHash,
    score,
    components: JSON.stringify({ volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 }),
    computed_at: computedAt,
  });
}

describe('TrendService', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let snapshotRepo: SnapshotRepository;
  let trendService: TrendService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    trendService = new TrendService(agentRepo, snapshotRepo);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // --- computeDeltas ---

  it('returns null deltas when no historical snapshots exist', () => {
    const hash = sha256('no-history');
    agentRepo.insert(makeAgent('no-history', { avg_score: 60 }));

    const delta = trendService.computeDeltas(hash, 60);

    expect(delta.delta24h).toBeNull();
    expect(delta.delta7d).toBeNull();
    expect(delta.delta30d).toBeNull();
    expect(delta.trend).toBe('stable');
  });

  it('computes positive delta when score increased', () => {
    const hash = sha256('rising-agent');
    agentRepo.insert(makeAgent('rising-agent', { avg_score: 70 }));

    // 8 days ago: score was 50
    insertSnapshot(snapshotRepo, hash, 50, NOW - 8 * DAY);
    // 2 days ago: score was 60
    insertSnapshot(snapshotRepo, hash, 60, NOW - 2 * DAY);

    const delta = trendService.computeDeltas(hash, 70);

    expect(delta.delta24h).toBe(10); // 70 - 60 (closest before 24h ago is 2d ago snap)
    expect(delta.delta7d).toBe(20);  // 70 - 50 (closest before 7d ago is 8d ago snap)
    expect(delta.delta30d).toBeNull(); // no snapshot before 30d ago
    expect(delta.trend).toBe('rising');
  });

  it('computes negative delta when score decreased', () => {
    const hash = sha256('falling-agent');
    agentRepo.insert(makeAgent('falling-agent', { avg_score: 40 }));

    insertSnapshot(snapshotRepo, hash, 60, NOW - 8 * DAY);
    insertSnapshot(snapshotRepo, hash, 50, NOW - 2 * DAY);

    const delta = trendService.computeDeltas(hash, 40);

    expect(delta.delta7d).toBe(-20); // 40 - 60 (closest before 7d ago is 8d ago snap)
    expect(delta.trend).toBe('falling');
  });

  it('trend is stable when delta is within -2..+2', () => {
    const hash = sha256('stable-agent');
    agentRepo.insert(makeAgent('stable-agent', { avg_score: 51 }));

    insertSnapshot(snapshotRepo, hash, 50, NOW - 8 * DAY);

    const delta = trendService.computeDeltas(hash, 51);

    expect(delta.delta7d).toBe(1);
    expect(delta.trend).toBe('stable');
  });

  // --- computeAlerts ---

  it('generates score_drop alert when delta7d <= -10', () => {
    const hash = sha256('dropping');
    agentRepo.insert(makeAgent('dropping', { avg_score: 40 }));
    insertSnapshot(snapshotRepo, hash, 55, NOW - 8 * DAY);

    const delta = trendService.computeDeltas(hash, 40);
    const alerts = trendService.computeAlerts(hash, 40, delta);

    expect(alerts.some(a => a.type === 'score_drop')).toBe(true);
    expect(alerts.find(a => a.type === 'score_drop')?.severity).toBe('warning');
  });

  it('generates critical alert when delta7d <= -20', () => {
    const hash = sha256('crashing');
    agentRepo.insert(makeAgent('crashing', { avg_score: 30 }));
    insertSnapshot(snapshotRepo, hash, 55, NOW - 8 * DAY);

    const delta = trendService.computeDeltas(hash, 30);
    const alerts = trendService.computeAlerts(hash, 30, delta);

    const drop = alerts.find(a => a.type === 'score_drop');
    expect(drop).toBeDefined();
    expect(drop?.severity).toBe('critical');
  });

  it('generates score_surge alert when delta7d >= 15', () => {
    const hash = sha256('surging');
    agentRepo.insert(makeAgent('surging', { avg_score: 75 }));
    insertSnapshot(snapshotRepo, hash, 55, NOW - 8 * DAY);

    const delta = trendService.computeDeltas(hash, 75);
    const alerts = trendService.computeAlerts(hash, 75, delta);

    expect(alerts.some(a => a.type === 'score_surge')).toBe(true);
    expect(alerts.find(a => a.type === 'score_surge')?.severity).toBe('info');
  });

  it('generates new_agent alert for agents less than 7 days old', () => {
    const hash = sha256('newbie');
    agentRepo.insert(makeAgent('newbie', {
      first_seen: NOW - 3 * DAY,
      avg_score: 20,
    }));

    const delta = trendService.computeDeltas(hash, 20);
    const alerts = trendService.computeAlerts(hash, 20, delta);

    expect(alerts.some(a => a.type === 'new_agent')).toBe(true);
  });

  it('generates inactive alert for agents not seen in 60+ days', () => {
    const hash = sha256('ghost');
    agentRepo.insert(makeAgent('ghost', {
      last_seen: NOW - 90 * DAY,
      avg_score: 30,
    }));

    const delta = trendService.computeDeltas(hash, 30);
    const alerts = trendService.computeAlerts(hash, 30, delta);

    expect(alerts.some(a => a.type === 'inactive')).toBe(true);
    expect(alerts.find(a => a.type === 'inactive')?.severity).toBe('warning');
  });

  it('generates no alerts for normal stable agent', () => {
    const hash = sha256('normal');
    agentRepo.insert(makeAgent('normal', { avg_score: 50 }));
    insertSnapshot(snapshotRepo, hash, 49, NOW - 8 * DAY);

    const delta = trendService.computeDeltas(hash, 50);
    const alerts = trendService.computeAlerts(hash, 50, delta);

    expect(alerts).toHaveLength(0);
  });

  // --- getTopMovers ---

  it('returns top movers up and down', () => {
    // Insert several agents with snapshots showing different deltas
    const agents = [
      { alias: 'mover-up', currentScore: 80, pastScore: 50 },
      { alias: 'mover-down', currentScore: 30, pastScore: 60 },
      { alias: 'mover-stable', currentScore: 50, pastScore: 50 },
    ];

    for (const a of agents) {
      const hash = sha256(a.alias);
      agentRepo.insert(makeAgent(a.alias, { avg_score: a.currentScore }));
      insertSnapshot(snapshotRepo, hash, a.pastScore, NOW - 8 * DAY);
    }

    const { up, down } = trendService.getTopMovers(5);

    expect(up.length).toBeGreaterThanOrEqual(1);
    expect(up[0].alias).toBe('mover-up');
    expect(up[0].delta7d).toBe(30); // 80 - 50

    expect(down.length).toBeGreaterThanOrEqual(1);
    expect(down[0].alias).toBe('mover-down');
    expect(down[0].delta7d).toBe(-30); // 30 - 60
  });

  it('returns empty movers when no historical data', () => {
    agentRepo.insert(makeAgent('lonely'));

    const { up, down } = trendService.getTopMovers(5);

    expect(up).toHaveLength(0);
    expect(down).toHaveLength(0);
  });

  describe('movers float + methodology surface', () => {
    // Anchor NOW 10 days past the cutoff so `sevenDaysAgo = NOW - 7*DAY` sits
    // after the cutoff. That lets us craft two cases: a snapshot strictly
    // before the cutoff (pre-methodology) AND a snapshot in [CUTOFF, NOW-7d]
    // (post-methodology, still inside the 7d window).
    const SIM_NOW = METHODOLOGY_CHANGE_AT_UNIX + 10 * DAY;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SIM_NOW * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('movers skip candidates whose 7d comparator predates the cutoff', () => {
      // A mover ranked by a pre-cutoff comparator is noise: the number reflects
      // the scoring regime shift, not real movement. Hide them from the list
      // entirely rather than emitting `delta7d: null` in a delta-ordered list.
      const hash = sha256('pre-cutoff-mover');
      agentRepo.insert(makeAgent('pre-cutoff-mover', { avg_score: 82.35 }));
      insertSnapshot(snapshotRepo, hash, 70, METHODOLOGY_CHANGE_AT_UNIX - 6 * DAY);

      const { up } = trendService.getTopMovers(5);
      expect(up.find(x => x.alias === 'pre-cutoff-mover')).toBeUndefined();
    });

    it('movers surface post-cutoff candidates with deltaValid=true and clean float delta', () => {
      // Guard against the -17.439999999999998 regression and confirm that a
      // post-cutoff comparator appears in the list with proper surfaces.
      const hash = sha256('post-cutoff-mover');
      agentRepo.insert(makeAgent('post-cutoff-mover', { avg_score: 80.56 }));
      // Snapshot lives after the cutoff but before `sevenDaysAgo` (= cutoff+3d).
      insertSnapshot(snapshotRepo, hash, 98, METHODOLOGY_CHANGE_AT_UNIX + 1 * DAY);

      const { down } = trendService.getTopMovers(5);
      const m = down.find(x => x.alias === 'post-cutoff-mover');
      expect(m).toBeDefined();
      expect(m!.score).toBe(81);          // Math.round(80.56) = 81 (API contract)
      expect(m!.scoreFine).toBe(80.56);   // 2-decimal float for display
      expect(m!.delta7d).toBe(-17.4);     // rounded to 1dp, no -17.4399... noise
      expect(m!.deltaValid).toBe(true);
    });
  });

  // --- getNetworkTrends ---

  it('returns network trends with avgScoreDelta7d', () => {
    // Two agents with history
    const hash1 = sha256('trend-a');
    const hash2 = sha256('trend-b');
    agentRepo.insert(makeAgent('trend-a', { avg_score: 70 }));
    agentRepo.insert(makeAgent('trend-b', { avg_score: 60 }));

    insertSnapshot(snapshotRepo, hash1, 50, NOW - 8 * DAY);
    insertSnapshot(snapshotRepo, hash2, 50, NOW - 8 * DAY);

    const trends = trendService.getNetworkTrends();

    // Current avg: (70+60)/2 = 65, past avg: (50+50)/2 = 50
    expect(trends.avgScoreDelta7d).toBe(15);
    expect(trends.topMoversUp.length).toBeGreaterThanOrEqual(1);
  });

  // --- Snapshot repo delta methods ---

  it('findScoreAt returns closest score at or before timestamp', () => {
    const hash = sha256('score-at');
    agentRepo.insert(makeAgent('score-at'));

    insertSnapshot(snapshotRepo, hash, 40, NOW - 10 * DAY);
    insertSnapshot(snapshotRepo, hash, 50, NOW - 5 * DAY);
    insertSnapshot(snapshotRepo, hash, 60, NOW - 1 * DAY);

    // 7 days ago should return the 10-day-old snapshot (score 40)
    const score = snapshotRepo.findScoreAt(hash, NOW - 7 * DAY);
    expect(score).toBe(40);

    // 3 days ago should return the 5-day-old snapshot (score 50)
    const score2 = snapshotRepo.findScoreAt(hash, NOW - 3 * DAY);
    expect(score2).toBe(50);

    // Now should return latest (score 60)
    const score3 = snapshotRepo.findScoreAt(hash, NOW);
    expect(score3).toBe(60);
  });

  it('findScoreAt returns null when no snapshot before timestamp', () => {
    const hash = sha256('future');
    agentRepo.insert(makeAgent('future'));
    insertSnapshot(snapshotRepo, hash, 50, NOW - 1 * DAY);

    const score = snapshotRepo.findScoreAt(hash, NOW - 10 * DAY);
    expect(score).toBeNull();
  });

  it('findAvgScoreAt returns network average at timestamp', () => {
    const hash1 = sha256('avg-a');
    const hash2 = sha256('avg-b');
    agentRepo.insert(makeAgent('avg-a'));
    agentRepo.insert(makeAgent('avg-b'));

    insertSnapshot(snapshotRepo, hash1, 60, NOW - 8 * DAY);
    insertSnapshot(snapshotRepo, hash2, 40, NOW - 8 * DAY);

    const avg = snapshotRepo.findAvgScoreAt(NOW - 7 * DAY);
    expect(avg).toBe(50); // (60+40)/2
  });

  // --- deltaValid (methodology-change badge) ---
  // Context: the Option D multi-tier probe regime shipped 2026-04-16. The 7d
  // window includes pre- and post-methodology snapshots, so the raw numeric
  // delta would mix two scoring regimes and make stable hubs look like they
  // crashed (-18 on ACINQ was a scoring shift, not a degradation). `deltaValid`
  // is the signal the UI uses to render "—" or a methodology-change badge.

  it('deltaValid is true when no comparator exists (nothing to badge)', () => {
    const hash = sha256('fresh-agent');
    agentRepo.insert(makeAgent('fresh-agent', { avg_score: 70 }));
    // no snapshots at all

    const delta = trendService.computeDeltas(hash, 70);

    expect(delta.delta7d).toBeNull();
    expect(delta.deltaValid).toBe(true);
  });

  describe('deltaValid — methodology cutoff', () => {
    // Fake the clock to 8 days after the Option D cutoff so both pre- and
    // post-cutoff comparator snapshots fit inside the 7-day window. Without
    // fake time, real-time tests can't exercise the "after cutoff" branch
    // because NOW < cutoff + 7d until 2026-04-23.
    const CUTOFF = 1_776_240_000; // METHODOLOGY_CHANGE_AT_UNIX
    const SIM_NOW = CUTOFF + 8 * DAY; // 8 days after cutoff

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SIM_NOW * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('deltaValid=false nulls out delta7d so the UI renders "—" instead of a misleading number', () => {
      const hash = sha256('pre-cutoff-agent');
      agentRepo.insert(makeAgent('pre-cutoff-agent', { avg_score: 80 }));
      // 8d ago (relative to SIM_NOW) — just before the cutoff
      insertSnapshot(snapshotRepo, hash, 95, CUTOFF - DAY);

      const delta = trendService.computeDeltas(hash, 80);

      // The numeric delta is suppressed — a -15 badge here would wrongly
      // suggest the agent degraded, when the drop reflects the scoring
      // methodology change (Option D). Flag stays on the envelope.
      expect(delta.delta7d).toBeNull();
      expect(delta.deltaValid).toBe(false);
    });

    it('deltaValid is true when 7d comparator is at/after the cutoff', () => {
      const hash = sha256('post-cutoff-agent');
      agentRepo.insert(makeAgent('post-cutoff-agent', { avg_score: 80 }));
      // 7d-8d ago window; snapshot at cutoff itself counts as post-cutoff.
      insertSnapshot(snapshotRepo, hash, 78, CUTOFF + DAY);

      const delta = trendService.computeDeltas(hash, 80);

      expect(delta.delta7d).toBe(2);
      expect(delta.deltaValid).toBe(true);
    });

    it('computeDeltasBatch nulls delta7d for pre-cutoff agents and keeps it for post-cutoff', () => {
      const preHash = sha256('batch-pre');
      const postHash = sha256('batch-post');
      agentRepo.insert(makeAgent('batch-pre', { avg_score: 80 }));
      agentRepo.insert(makeAgent('batch-post', { avg_score: 80 }));

      insertSnapshot(snapshotRepo, preHash, 95, CUTOFF - DAY);
      insertSnapshot(snapshotRepo, postHash, 78, CUTOFF + DAY);

      const map = trendService.computeDeltasBatch([
        { hash: preHash, score: 80 },
        { hash: postHash, score: 80 },
      ]);

      // Pre-cutoff: flag off, numeric delta suppressed (would be -15).
      expect(map.get(preHash)!.deltaValid).toBe(false);
      expect(map.get(preHash)!.delta7d).toBeNull();
      // Post-cutoff: flag on, real numeric delta surfaces.
      expect(map.get(postHash)!.deltaValid).toBe(true);
      expect(map.get(postHash)!.delta7d).toBe(2);
    });
  });
});
