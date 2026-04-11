// Fee snapshot storage for fee volatility index
import type Database from 'better-sqlite3';

export interface FeeSnapshot {
  channel_id: string;
  node1_pub: string;
  node2_pub: string;
  fee_base_msat: number;
  fee_rate_ppm: number;
  snapshot_at: number;
}

export class FeeSnapshotRepository {
  constructor(private db: Database.Database) {}

  insertBatch(snapshots: FeeSnapshot[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO fee_snapshots (channel_id, node1_pub, node2_pub, fee_base_msat, fee_rate_ppm, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const tx = this.db.transaction((items: FeeSnapshot[]) => {
      for (const s of items) {
        stmt.run(s.channel_id, s.node1_pub, s.node2_pub, s.fee_base_msat, s.fee_rate_ppm, s.snapshot_at);
      }
    });
    tx(snapshots);
  }

  /** Count distinct fee changes for a node's channels over a time window */
  countFeeChanges(nodePub: string, afterTimestamp: number): { changes: number; channels: number } {
    // A "change" = two consecutive snapshots for the same channel with different fee values
    const row = this.db.prepare(`
      SELECT COUNT(*) as changes FROM (
        SELECT f1.channel_id
        FROM fee_snapshots f1
        INNER JOIN fee_snapshots f2 ON f1.channel_id = f2.channel_id
          AND f1.node1_pub = f2.node1_pub
          AND f2.snapshot_at = (
            SELECT MAX(snapshot_at) FROM fee_snapshots
            WHERE channel_id = f1.channel_id AND node1_pub = f1.node1_pub AND snapshot_at < f1.snapshot_at
          )
        WHERE f1.node1_pub = ? AND f1.snapshot_at >= ?
          AND (f1.fee_base_msat != f2.fee_base_msat OR f1.fee_rate_ppm != f2.fee_rate_ppm)
      )
    `).get(nodePub, afterTimestamp) as { changes: number };

    const chRow = this.db.prepare(
      'SELECT COUNT(DISTINCT channel_id) as channels FROM fee_snapshots WHERE node1_pub = ? AND snapshot_at >= ?'
    ).get(nodePub, afterTimestamp) as { channels: number };

    return { changes: row.changes, channels: chRow.channels };
  }

  insertBatchDeduped(snapshots: FeeSnapshot[]): number {
    const check = this.db.prepare(
      'SELECT fee_base_msat, fee_rate_ppm FROM fee_snapshots WHERE channel_id = ? AND node1_pub = ? ORDER BY snapshot_at DESC LIMIT 1'
    );
    const insert = this.db.prepare(
      'INSERT INTO fee_snapshots (channel_id, node1_pub, node2_pub, fee_base_msat, fee_rate_ppm, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    let inserted = 0;
    const tx = this.db.transaction((items: FeeSnapshot[]) => {
      for (const s of items) {
        const latest = check.get(s.channel_id, s.node1_pub) as { fee_base_msat: number; fee_rate_ppm: number } | undefined;
        if (!latest || latest.fee_base_msat !== s.fee_base_msat || latest.fee_rate_ppm !== s.fee_rate_ppm) {
          insert.run(s.channel_id, s.node1_pub, s.node2_pub, s.fee_base_msat, s.fee_rate_ppm, s.snapshot_at);
          inserted++;
        }
      }
    });
    tx(snapshots);
    return inserted;
  }

  purgeOlderThan(maxAgeSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    return this.db.prepare('DELETE FROM fee_snapshots WHERE snapshot_at < ?').run(cutoff).changes;
  }
}
