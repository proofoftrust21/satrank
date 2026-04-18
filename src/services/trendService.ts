// Temporal delta computation — the differentiating product
// Computes score deltas, alerts, and network trends from snapshot history
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoreDelta, AgentAlert, TopMover, NetworkTrends, TrendDirection } from '../types';
import { DAY } from '../utils/constants';
import { METHODOLOGY_CHANGE_AT_UNIX } from '../config/scoring';

/** Threshold for score drop alert (points) */
const ALERT_DROP_THRESHOLD = 10;
/** Threshold for score surge alert (points) */
const ALERT_SURGE_THRESHOLD = 15;
/** Days since last_seen to consider an agent inactive */
const INACTIVE_DAYS = 60;
/** Days since first_seen to consider an agent "new" */
const NEW_AGENT_DAYS = 7;

export class TrendService {
  constructor(
    private agentRepo: AgentRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  computeDeltas(agentHash: string, currentScore: number): ScoreDelta {
    const now = Math.floor(Date.now() / 1000);

    const snap24h = this.snapshotRepo.findSnapshotAt(agentHash, now - DAY);
    const snap7d = this.snapshotRepo.findSnapshotAt(agentHash, now - 7 * DAY);
    const snap30d = this.snapshotRepo.findSnapshotAt(agentHash, now - 30 * DAY);

    // 7d comparator drives the leaderboard badge — invalid when it predates Option D.
    // When invalid, the numeric delta would mislead (e.g. -18 on ACINQ reflects the
    // scoring shift, not degradation), so we null out delta7d entirely. The front-end
    // renders "—" for null deltas; `deltaValid` stays on the envelope for diagnostics.
    const deltaValid = snap7d === null ? true : snap7d.computed_at >= METHODOLOGY_CHANGE_AT_UNIX;

    const delta24h = snap24h !== null ? currentScore - snap24h.score : null;
    const delta7d = snap7d !== null && deltaValid ? currentScore - snap7d.score : null;
    const delta30d = snap30d !== null ? currentScore - snap30d.score : null;

    return {
      delta24h,
      delta7d,
      delta30d,
      deltaValid,
      trend: this.deriveTrend(delta7d),
    };
  }

  /** Batch version of computeDeltas — 3 SQL queries instead of 3N.
   *  Used by leaderboard and search to avoid N+1 query amplification. */
  computeDeltasBatch(agents: Array<{ hash: string; score: number }>): Map<string, ScoreDelta> {
    const now = Math.floor(Date.now() / 1000);
    const hashes = agents.map(a => a.hash);

    const snaps24h = this.snapshotRepo.findSnapshotsAtForAgents(hashes, now - DAY);
    const snaps7d = this.snapshotRepo.findSnapshotsAtForAgents(hashes, now - 7 * DAY);
    const snaps30d = this.snapshotRepo.findSnapshotsAtForAgents(hashes, now - 30 * DAY);

    const result = new Map<string, ScoreDelta>();
    for (const agent of agents) {
      const s24h = snaps24h.get(agent.hash);
      const s7d = snaps7d.get(agent.hash);
      const s30d = snaps30d.get(agent.hash);

      const deltaValid = s7d === undefined ? true : s7d.computed_at >= METHODOLOGY_CHANGE_AT_UNIX;
      const delta24h = s24h !== undefined ? agent.score - s24h.score : null;
      const delta7d = s7d !== undefined && deltaValid ? agent.score - s7d.score : null;
      const delta30d = s30d !== undefined ? agent.score - s30d.score : null;

      result.set(agent.hash, {
        delta24h,
        delta7d,
        delta30d,
        deltaValid,
        trend: this.deriveTrend(delta7d),
      });
    }
    return result;
  }

  computeAlerts(agentHash: string, currentScore: number, delta: ScoreDelta): AgentAlert[] {
    const alerts: AgentAlert[] = [];
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent) return alerts;

    const now = Math.floor(Date.now() / 1000);

    // Score drop alert
    if (delta.delta7d !== null && delta.delta7d <= -ALERT_DROP_THRESHOLD) {
      const severity = delta.delta7d <= -20 ? 'critical' : 'warning';
      alerts.push({
        type: 'score_drop',
        message: `Score dropped ${Math.abs(delta.delta7d)} points in 7 days (${currentScore + Math.abs(delta.delta7d)} → ${currentScore})`,
        severity,
      });
    }

    // Score surge alert
    if (delta.delta7d !== null && delta.delta7d >= ALERT_SURGE_THRESHOLD) {
      alerts.push({
        type: 'score_surge',
        message: `Score surged +${delta.delta7d} points in 7 days (${currentScore - delta.delta7d} → ${currentScore})`,
        severity: 'info',
      });
    }

    // New agent
    const ageDays = (now - agent.first_seen) / DAY;
    if (ageDays <= NEW_AGENT_DAYS) {
      alerts.push({
        type: 'new_agent',
        message: `New agent — first seen ${Math.round(ageDays)} day${Math.round(ageDays) !== 1 ? 's' : ''} ago`,
        severity: 'info',
      });
    }

    // Inactive
    const inactiveDays = (now - agent.last_seen) / DAY;
    if (inactiveDays >= INACTIVE_DAYS) {
      alerts.push({
        type: 'inactive',
        message: `Inactive — last seen ${Math.round(inactiveDays)} days ago`,
        severity: 'warning',
      });
    }

    return alerts;
  }

  getTopMovers(limit: number = 5): { up: TopMover[]; down: TopMover[] } {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * DAY;

    // Get all agents with current scores
    const agents = this.agentRepo.findTopByScore(200, 0);
    if (agents.length === 0) return { up: [], down: [] };

    const hashes = agents.map(a => a.public_key_hash);
    // Full snapshots (not bare scores) so we can read computed_at and decide
    // whether the comparator predates the Option D methodology change.
    const pastSnaps = this.snapshotRepo.findSnapshotsAtForAgents(hashes, sevenDaysAgo);

    const movers: {
      hash: string;
      alias: string | null;
      scoreFine: number;
      delta: number;
      deltaValid: boolean;
    }[] = [];

    for (const agent of agents) {
      const snap = pastSnaps.get(agent.public_key_hash);
      if (snap === undefined) continue; // No historical data
      // Skip movers whose comparator predates Option D. Ranking by a delta that
      // reflects a methodology shift (not real movement) is exactly the noise
      // we're trying to suppress; hiding them from the list entirely is cleaner
      // than surfacing `delta7d: null` in a list that's defined by delta order.
      // Auto-heals 7 days after the cutoff when all comparators roll forward.
      if (snap.computed_at < METHODOLOGY_CHANGE_AT_UNIX) continue;
      const scoreFine = Math.round(agent.avg_score * 100) / 100;
      // Round delta to 1 decimal — float subtraction emits noise like
      // -17.439999999999998 which leaks into the JSON surface otherwise.
      const delta = Math.round((scoreFine - snap.score) * 10) / 10;
      if (delta === 0) continue;
      movers.push({
        hash: agent.public_key_hash,
        alias: agent.alias,
        scoreFine,
        delta,
        deltaValid: true,
      });
    }

    movers.sort((a, b) => b.delta - a.delta);

    const toTopMover = (m: typeof movers[number], trend: TrendDirection): TopMover => ({
      publicKeyHash: m.hash,
      alias: m.alias,
      score: Math.round(m.scoreFine),
      scoreFine: m.scoreFine,
      delta7d: m.delta,
      deltaValid: m.deltaValid,
      trend,
    });

    const up: TopMover[] = movers
      .filter(m => m.delta > 0)
      .slice(0, limit)
      .map(m => toTopMover(m, 'rising'));

    const down: TopMover[] = movers
      .filter(m => m.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, limit)
      .map(m => toTopMover(m, 'falling'));

    return { up, down };
  }

  getNetworkTrends(): NetworkTrends {
    const now = Math.floor(Date.now() / 1000);
    const currentAvg = this.agentRepo.avgScore();
    const pastAvg = this.snapshotRepo.findAvgScoreAt(now - 7 * DAY);
    const avgScoreDelta7d = pastAvg !== null ? Math.round((currentAvg - pastAvg) * 10) / 10 : 0;

    const { up, down } = this.getTopMovers(5);

    return {
      avgScoreDelta7d,
      topMoversUp: up,
      topMoversDown: down,
    };
  }

  private deriveTrend(delta7d: number | null): TrendDirection {
    if (delta7d === null || (delta7d >= -2 && delta7d <= 2)) return 'stable';
    return delta7d > 0 ? 'rising' : 'falling';
  }
}
