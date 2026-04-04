// Shared flag computation — used by verdictService and v2Controller (M2)
import type { Agent, VerdictFlag } from '../types';
import { DAY } from './constants';

export const HIGH_DEMAND_THRESHOLD = 50; // M5

interface DeltaInput {
  delta7d: number | null;
}

/** Base flags derived from agent data + trend delta (no DB queries) */
export function computeBaseFlags(agent: Agent, delta: DeltaInput, now: number): VerdictFlag[] {
  const ageDays = (now - agent.first_seen) / DAY;
  const flags: VerdictFlag[] = [];

  if (ageDays < 30) flags.push('new_agent');
  if (agent.total_transactions < 10) flags.push('low_volume');
  if (delta.delta7d !== null && delta.delta7d < -10) flags.push('rapid_decline');
  if (delta.delta7d !== null && delta.delta7d > 15) flags.push('rapid_rise');
  if (agent.negative_ratings > agent.positive_ratings) flags.push('negative_reputation');
  if (agent.query_count > HIGH_DEMAND_THRESHOLD) flags.push('high_demand');
  if (agent.lnplus_rank === 0 && agent.positive_ratings === 0) flags.push('no_reputation_data');

  return flags;
}
