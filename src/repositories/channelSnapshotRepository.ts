// Channel snapshot storage for net channel flow and drain rate signals
import type Database from 'better-sqlite3';

export interface ChannelSnapshot {
  agent_hash: string;
  channel_count: number;
  capacity_sats: number;
  snapshot_at: number;
}

export class ChannelSnapshotRepository {
  constructor(private db: Database.Database) {}

  insert(snapshot: ChannelSnapshot): void {
    this.db.prepare(
      'INSERT INTO channel_snapshots (agent_hash, channel_count, capacity_sats, snapshot_at) VALUES (?, ?, ?, ?)'
    ).run(snapshot.agent_hash, snapshot.channel_count, snapshot.capacity_sats, snapshot.snapshot_at);
  }

  insertBatch(snapshots: ChannelSnapshot[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO channel_snapshots (agent_hash, channel_count, capacity_sats, snapshot_at) VALUES (?, ?, ?, ?)'
    );
    const tx = this.db.transaction((items: ChannelSnapshot[]) => {
      for (const s of items) {
        stmt.run(s.agent_hash, s.channel_count, s.capacity_sats, s.snapshot_at);
      }
    });
    tx(snapshots);
  }

  findLatest(agentHash: string): ChannelSnapshot | undefined {
    return this.db.prepare(
      'SELECT * FROM channel_snapshots WHERE agent_hash = ? ORDER BY snapshot_at DESC LIMIT 1'
    ).get(agentHash) as ChannelSnapshot | undefined;
  }

  findAt(agentHash: string, beforeTimestamp: number): ChannelSnapshot | undefined {
    return this.db.prepare(
      'SELECT * FROM channel_snapshots WHERE agent_hash = ? AND snapshot_at <= ? ORDER BY snapshot_at DESC LIMIT 1'
    ).get(agentHash, beforeTimestamp) as ChannelSnapshot | undefined;
  }

  purgeOlderThan(maxAgeSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    return this.db.prepare('DELETE FROM channel_snapshots WHERE snapshot_at < ?').run(cutoff).changes;
  }
}
