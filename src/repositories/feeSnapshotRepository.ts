// Fee snapshot storage for fee volatility index (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface FeeSnapshot {
  channel_id: string;
  node1_pub: string;
  node2_pub: string;
  fee_base_msat: number;
  fee_rate_ppm: number;
  snapshot_at: number;
}

export class FeeSnapshotRepository {
  constructor(private db: Queryable) {}

  /** Caller is responsible for wrapping in withTransaction() if atomicity across inserts is needed. */
  async insertBatch(snapshots: FeeSnapshot[]): Promise<void> {
    for (const s of snapshots) {
      await this.db.query(
        'INSERT INTO fee_snapshots (channel_id, node1_pub, node2_pub, fee_base_msat, fee_rate_ppm, snapshot_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [s.channel_id, s.node1_pub, s.node2_pub, s.fee_base_msat, s.fee_rate_ppm, s.snapshot_at],
      );
    }
  }

  /** Count distinct fee changes for a node's channels over a time window */
  async countFeeChanges(nodePub: string, afterTimestamp: number): Promise<{ changes: number; channels: number }> {
    // A "change" = two consecutive snapshots for the same channel with different fee values
    const { rows: changesRows } = await this.db.query<{ changes: string }>(
      `
      SELECT COUNT(*)::text AS changes FROM (
        SELECT f1.channel_id
        FROM fee_snapshots f1
        INNER JOIN fee_snapshots f2 ON f1.channel_id = f2.channel_id
          AND f1.node1_pub = f2.node1_pub
          AND f2.snapshot_at = (
            SELECT MAX(snapshot_at) FROM fee_snapshots
            WHERE channel_id = f1.channel_id AND node1_pub = f1.node1_pub AND snapshot_at < f1.snapshot_at
          )
        WHERE f1.node1_pub = $1 AND f1.snapshot_at >= $2
          AND (f1.fee_base_msat != f2.fee_base_msat OR f1.fee_rate_ppm != f2.fee_rate_ppm)
      ) sub
      `,
      [nodePub, afterTimestamp],
    );

    const { rows: channelRows } = await this.db.query<{ channels: string }>(
      'SELECT COUNT(DISTINCT channel_id)::text AS channels FROM fee_snapshots WHERE node1_pub = $1 AND snapshot_at >= $2',
      [nodePub, afterTimestamp],
    );

    return {
      changes: Number(changesRows[0]?.changes ?? 0),
      channels: Number(channelRows[0]?.channels ?? 0),
    };
  }

  /** Caller is responsible for wrapping in withTransaction() if atomicity is needed. */
  async insertBatchDeduped(snapshots: FeeSnapshot[]): Promise<number> {
    let inserted = 0;
    for (const s of snapshots) {
      const { rows } = await this.db.query<{ fee_base_msat: number; fee_rate_ppm: number }>(
        'SELECT fee_base_msat, fee_rate_ppm FROM fee_snapshots WHERE channel_id = $1 AND node1_pub = $2 ORDER BY snapshot_at DESC LIMIT 1',
        [s.channel_id, s.node1_pub],
      );
      const latest = rows[0];
      if (!latest || latest.fee_base_msat !== s.fee_base_msat || latest.fee_rate_ppm !== s.fee_rate_ppm) {
        await this.db.query(
          'INSERT INTO fee_snapshots (channel_id, node1_pub, node2_pub, fee_base_msat, fee_rate_ppm, snapshot_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [s.channel_id, s.node1_pub, s.node2_pub, s.fee_base_msat, s.fee_rate_ppm, s.snapshot_at],
        );
        inserted++;
      }
    }
    return inserted;
  }

  async purgeOlderThan(maxAgeSec: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const result = await this.db.query('DELETE FROM fee_snapshots WHERE snapshot_at < $1', [cutoff]);
    return result.rowCount ?? 0;
  }
}
