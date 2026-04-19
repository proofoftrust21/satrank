// Survival Score — predicts if a node will still be reachable in 7 days
// 3 signals: score trajectory, probe stability, gossip freshness
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { Agent, SurvivalResult, SurvivalPrediction } from '../types';
import { DAY, SEVEN_DAYS_SEC } from '../utils/constants';

export class SurvivalService {
  constructor(
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  compute(agentHashOrAgent: string | Agent): SurvivalResult {
    const agent = typeof agentHashOrAgent === 'string'
      ? this.agentRepo.findByHash(agentHashOrAgent)
      : agentHashOrAgent;

    if (!agent) {
      return { score: 0, prediction: 'likely_dead', signals: { scoreTrajectory: 'unknown', probeStability: 'unknown', gossipFreshness: 'unknown' } };
    }

    const now = Math.floor(Date.now() / 1000);
    let adjustment = 0;

    // Signal 1 — Posterior Trajectory (weight 40%)
    // Slope thresholds are on the p_success scale (0..1) and mirror the previous
    // points-per-day thresholds scaled by 1/100. -0.02/day ≈ -2pt/day on the old
    // composite — same clinical meaning for the survival classifier.
    const latestSnap = this.snapshotRepo.findLatestByAgent(agent.public_key_hash);
    const pSuccessNow = latestSnap?.p_success ?? null;
    const pSuccess7dAgo = this.snapshotRepo.findPSuccessAt(agent.public_key_hash, now - SEVEN_DAYS_SEC);
    let trajectoryLabel: string;

    if (pSuccessNow !== null && pSuccess7dAgo !== null) {
      const slope = (pSuccessNow - pSuccess7dAgo) / 7;
      if (slope < -0.02) { adjustment -= 40; trajectoryLabel = `declining (${slope.toFixed(3)}/day)`; }
      else if (slope < -0.01) { adjustment -= 20; trajectoryLabel = `weakening (${slope.toFixed(3)}/day)`; }
      else if (slope > 0.01) { trajectoryLabel = `improving (+${slope.toFixed(3)}/day)`; }
      else { trajectoryLabel = 'stable'; }
    } else {
      trajectoryLabel = 'insufficient data';
    }

    // Signal 2 — Probe Stability (weight 40%)
    const probeStats = this.probeRepo.computeUptime(agent.public_key_hash, SEVEN_DAYS_SEC);
    let probeLabel: string;

    if (probeStats !== null) {
      const totalProbes = this.probeRepo.countByTarget(agent.public_key_hash);
      if (probeStats === 0) { adjustment -= 40; probeLabel = `0% (0/${totalProbes})`; }
      else if (probeStats < 0.5) { adjustment -= 30; probeLabel = `${Math.round(probeStats * 100)}% (${totalProbes} probes)`; }
      else if (probeStats < 0.8) { adjustment -= 15; probeLabel = `${Math.round(probeStats * 100)}% (${totalProbes} probes)`; }
      else { probeLabel = `${Math.round(probeStats * 100)}% (${totalProbes} probes)`; }
    } else {
      probeLabel = 'no probe data';
    }

    // Signal 3 — Gossip Freshness (weight 20%)
    const daysSinceGossip = (now - agent.last_seen) / DAY;
    let gossipLabel: string;

    if (daysSinceGossip > 14) { adjustment -= 20; gossipLabel = `${Math.round(daysSinceGossip)}d ago (zombie)`; }
    else if (daysSinceGossip > 7) { adjustment -= 10; gossipLabel = `${Math.round(daysSinceGossip)}d ago (stale)`; }
    else if (daysSinceGossip > 1) { gossipLabel = `${Math.round(daysSinceGossip)}d ago`; }
    else { const hours = Math.round(daysSinceGossip * 24); gossipLabel = `${hours}h ago`; }

    const score = Math.max(0, Math.min(100, 100 + adjustment));
    const prediction: SurvivalPrediction = score > 70 ? 'stable' : score > 40 ? 'at_risk' : 'likely_dead';

    return {
      score,
      prediction,
      signals: {
        scoreTrajectory: trajectoryLabel,
        probeStability: probeLabel,
        gossipFreshness: gossipLabel,
      },
    };
  }
}
