// Temporal delta computation — the differentiating product
// Computes score deltas, alerts, and network trends from snapshot history
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoreDelta, AgentAlert, TopMover, NetworkTrends, TrendDirection } from '../types';
import { DAY } from '../utils/constants';

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

    const score24h = this.snapshotRepo.findScoreAt(agentHash, now - DAY);
    const score7d = this.snapshotRepo.findScoreAt(agentHash, now - 7 * DAY);
    const score30d = this.snapshotRepo.findScoreAt(agentHash, now - 30 * DAY);

    const delta24h = score24h !== null ? currentScore - score24h : null;
    const delta7d = score7d !== null ? currentScore - score7d : null;
    const delta30d = score30d !== null ? currentScore - score30d : null;

    return {
      delta24h,
      delta7d,
      delta30d,
      trend: this.deriveTrend(delta7d),
    };
  }

  /** Batch version of computeDeltas — 3 SQL queries instead of 3N.
   *  Used by leaderboard and search to avoid N+1 query amplification. */
  computeDeltasBatch(agents: Array<{ hash: string; score: number }>): Map<string, ScoreDelta> {
    const now = Math.floor(Date.now() / 1000);
    const hashes = agents.map(a => a.hash);

    const scores24h = this.snapshotRepo.findScoresAtForAgents(hashes, now - DAY);
    const scores7d = this.snapshotRepo.findScoresAtForAgents(hashes, now - 7 * DAY);
    const scores30d = this.snapshotRepo.findScoresAtForAgents(hashes, now - 30 * DAY);

    const result = new Map<string, ScoreDelta>();
    for (const agent of agents) {
      const s24h = scores24h.get(agent.hash);
      const s7d = scores7d.get(agent.hash);
      const s30d = scores30d.get(agent.hash);

      const delta24h = s24h !== undefined ? agent.score - s24h : null;
      const delta7d = s7d !== undefined ? agent.score - s7d : null;
      const delta30d = s30d !== undefined ? agent.score - s30d : null;

      result.set(agent.hash, {
        delta24h,
        delta7d,
        delta30d,
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
    const pastScores = this.snapshotRepo.findScoresAtForAgents(hashes, sevenDaysAgo);

    const movers: { hash: string; alias: string | null; score: number; delta: number }[] = [];

    for (const agent of agents) {
      const pastScore = pastScores.get(agent.public_key_hash);
      if (pastScore === undefined) continue; // No historical data
      const delta = agent.avg_score - pastScore;
      if (delta === 0) continue;
      movers.push({
        hash: agent.public_key_hash,
        alias: agent.alias,
        score: agent.avg_score,
        delta,
      });
    }

    movers.sort((a, b) => b.delta - a.delta);

    const up: TopMover[] = movers
      .filter(m => m.delta > 0)
      .slice(0, limit)
      .map(m => ({
        publicKeyHash: m.hash,
        alias: m.alias,
        score: m.score,
        delta7d: m.delta,
        trend: 'rising' as TrendDirection,
      }));

    const down: TopMover[] = movers
      .filter(m => m.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, limit)
      .map(m => ({
        publicKeyHash: m.hash,
        alias: m.alias,
        score: m.score,
        delta7d: m.delta,
        trend: 'falling' as TrendDirection,
      }));

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
