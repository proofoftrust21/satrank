// Channel snapshot storage for net channel flow and drain rate signals (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface ChannelSnapshot {
  agent_hash: string;
  channel_count: number;
  capacity_sats: number;
  snapshot_at: number;
}

export class ChannelSnapshotRepository {
  constructor(private db: Queryable) {}

  async insert(snapshot: ChannelSnapshot): Promise<void> {
    await this.db.query(
      'INSERT INTO channel_snapshots (agent_hash, channel_count, capacity_sats, snapshot_at) VALUES ($1, $2, $3, $4)',
      [snapshot.agent_hash, snapshot.channel_count, snapshot.capacity_sats, snapshot.snapshot_at],
    );
  }

  /** Caller is responsible for wrapping in withTransaction() if atomicity across inserts is needed. */
  async insertBatch(snapshots: ChannelSnapshot[]): Promise<void> {
    for (const s of snapshots) {
      await this.db.query(
        'INSERT INTO channel_snapshots (agent_hash, channel_count, capacity_sats, snapshot_at) VALUES ($1, $2, $3, $4)',
        [s.agent_hash, s.channel_count, s.capacity_sats, s.snapshot_at],
      );
    }
  }

  async findLatest(agentHash: string): Promise<ChannelSnapshot | undefined> {
    const { rows } = await this.db.query<ChannelSnapshot>(
      'SELECT * FROM channel_snapshots WHERE agent_hash = $1 ORDER BY snapshot_at DESC LIMIT 1',
      [agentHash],
    );
    return rows[0];
  }

  async findAt(agentHash: string, beforeTimestamp: number): Promise<ChannelSnapshot | undefined> {
    const { rows } = await this.db.query<ChannelSnapshot>(
      'SELECT * FROM channel_snapshots WHERE agent_hash = $1 AND snapshot_at <= $2 ORDER BY snapshot_at DESC LIMIT 1',
      [agentHash, beforeTimestamp],
    );
    return rows[0];
  }

  async purgeOlderThan(maxAgeSec: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const result = await this.db.query('DELETE FROM channel_snapshots WHERE snapshot_at < $1', [cutoff]);
    return result.rowCount ?? 0;
  }
}
