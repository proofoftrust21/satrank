// Risk profiling engine — classifies agents into behavioral profiles.
// Complement to the verdict, not a replacement.
//
// Phase 3 C8: delta-dependent profiles (suspicious_rapid_rise, declining_node,
// growing_node) use thresholds calibrated on the empirical p_success delta
// distribution (see scripts/analyzeDeltaDistribution.ts). Composite-dependent
// profiles (established_hub, small_reliable) still read `agent.avg_score` —
// that column is retained as an internal signal for now; the publicly exposed
// canonical score is the Bayesian posterior.
import type { Agent } from '../types';
import type { RiskProfile, RiskProfileName, RiskLevel } from '../types';
import type { ScoreDelta } from '../types';
import { DAY } from '../utils/constants';

interface ProfileDefinition {
  name: RiskProfileName;
  riskLevel: RiskLevel;
  match: (agent: Agent, ageDays: number, delta: ScoreDelta, components: { regularity: number }) => boolean;
  describe: (agent: Agent, ageDays: number, delta: ScoreDelta) => string;
}

// Calibration (see scripts/analyzeDeltaDistribution.ts):
//   positive p97 ≈ +0.26 → suspicious_rapid_rise (target ~1.5% population)
//   negative p93 ≈ -0.13 → declining_node (target ~3.3% population)
//   positive p85 ≈ +0.09 → growing_node (target ~7.9% population)
const DELTA_RAPID_RISE = 0.26;
const DELTA_DECLINING = -0.13;
const DELTA_GROWING = 0.09;

const PROFILES: ProfileDefinition[] = [
  {
    name: 'suspicious_rapid_rise',
    riskLevel: 'high',
    match: (_, ageDays, delta) =>
      delta.delta7d !== null && delta.delta7d > DELTA_RAPID_RISE && ageDays < 60,
    describe: (_, ageDays, delta) =>
      `Active for ${Math.round(ageDays)} days with rapid posterior increase (+${delta.delta7d!.toFixed(3)} in 7d). Possible gaming — monitor closely.`,
  },
  {
    name: 'new_unproven',
    riskLevel: 'high',
    match: (agent, ageDays) =>
      ageDays < 30 && agent.total_transactions < 5,
    describe: (_, ageDays) =>
      `New agent (${Math.round(ageDays)}d), very few transactions. Insufficient history for reliable assessment.`,
  },
  {
    name: 'declining_node',
    riskLevel: 'high',
    match: (_, _ageDays, delta) =>
      delta.delta7d !== null && delta.delta7d < DELTA_DECLINING && delta.trend === 'falling',
    describe: (_, _ageDays, delta) =>
      `Posterior declining (${delta.delta7d!.toFixed(3)} in 7d, trend: falling). Potential reliability or trust issue developing.`,
  },
  {
    name: 'established_hub',
    riskLevel: 'low',
    match: (agent, ageDays) =>
      agent.avg_score >= 70 && ageDays > 365 && agent.total_transactions > 200,
    describe: (_, ageDays) =>
      `Established hub, active for ${Math.round(ageDays / 365)}+ years with high transaction volume. Strong track record.`,
  },
  {
    name: 'small_reliable',
    riskLevel: 'low',
    match: (agent, ageDays, _, components) =>
      agent.avg_score >= 40 && agent.avg_score < 70 && ageDays > 365 && components.regularity > 60,
    describe: (agent) =>
      `Smaller node (score ${agent.avg_score}) but reliable over a long period with consistent activity.`,
  },
  {
    name: 'growing_node',
    riskLevel: 'medium',
    match: (_, ageDays, delta) =>
      delta.delta7d !== null && delta.delta7d > DELTA_GROWING && ageDays < 180,
    describe: (_, ageDays, delta) =>
      `Growing node (${Math.round(ageDays)}d old, +${delta.delta7d!.toFixed(3)} in 7d). Positive trajectory but limited history.`,
  },
];

export class RiskService {
  classifyAgent(
    agent: Agent,
    delta: ScoreDelta,
    components: { regularity: number },
  ): RiskProfile {
    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - agent.first_seen) / DAY;

    for (const profile of PROFILES) {
      if (profile.match(agent, ageDays, delta, components)) {
        return {
          name: profile.name,
          riskLevel: profile.riskLevel,
          description: profile.describe(agent, ageDays, delta),
        };
      }
    }

    const riskLevel: RiskLevel = agent.avg_score >= 40 ? 'medium' : 'unknown';
    return {
      name: 'unrated',
      riskLevel,
      description: `Agent does not match any specific risk profile. Score: ${agent.avg_score}, active for ${Math.round(ageDays)} days.`,
    };
  }
}
