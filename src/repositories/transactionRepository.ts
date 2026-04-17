// Data access for the transactions table
import type Database from 'better-sqlite3';
import type { Transaction } from '../types';
import type { DualWriteEnrichment, DualWriteLogger, DualWriteSourceModule } from '../utils/dualWriteLogger';

export type DualWriteMode = 'off' | 'dry_run' | 'active';

export class TransactionRepository {
  constructor(private db: Database.Database) {}

  findById(txId: string): Transaction | undefined {
    return this.db.prepare(
      'SELECT tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol FROM transactions WHERE tx_id = ?'
    ).get(txId) as Transaction | undefined;
  }

  findByAgentHash(agentHash: string): Transaction[] {
    return this.db.prepare(
      'SELECT * FROM transactions WHERE sender_hash = ? OR receiver_hash = ? ORDER BY timestamp DESC'
    ).all(agentHash, agentHash) as Transaction[];
  }

  findVerifiedByAgent(agentHash: string): Transaction[] {
    return this.db.prepare(
      `SELECT * FROM transactions
       WHERE (sender_hash = ? OR receiver_hash = ?) AND status = 'verified'
       ORDER BY timestamp DESC`
    ).all(agentHash, agentHash) as Transaction[];
  }

  countVerifiedByAgent(agentHash: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM transactions
       WHERE (sender_hash = ? OR receiver_hash = ?) AND status = 'verified'`
    ).get(agentHash, agentHash) as { count: number };
    return row.count;
  }

  countUniqueCounterparties(agentHash: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT counterparty) as count FROM (
        SELECT receiver_hash as counterparty FROM transactions WHERE sender_hash = ? AND status = 'verified'
        UNION
        SELECT sender_hash as counterparty FROM transactions WHERE receiver_hash = ? AND status = 'verified'
      )
    `).get(agentHash, agentHash) as { count: number };
    return row.count;
  }

  getTimestampsByAgent(agentHash: string): number[] {
    const rows = this.db.prepare(
      `SELECT timestamp FROM transactions
       WHERE (sender_hash = ? OR receiver_hash = ?) AND status = 'verified'
       ORDER BY timestamp ASC`
    ).all(agentHash, agentHash) as { timestamp: number }[];
    return rows.map(r => r.timestamp);
  }

  findRecentByAgent(agentHash: string, limit: number): Transaction[] {
    return this.db.prepare(
      'SELECT * FROM transactions WHERE sender_hash = ? OR receiver_hash = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(agentHash, agentHash, limit) as Transaction[];
  }

  totalCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    return row.count;
  }

  countByBucket(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT amount_bucket, COUNT(*) as count FROM transactions GROUP BY amount_bucket'
    ).all() as { amount_bucket: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.amount_bucket] = row.count;
    }
    return result;
  }

  insert(tx: Transaction): void {
    this.db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tx.tx_id, tx.sender_hash, tx.receiver_hash, tx.amount_bucket, tx.timestamp, tx.payment_hash, tx.preimage, tx.status, tx.protocol);
  }

  /** Dual-write-aware insert used during the Phase 1 rollout. Dispatches on
   *  the shadow-mode flag so the crawler code path is identical regardless of
   *  which rollout step we're in.
   *    off     — legacy 9-col INSERT only. Four v31 columns stay NULL.
   *    dry_run — legacy 9-col INSERT + NDJSON shadow emit. Four v31 columns
   *              stay NULL in DB; the enriched row is only logged.
   *    active  — single 13-col INSERT. Four v31 columns are populated. No
   *              NDJSON emit (the live table IS the source of truth now).
   *  Invariants (see docs/PHASE-1-DESIGN.md §4):
   *   - Exactly one INSERT is issued per call (no duplicate rows under any mode).
   *   - Callers always pass `enrichment` — dispatch is purely flag-driven.
   *   - Logger failure is swallowed by DualWriteLogger; DB failure bubbles. */
  insertWithDualWrite(
    tx: Transaction,
    enrichment: DualWriteEnrichment,
    mode: DualWriteMode,
    sourceModule: DualWriteSourceModule,
    shadowLogger?: DualWriteLogger,
    traceId?: string,
  ): void {
    if (mode === 'active') {
      this.db.prepare(`
        INSERT INTO transactions (
          tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
          payment_hash, preimage, status, protocol,
          endpoint_hash, operator_id, source, window_bucket
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tx.tx_id, tx.sender_hash, tx.receiver_hash, tx.amount_bucket, tx.timestamp,
        tx.payment_hash, tx.preimage, tx.status, tx.protocol,
        enrichment.endpoint_hash, enrichment.operator_id, enrichment.source, enrichment.window_bucket,
      );
      return;
    }

    this.insert(tx);

    if (mode === 'dry_run' && shadowLogger) {
      shadowLogger.emit({
        emitted_at: Math.floor(Date.now() / 1000),
        source_module: sourceModule,
        would_insert: { ...tx, ...enrichment },
        legacy_inserted: true,
        ...(traceId ? { trace_id: traceId } : {}),
      });
    }
  }
}
