// Fee Volatility Index — measures fee policy stability
import type { FeeSnapshotRepository } from '../repositories/feeSnapshotRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { FeeVolatility } from '../types';
import { SEVEN_DAYS_SEC } from '../utils/constants';

export class FeeVolatilityService {
  constructor(
    private feeSnapshotRepo: FeeSnapshotRepository,
    private agentRepo: AgentRepository,
  ) {}

  async compute(agentHash: string): Promise<FeeVolatility | null> {
    const agent = await this.agentRepo.findByHash(agentHash);
    if (!agent?.public_key) return null;

    const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SEC;
    const { changes, channels } = await this.feeSnapshotRepo.countFeeChanges(agent.public_key, cutoff);

    if (channels === 0) return null;

    // FVI: average fee changes per channel over 7 days, normalized 0-100
    // 0 changes = index 0; 1 change/channel/day = ~50; >2/channel/day = 100
    const changesPerChannelPerDay = changes / channels / 7;
    const index = Math.min(100, Math.round(changesPerChannelPerDay * 50));

    const interpretation = index < 10 ? 'stable' as const
      : index < 30 ? 'moderate' as const
      : 'volatile' as const;

    return { index, interpretation, changesLast7d: changes };
  }
}
