// Data access for the transactions table
import type Database from 'better-sqlite3';
import type { Transaction } from '../types';

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
}
