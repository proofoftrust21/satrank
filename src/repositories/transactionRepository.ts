// Data access for the transactions table (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import type { Transaction } from '../types';
import type { DualWriteEnrichment, DualWriteLogger, DualWriteSourceModule } from '../utils/dualWriteLogger';

type Queryable = Pool | PoolClient;

export type DualWriteMode = 'off' | 'dry_run' | 'active';

export class TransactionRepository {
  constructor(private db: Queryable) {}

  async findById(txId: string): Promise<Transaction | undefined> {
    const { rows } = await this.db.query<Transaction>(
      'SELECT tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol FROM transactions WHERE tx_id = $1',
      [txId],
    );
    return rows[0];
  }

  async findByAgentHash(agentHash: string): Promise<Transaction[]> {
    const { rows } = await this.db.query<Transaction>(
      'SELECT * FROM transactions WHERE sender_hash = $1 OR receiver_hash = $2 ORDER BY timestamp DESC',
      [agentHash, agentHash],
    );
    return rows;
  }

  async findVerifiedByAgent(agentHash: string): Promise<Transaction[]> {
    const { rows } = await this.db.query<Transaction>(
      `SELECT * FROM transactions
       WHERE (sender_hash = $1 OR receiver_hash = $2) AND status = 'verified'
       ORDER BY timestamp DESC`,
      [agentHash, agentHash],
    );
    return rows;
  }

  async countVerifiedByAgent(agentHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM transactions
       WHERE (sender_hash = $1 OR receiver_hash = $2) AND status = 'verified'`,
      [agentHash, agentHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async countUniqueCounterparties(agentHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(DISTINCT counterparty)::text as count FROM (
        SELECT receiver_hash as counterparty FROM transactions WHERE sender_hash = $1 AND status = 'verified'
        UNION
        SELECT sender_hash as counterparty FROM transactions WHERE receiver_hash = $2 AND status = 'verified'
      ) sub
      `,
      [agentHash, agentHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async getTimestampsByAgent(agentHash: string): Promise<number[]> {
    const { rows } = await this.db.query<{ timestamp: number }>(
      `SELECT timestamp FROM transactions
       WHERE (sender_hash = $1 OR receiver_hash = $2) AND status = 'verified'
       ORDER BY timestamp ASC`,
      [agentHash, agentHash],
    );
    return rows.map(r => r.timestamp);
  }

  async findRecentByAgent(agentHash: string, limit: number): Promise<Transaction[]> {
    const { rows } = await this.db.query<Transaction>(
      'SELECT * FROM transactions WHERE sender_hash = $1 OR receiver_hash = $2 ORDER BY timestamp DESC LIMIT $3',
      [agentHash, agentHash, limit],
    );
    return rows;
  }

  async totalCount(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>('SELECT COUNT(*)::text as count FROM transactions');
    return Number(rows[0]?.count ?? 0);
  }

  async countByBucket(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ amount_bucket: string; count: string }>(
      'SELECT amount_bucket, COUNT(*)::text as count FROM transactions GROUP BY amount_bucket',
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.amount_bucket] = Number(row.count);
    }
    return result;
  }

  async insert(tx: Transaction): Promise<void> {
    await this.db.query(
      `
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [tx.tx_id, tx.sender_hash, tx.receiver_hash, tx.amount_bucket, tx.timestamp, tx.payment_hash, tx.preimage, tx.status, tx.protocol],
    );
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
  async insertWithDualWrite(
    tx: Transaction,
    enrichment: DualWriteEnrichment,
    mode: DualWriteMode,
    sourceModule: DualWriteSourceModule,
    shadowLogger?: DualWriteLogger,
    traceId?: string,
  ): Promise<void> {
    if (mode === 'active') {
      await this.db.query(
        `
        INSERT INTO transactions (
          tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
          payment_hash, preimage, status, protocol,
          endpoint_hash, operator_id, source, window_bucket
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          tx.tx_id, tx.sender_hash, tx.receiver_hash, tx.amount_bucket, tx.timestamp,
          tx.payment_hash, tx.preimage, tx.status, tx.protocol,
          enrichment.endpoint_hash, enrichment.operator_id, enrichment.source, enrichment.window_bucket,
        ],
      );
      return;
    }

    await this.insert(tx);

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
