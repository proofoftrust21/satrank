// Phase 2 (2026-05-01) — operator dispute table.
//
// Operators can NIP-98-sign a contest against a Tier 2 body-shape refund
// classification. The win is reputational (we lift the negative attempt
// observation from stage posteriors) — never a re-debit of the agent.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type DisputeStatus = 'open' | 'accepted' | 'rejected';

export interface RefundDispute {
  dispute_id: number;
  ledger_id: number;
  operator_pubkey: string;
  status: DisputeStatus;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  signed_event_id: string;
  opened_at: number;
  resolved_at: number | null;
  resolution_note: string | null;
}

export interface OpenDisputeInput {
  ledger_id: number;
  operator_pubkey: string;
  reason: string;
  evidence?: Record<string, unknown>;
  signed_event_id: string;
  opened_at: number;
}

export class RefundDisputeRepository {
  constructor(private db: Queryable) {}

  /** Insert a new open dispute. Returns null on duplicate (operator can't
   *  open more than one dispute against the same ledger row). */
  async open(input: OpenDisputeInput): Promise<RefundDispute | null> {
    const { rows } = await this.db.query<RefundDisputeRow>(
      `INSERT INTO refund_disputes
         (ledger_id, operator_pubkey, status, reason, evidence, signed_event_id, opened_at)
       VALUES ($1, $2, 'open', $3, $4::jsonb, $5, $6)
       ON CONFLICT (ledger_id, operator_pubkey) DO NOTHING
       RETURNING *`,
      [
        input.ledger_id,
        input.operator_pubkey,
        input.reason,
        input.evidence ? JSON.stringify(input.evidence) : null,
        input.signed_event_id,
        input.opened_at,
      ],
    );
    return rows[0] ? rowToDispute(rows[0]) : null;
  }

  async findById(disputeId: number): Promise<RefundDispute | null> {
    const { rows } = await this.db.query<RefundDisputeRow>(
      'SELECT * FROM refund_disputes WHERE dispute_id = $1',
      [disputeId],
    );
    return rows[0] ? rowToDispute(rows[0]) : null;
  }

  async findByLedger(ledgerId: number): Promise<RefundDispute[]> {
    const { rows } = await this.db.query<RefundDisputeRow>(
      'SELECT * FROM refund_disputes WHERE ledger_id = $1 ORDER BY opened_at DESC',
      [ledgerId],
    );
    return rows.map(rowToDispute);
  }

  /** Sweeper helper: open disputes older than `staleSec` get auto-rejected
   *  on cron. The sweeper is in app.ts, this method just resolves them. */
  async resolveStale(nowSec: number, staleSec: number): Promise<number> {
    const cutoff = nowSec - staleSec;
    const { rowCount } = await this.db.query(
      `UPDATE refund_disputes
          SET status = 'rejected',
              resolved_at = $1,
              resolution_note = 'auto_rejected_stale'
        WHERE status = 'open' AND opened_at < $2`,
      [nowSec, cutoff],
    );
    return rowCount ?? 0;
  }

  /** Manual resolution path — used by the future Phase 3+ admin tooling. */
  async resolve(
    disputeId: number,
    status: 'accepted' | 'rejected',
    resolvedAt: number,
    note?: string,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE refund_disputes
          SET status = $2, resolved_at = $3, resolution_note = $4
        WHERE dispute_id = $1 AND status = 'open'`,
      [disputeId, status, resolvedAt, note ?? null],
    );
    return (rowCount ?? 0) === 1;
  }
}

interface RefundDisputeRow {
  dispute_id: string | number;
  ledger_id: string | number;
  operator_pubkey: string;
  status: DisputeStatus;
  reason: string | null;
  evidence: Record<string, unknown> | string | null;
  signed_event_id: string;
  opened_at: string | number;
  resolved_at: string | number | null;
  resolution_note: string | null;
}

function rowToDispute(row: RefundDisputeRow): RefundDispute {
  return {
    dispute_id: Number(row.dispute_id),
    ledger_id: Number(row.ledger_id),
    operator_pubkey: row.operator_pubkey,
    status: row.status,
    reason: row.reason,
    evidence:
      row.evidence == null
        ? null
        : typeof row.evidence === 'string'
          ? JSON.parse(row.evidence)
          : row.evidence,
    signed_event_id: row.signed_event_id,
    opened_at: Number(row.opened_at),
    resolved_at: row.resolved_at != null ? Number(row.resolved_at) : null,
    resolution_note: row.resolution_note,
  };
}
