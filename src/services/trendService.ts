// Temporal delta computation — the differentiating product
// Computes p_success deltas, alerts, and network trends from bayesian snapshot history.
// Deltas are on the posterior p_success scale (0..1), calibrated against empirical
// distribution — see scripts/analyzeDeltaDistribution.ts for threshold derivation.
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoreDelta, AgentAlert, TopMover, NetworkTrends, TrendDirection } from '../types';
import { DAY } from '../utils/constants';

/** Threshold for p_success drop alert (absolute, 0..1 scale). Calibrated at p7 of negative-delta distribution. */
const ALERT_DROP_THRESHOLD = 0.10;
/** Threshold for p_success surge alert (absolute, 0..1 scale). Calibrated at p93 of positive-delta distribution. */
const ALERT_SURGE_THRESHOLD = 0.15;
/** Days since last_seen to consider an agent inactive */
const INACTIVE_DAYS = 60;
/** Days since first_seen to consider an agent "new" */
const NEW_AGENT_DAYS = 7;
/** Stable band on p_success trend (±0.02 → no change). */
const STABLE_BAND = 0.02;

export class TrendService {
  constructor(
    private agentRepo: AgentRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  computeDeltas(agentHash: string, currentPSuccess: number): ScoreDelta {
    const now = Math.floor(Date.now() / 1000);

    const snap24h = this.snapshotRepo.findSnapshotAt(agentHash, now - DAY);
    const snap7d = this.snapshotRepo.findSnapshotAt(agentHash, now - 7 * DAY);
    const snap30d = this.snapshotRepo.findSnapshotAt(agentHash, now - 30 * DAY);

    const delta24h = snap24h !== null ? round3(currentPSuccess - snap24h.p_success) : null;
    const delta7d = snap7d !== null ? round3(currentPSuccess - snap7d.p_success) : null;
    const delta30d = snap30d !== null ? round3(currentPSuccess - snap30d.p_success) : null;

    return {
      delta24h,
      delta7d,
      delta30d,
      deltaValid: true,
      trend: this.deriveTrend(delta7d),
    };
  }

  /** Batch version of computeDeltas — 3 SQL queries instead of 3N.
   *  Used by leaderboard and search to avoid N+1 query amplification. */
  computeDeltasBatch(agents: Array<{ hash: string; pSuccess: number }>): Map<string, ScoreDelta> {
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

      const delta24h = s24h !== undefined ? round3(agent.pSuccess - s24h.p_success) : null;
      const delta7d = s7d !== undefined ? round3(agent.pSuccess - s7d.p_success) : null;
      const delta30d = s30d !== undefined ? round3(agent.pSuccess - s30d.p_success) : null;

      result.set(agent.hash, {
        delta24h,
        delta7d,
        delta30d,
        deltaValid: true,
        trend: this.deriveTrend(delta7d),
      });
    }
    return result;
  }

  computeAlerts(agentHash: string, currentPSuccess: number, delta: ScoreDelta): AgentAlert[] {
    const alerts: AgentAlert[] = [];
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent) return alerts;

    const now = Math.floor(Date.now() / 1000);

    // p_success drop alert
    if (delta.delta7d !== null && delta.delta7d <= -ALERT_DROP_THRESHOLD) {
      const severity = delta.delta7d <= -0.20 ? 'critical' : 'warning';
      const priorPSuccess = round3(currentPSuccess - delta.delta7d);
      alerts.push({
        type: 'score_drop',
        message: `p_success dropped ${formatPSuccess(Math.abs(delta.delta7d))} in 7 days (${formatPSuccess(priorPSuccess)} → ${formatPSuccess(currentPSuccess)})`,
        severity,
      });
    }

    // p_success surge alert
    if (delta.delta7d !== null && delta.delta7d >= ALERT_SURGE_THRESHOLD) {
      const priorPSuccess = round3(currentPSuccess - delta.delta7d);
      alerts.push({
        type: 'score_surge',
        message: `p_success surged +${formatPSuccess(delta.delta7d)} in 7 days (${formatPSuccess(priorPSuccess)} → ${formatPSuccess(currentPSuccess)})`,
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

    // We still seed the candidate set from agents.avg_score — it's the cheapest
    // way to restrict to the top 200 without joining the entire snapshot table.
    // The delta itself comes from the bayesian p_success comparator below.
    const agents = this.agentRepo.findTopByScore(200, 0);
    if (agents.length === 0) return { up: [], down: [] };

    const hashes = agents.map(a => a.public_key_hash);
    const pastSnaps = this.snapshotRepo.findSnapshotsAtForAgents(hashes, sevenDaysAgo);
    const currentSnaps = this.snapshotRepo.findLatestByAgents(hashes);

    const movers: {
      hash: string;
      alias: string | null;
      pSuccess: number;
      delta: number;
    }[] = [];

    for (const agent of agents) {
      const past = pastSnaps.get(agent.public_key_hash);
      const current = currentSnaps.get(agent.public_key_hash);
      if (past === undefined || current === undefined) continue;
      const delta = round3(current.p_success - past.p_success);
      if (delta === 0) continue;
      movers.push({
        hash: agent.public_key_hash,
        alias: agent.alias,
        pSuccess: current.p_success,
        delta,
      });
    }

    movers.sort((a, b) => b.delta - a.delta);

    const toTopMover = (m: typeof movers[number], trend: TrendDirection): TopMover => ({
      publicKeyHash: m.hash,
      alias: m.alias,
      pSuccess: m.pSuccess,
      delta7d: m.delta,
      deltaValid: true,
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
    const currentAvg = this.snapshotRepo.findAvgPSuccessAt(now);
    const pastAvg = this.snapshotRepo.findAvgPSuccessAt(now - 7 * DAY);
    const avgPSuccessDelta7d = currentAvg !== null && pastAvg !== null
      ? round3(currentAvg - pastAvg)
      : 0;

    const { up, down } = this.getTopMovers(5);

    return {
      avgPSuccessDelta7d,
      topMoversUp: up,
      topMoversDown: down,
    };
  }

  private deriveTrend(delta7d: number | null): TrendDirection {
    if (delta7d === null || (delta7d >= -STABLE_BAND && delta7d <= STABLE_BAND)) return 'stable';
    return delta7d > 0 ? 'rising' : 'falling';
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatPSuccess(n: number): string {
  return n.toFixed(3);
}
