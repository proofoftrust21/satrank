// Phase 2 (2026-05-01) — append-only refund ledger.
//
// Every absorbed-sat event (paid attempt that didn't deliver to the agent)
// gets one row. The ledger is the accounting source of truth for SatRank's
// pool exposure and feeds the per-agent daily cap.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type RefundClassification =
  | 'tier1_http_4xx'
  | 'tier1_http_5xx'
  | 'tier1_http_other'
  | 'tier1_recall_network_error'
  | 'tier2_body_shape'
  | 'tier2_empty_body';

export interface RefundLedgerEntry {
  ledger_id: number;
  job_id: string;
  candidate_url: string;
  agent_pubkey: string;
  sats_absorbed: number;
  classification: RefundClassification;
  heuristic_reasons: Record<string, unknown>;
  http_status: number | null;
  preimage: string | null;
  ts: number;
}

export interface RecordRefundInput {
  job_id: string;
  candidate_url: string;
  agent_pubkey: string;
  sats_absorbed: number;
  classification: RefundClassification;
  heuristic_reasons?: Record<string, unknown>;
  http_status?: number | null;
  preimage?: string | null;
  ts: number;
}

export class RefundLedgerRepository {
  constructor(private db: Queryable) {}

  /** Record one absorbed-sat event. Idempotent on (job_id, candidate_url):
   *  re-recording the same attempt is a no-op rather than a duplicate row.
   *  Returns the inserted (or existing) ledger_id. */
  async record(input: RecordRefundInput): Promise<{ ledger_id: number; inserted: boolean }> {
    const { rows } = await this.db.query<{ ledger_id: string; inserted: boolean }>(
      `WITH ins AS (
        INSERT INTO refund_ledger
          (job_id, candidate_url, agent_pubkey, sats_absorbed, classification,
           heuristic_reasons, http_status, preimage, ts)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
        ON CONFLICT (job_id, candidate_url) DO NOTHING
        RETURNING ledger_id
      )
      SELECT ledger_id::text AS ledger_id, true AS inserted FROM ins
      UNION ALL
      SELECT ledger_id::text, false AS inserted
        FROM refund_ledger
       WHERE job_id = $1 AND candidate_url = $2
         AND NOT EXISTS (SELECT 1 FROM ins)
      LIMIT 1`,
      [
        input.job_id,
        input.candidate_url,
        input.agent_pubkey,
        input.sats_absorbed,
        input.classification,
        JSON.stringify(input.heuristic_reasons ?? {}),
        input.http_status ?? null,
        input.preimage ?? null,
        input.ts,
      ],
    );
    if (!rows[0]) {
      throw new Error('refund_ledger.record: neither insert nor lookup returned a row');
    }
    return { ledger_id: Number(rows[0].ledger_id), inserted: rows[0].inserted };
  }

  /** Sum of sats absorbed by SatRank on this agent's behalf in the trailing
   *  N seconds. Used by the per-agent daily cap. */
  async agentAbsorbedSatsSince(agentPubkey: string, sinceSec: number): Promise<number> {
    const { rows } = await this.db.query<{ s: string | null }>(
      `SELECT COALESCE(SUM(sats_absorbed), 0)::text AS s
         FROM refund_ledger
        WHERE agent_pubkey = $1 AND ts >= $2`,
      [agentPubkey, sinceSec],
    );
    return Number(rows[0]?.s ?? 0);
  }

  /** Lifetime / windowed pool exposure for /api/oracle/fulfill telemetry. */
  async windowStats(sinceSec: number): Promise<{
    total_events: number;
    sats_absorbed: number;
    by_classification: Record<RefundClassification, number>;
  }> {
    const { rows } = await this.db.query<{
      classification: RefundClassification;
      c: string;
      s: string;
    }>(
      `SELECT classification, COUNT(*)::text AS c, COALESCE(SUM(sats_absorbed), 0)::text AS s
         FROM refund_ledger
        WHERE ts >= $1
        GROUP BY classification`,
      [sinceSec],
    );
    const out = {
      total_events: 0,
      sats_absorbed: 0,
      by_classification: {} as Record<RefundClassification, number>,
    };
    for (const r of rows) {
      const c = Number(r.c);
      out.total_events += c;
      out.sats_absorbed += Number(r.s);
      out.by_classification[r.classification] = c;
    }
    return out;
  }

  async findById(ledgerId: number): Promise<RefundLedgerEntry | null> {
    const { rows } = await this.db.query<RefundLedgerEntryRow>(
      'SELECT * FROM refund_ledger WHERE ledger_id = $1',
      [ledgerId],
    );
    return rows[0] ? rowToEntry(rows[0]) : null;
  }
}

interface RefundLedgerEntryRow {
  ledger_id: string | number;
  job_id: string;
  candidate_url: string;
  agent_pubkey: string;
  sats_absorbed: string | number;
  classification: RefundClassification;
  heuristic_reasons: Record<string, unknown> | string;
  http_status: number | null;
  preimage: string | null;
  ts: string | number;
}

function rowToEntry(row: RefundLedgerEntryRow): RefundLedgerEntry {
  return {
    ledger_id: Number(row.ledger_id),
    job_id: row.job_id,
    candidate_url: row.candidate_url,
    agent_pubkey: row.agent_pubkey,
    sats_absorbed: Number(row.sats_absorbed),
    classification: row.classification,
    heuristic_reasons:
      typeof row.heuristic_reasons === 'string'
        ? JSON.parse(row.heuristic_reasons)
        : (row.heuristic_reasons ?? {}),
    http_status: row.http_status,
    preimage: row.preimage,
    ts: Number(row.ts),
  };
}
