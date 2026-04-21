// Channel flow and drain rate — derived from channel_snapshots
import type { ChannelSnapshotRepository } from '../repositories/channelSnapshotRepository';
import type { ChannelFlow, CapacityHealth, VerdictFlag } from '../types';
import { DAY, SEVEN_DAYS_SEC } from '../utils/constants';

export class ChannelFlowService {
  constructor(private channelSnapshotRepo: ChannelSnapshotRepository) {}

  async computeFlow(agentHash: string): Promise<ChannelFlow | null> {
    const now = Math.floor(Date.now() / 1000);
    const latest = await this.channelSnapshotRepo.findLatest(agentHash);
    const weekAgo = await this.channelSnapshotRepo.findAt(agentHash, now - SEVEN_DAYS_SEC);

    if (!latest || !weekAgo) return null;

    const net7d = latest.channel_count - weekAgo.channel_count;
    const capacityDelta7d = latest.capacity_sats - weekAgo.capacity_sats;
    const trend = net7d > 2 ? 'growing' as const : net7d < -2 ? 'declining' as const : 'stable' as const;

    return { net7d, capacityDelta7d, trend };
  }

  async computeCapacityHealth(agentHash: string): Promise<CapacityHealth | null> {
    const now = Math.floor(Date.now() / 1000);
    const latest = await this.channelSnapshotRepo.findLatest(agentHash);
    if (!latest || latest.capacity_sats === 0) return null;

    const dayAgo = await this.channelSnapshotRepo.findAt(agentHash, now - DAY);
    const weekAgo = await this.channelSnapshotRepo.findAt(agentHash, now - SEVEN_DAYS_SEC);

    const drainRate24h = dayAgo && dayAgo.capacity_sats > 0
      ? (latest.capacity_sats - dayAgo.capacity_sats) / dayAgo.capacity_sats
      : null;
    const drainRate7d = weekAgo && weekAgo.capacity_sats > 0
      ? (latest.capacity_sats - weekAgo.capacity_sats) / weekAgo.capacity_sats
      : null;

    const primaryRate = drainRate7d ?? drainRate24h;
    const trend = primaryRate === null ? 'stable' as const
      : primaryRate > 0.05 ? 'growing' as const
      : primaryRate < -0.05 ? 'declining' as const
      : 'stable' as const;

    return {
      drainRate24h: drainRate24h !== null ? Math.round(drainRate24h * 1000) / 1000 : null,
      drainRate7d: drainRate7d !== null ? Math.round(drainRate7d * 1000) / 1000 : null,
      trend,
    };
  }

  /** Returns drain flags if capacity dropped significantly */
  async computeDrainFlags(agentHash: string): Promise<VerdictFlag[]> {
    const health = await this.computeCapacityHealth(agentHash);
    if (!health || health.drainRate24h === null) return [];
    const flags: VerdictFlag[] = [];
    if (health.drainRate24h <= -0.5) flags.push('severe_capacity_drain');
    else if (health.drainRate24h <= -0.3) flags.push('capacity_drain');
    return flags;
  }
}
