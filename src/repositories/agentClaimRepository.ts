// Phase 7.3 (2026-05-01) — Agent claim storage layer.
//
// One row per Tier-2-or-worse delivery outcome that triggers a payout. The
// ClaimEngine writes claims synchronously after a fulfill_jobs.attempts
// entry classifies as Tier 2 / SLA breach / validator violation. The dispute
// path can transition pending → disputed → upheld | rejected within a 24h
// window. Final payout transitions to `paid` and slashes the bond.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type AgentClaimState =
  | 'pending'
  | 'paid'
  | 'disputed'
  | 'upheld'
  | 'rejected';

export type AgentClaimClassification =
  | 'tier1_http_4xx'
  | 'tier1_http_5xx'
  | 'tier1_http_other'
  | 'tier1_recall_network_error'
  | 'tier2_body_shape'
  | 'tier2_empty_body'
  | 'tier2_schema_violation'
  | 'sla_breach'
  | 'validator_violation';

export interface AgentClaim {
  claim_id: number;
  job_id: string;
  attempt_index: number;
  agent_pubkey: string;
  bond_id: number;
  classification: AgentClaimClassification;
  sats_paid_to_agent: number;
  sats_slashed_from_bond: number;
  state: AgentClaimState;
  dispute_until: number;
  dispute_filed_at: number | null;
  resolved_at: number | null;
  reason: string | null;
  created_at: number;
}

export interface CreateClaimInput {
  job_id: string;
  attempt_index: number;
  agent_pubkey: string;
  bond_id: number;
  classification: AgentClaimClassification;
  sats_paid_to_agent: number;
  sats_slashed_from_bond: number;
  dispute_until: number;
  reason?: string;
  created_at: number;
}

export class AgentClaimRepository {
  constructor(private db: Queryable) {}

  /** Idempotent : (job_id, attempt_index) UNIQUE. ON CONFLICT returns the
   *  existing row instead of inserting. Used by the orchestrator hook so a
   *  retry on attempts-recording doesn't double-claim. */
  async createOrGet(input: CreateClaimInput): Promise<AgentClaim> {
    const { rows } = await this.db.query<AgentClaimRow>(
      `INSERT INTO agent_claims
        (job_id, attempt_index, agent_pubkey, bond_id, classification,
         sats_paid_to_agent, sats_slashed_from_bond, dispute_until, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id, attempt_index) DO UPDATE SET job_id = agent_claims.job_id
       RETURNING *`,
      [
        input.job_id,
        input.attempt_index,
        input.agent_pubkey,
        input.bond_id,
        input.classification,
        input.sats_paid_to_agent,
        input.sats_slashed_from_bond,
        input.dispute_until,
        input.reason ?? null,
        input.created_at,
      ],
    );
    return rowToClaim(rows[0]);
  }

  async findById(claimId: number): Promise<AgentClaim | null> {
    const { rows } = await this.db.query<AgentClaimRow>(
      'SELECT * FROM agent_claims WHERE claim_id = $1',
      [claimId],
    );
    return rows[0] ? rowToClaim(rows[0]) : null;
  }

  /** Cron : pending claims whose dispute window has elapsed → ready to pay. */
  async findReadyForPayout(nowSec: number): Promise<AgentClaim[]> {
    const { rows } = await this.db.query<AgentClaimRow>(
      `SELECT * FROM agent_claims
       WHERE state = 'pending' AND dispute_until <= $1
       ORDER BY dispute_until ASC
       LIMIT 50`,
      [nowSec],
    );
    return rows.map(rowToClaim);
  }

  /** Operator side : open claims against their bond they may dispute. */
  async findDisputableByBond(bondId: number, nowSec: number): Promise<AgentClaim[]> {
    const { rows } = await this.db.query<AgentClaimRow>(
      `SELECT * FROM agent_claims
       WHERE bond_id = $1 AND state = 'pending' AND dispute_until > $2
       ORDER BY created_at ASC`,
      [bondId, nowSec],
    );
    return rows.map(rowToClaim);
  }

  async setState(
    claimId: number,
    state: AgentClaimState,
    resolvedAt: number,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_claims
          SET state = $2, resolved_at = $3
        WHERE claim_id = $1`,
      [claimId, state, resolvedAt],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Operator files a dispute. Idempotent on already-disputed. */
  async fileDispute(claimId: number, filedAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_claims
          SET state = 'disputed', dispute_filed_at = $2
        WHERE claim_id = $1 AND state = 'pending'`,
      [claimId, filedAt],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Aggregates for /api/oracle/claims dashboard. */
  async statsLast24h(nowSec: number): Promise<{
    total: number;
    pending: number;
    paid: number;
    disputed: number;
    upheld: number;
    rejected: number;
    sats_paid_total: number;
    sats_slashed_total: number;
  }> {
    const cutoff = nowSec - 24 * 3600;
    const { rows } = await this.db.query<{
      state: AgentClaimState;
      c: string;
      sats_paid_total: string | null;
      sats_slashed_total: string | null;
    }>(
      `SELECT state, COUNT(*)::text AS c,
              COALESCE(SUM(sats_paid_to_agent), 0)::text AS sats_paid_total,
              COALESCE(SUM(sats_slashed_from_bond), 0)::text AS sats_slashed_total
         FROM agent_claims
        WHERE created_at >= $1
        GROUP BY state`,
      [cutoff],
    );
    const out = {
      total: 0, pending: 0, paid: 0, disputed: 0, upheld: 0, rejected: 0,
      sats_paid_total: 0, sats_slashed_total: 0,
    };
    for (const r of rows) {
      const c = Number(r.c);
      out.total += c;
      out[r.state] = c;
      out.sats_paid_total += Number(r.sats_paid_total ?? 0);
      out.sats_slashed_total += Number(r.sats_slashed_total ?? 0);
    }
    return out;
  }
}

interface AgentClaimRow {
  claim_id: string | number;
  job_id: string;
  attempt_index: string | number;
  agent_pubkey: string;
  bond_id: string | number;
  classification: AgentClaimClassification;
  sats_paid_to_agent: string | number;
  sats_slashed_from_bond: string | number;
  state: AgentClaimState;
  dispute_until: string | number;
  dispute_filed_at: string | number | null;
  resolved_at: string | number | null;
  reason: string | null;
  created_at: string | number;
}

function rowToClaim(r: AgentClaimRow): AgentClaim {
  return {
    claim_id: Number(r.claim_id),
    job_id: r.job_id,
    attempt_index: Number(r.attempt_index),
    agent_pubkey: r.agent_pubkey,
    bond_id: Number(r.bond_id),
    classification: r.classification,
    sats_paid_to_agent: Number(r.sats_paid_to_agent),
    sats_slashed_from_bond: Number(r.sats_slashed_from_bond),
    state: r.state,
    dispute_until: Number(r.dispute_until),
    dispute_filed_at: r.dispute_filed_at != null ? Number(r.dispute_filed_at) : null,
    resolved_at: r.resolved_at != null ? Number(r.resolved_at) : null,
    reason: r.reason,
    created_at: Number(r.created_at),
  };
}
