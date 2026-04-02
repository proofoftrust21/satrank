// Risk profiling engine — classifies agents into behavioral profiles
// Complement to the verdict, not a replacement
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

const PROFILES: ProfileDefinition[] = [
  {
    name: 'suspicious_rapid_rise',
    riskLevel: 'high',
    match: (_, ageDays, delta) =>
      delta.delta7d !== null && delta.delta7d > 20 && ageDays < 60,
    describe: (_, ageDays, delta) =>
      `Active for ${Math.round(ageDays)} days with rapid score increase (+${delta.delta7d} in 7d). Possible gaming — monitor closely.`,
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
      delta.delta7d !== null && delta.delta7d < -10 && delta.trend === 'falling',
    describe: (_, _ageDays, delta) =>
      `Score declining (${delta.delta7d} in 7d, trend: falling). Potential reliability or trust issue developing.`,
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
      delta.delta7d !== null && delta.delta7d > 10 && ageDays < 180,
    describe: (_, ageDays, delta) =>
      `Growing node (${Math.round(ageDays)}d old, +${delta.delta7d} in 7d). Positive trajectory but limited history.`,
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

    return {
      name: 'default',
      riskLevel: 'unknown',
      description: `Agent does not match any specific risk profile. Score: ${agent.avg_score}, active for ${Math.round(ageDays)} days.`,
    };
  }
}
