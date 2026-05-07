// AEPS §10 (2026-05-07) — Dispute + attestation storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type DisputeType =
  | 'content_correctness'
  | 'sla_breach'
  | 'fork'
  | 'non_payment'
  | 'false_dispute';

export type DisputeState =
  | 'open'
  | 'resolved_disputant'
  | 'resolved_respondent'
  | 'expired'
  | 'aborted';

export type AttestationOutcome = 'disputant_wins' | 'respondent_wins';

export interface AepsDispute {
  dispute_id: string;
  disputant_pubkey: string;
  respondent_pubkey: string;
  dispute_type: DisputeType;
  receipt_id: number | null;
  fork_event_id: number | null;
  multiplier: number;
  oracle_pubkeys: string[];
  oracle_threshold: number;
  state: DisputeState;
  expires_at: number;
  created_at: number;
  resolved_at: number | null;
  dispute_reason: string | null;
  claim_id: number | null;
}

export interface AepsDisputeAttestation {
  attestation_id: number;
  dispute_id: string;
  oracle_pubkey: string;
  outcome: AttestationOutcome;
  signature_hex: string;
  signed_at: number;
}

export interface CreateDisputeInput {
  dispute_id: string;
  disputant_pubkey: string;
  respondent_pubkey: string;
  dispute_type: DisputeType;
  receipt_id?: number | null;
  fork_event_id?: number | null;
  multiplier: number;
  oracle_pubkeys: string[];
  oracle_threshold: number;
  expires_at: number;
  created_at: number;
  dispute_reason?: string | null;
}

export interface RecordAttestationInput {
  dispute_id: string;
  oracle_pubkey: string;
  outcome: AttestationOutcome;
  signature_hex: string;
  signed_at: number;
}

export class AepsDisputeRepository {
  constructor(private db: Queryable) {}

  async createDispute(input: CreateDisputeInput): Promise<AepsDispute> {
    const { rows } = await this.db.query<DisputeRow>(
      `INSERT INTO aeps_disputes
        (dispute_id, disputant_pubkey, respondent_pubkey, dispute_type,
         receipt_id, fork_event_id, multiplier, oracle_pubkeys, oracle_threshold,
         state, expires_at, created_at, dispute_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12)
       RETURNING *`,
      [
        input.dispute_id,
        input.disputant_pubkey,
        input.respondent_pubkey,
        input.dispute_type,
        input.receipt_id ?? null,
        input.fork_event_id ?? null,
        input.multiplier,
        input.oracle_pubkeys,
        input.oracle_threshold,
        input.expires_at,
        input.created_at,
        input.dispute_reason ?? null,
      ],
    );
    return rowToDispute(rows[0]);
  }

  async findDispute(disputeId: string): Promise<AepsDispute | null> {
    const { rows } = await this.db.query<DisputeRow>(
      'SELECT * FROM aeps_disputes WHERE dispute_id = $1',
      [disputeId],
    );
    return rows[0] ? rowToDispute(rows[0]) : null;
  }

  async recordAttestation(
    input: RecordAttestationInput,
  ): Promise<AepsDisputeAttestation> {
    const { rows } = await this.db.query<AttestationRow>(
      `INSERT INTO aeps_dispute_attestations
        (dispute_id, oracle_pubkey, outcome, signature_hex, signed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dispute_id, oracle_pubkey) DO UPDATE
         SET signature_hex = EXCLUDED.signature_hex,
             outcome = EXCLUDED.outcome,
             signed_at = LEAST(aeps_dispute_attestations.signed_at, EXCLUDED.signed_at)
       RETURNING *`,
      [input.dispute_id, input.oracle_pubkey, input.outcome, input.signature_hex, input.signed_at],
    );
    return rowToAttestation(rows[0]);
  }

  async listAttestations(disputeId: string): Promise<AepsDisputeAttestation[]> {
    const { rows } = await this.db.query<AttestationRow>(
      `SELECT * FROM aeps_dispute_attestations
       WHERE dispute_id = $1
       ORDER BY signed_at ASC`,
      [disputeId],
    );
    return rows.map(rowToAttestation);
  }

  async updateDisputeState(
    disputeId: string,
    state: DisputeState,
    extra: { resolved_at?: number; claim_id?: number } = {},
  ): Promise<void> {
    const sets: string[] = ['state = $2'];
    const params: (string | number | null)[] = [disputeId, state];
    if (extra.resolved_at !== undefined) {
      sets.push(`resolved_at = $${params.length + 1}`);
      params.push(extra.resolved_at);
    }
    if (extra.claim_id !== undefined) {
      sets.push(`claim_id = $${params.length + 1}`);
      params.push(extra.claim_id);
    }
    await this.db.query(
      `UPDATE aeps_disputes SET ${sets.join(', ')} WHERE dispute_id = $1`,
      params,
    );
  }

  async findExpiredOpenDisputes(nowSec: number): Promise<AepsDispute[]> {
    const { rows } = await this.db.query<DisputeRow>(
      `SELECT * FROM aeps_disputes
       WHERE state = 'open' AND expires_at < $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [nowSec],
    );
    return rows.map(rowToDispute);
  }
}

interface DisputeRow {
  dispute_id: string;
  disputant_pubkey: string;
  respondent_pubkey: string;
  dispute_type: string;
  receipt_id: string | number | null;
  fork_event_id: string | number | null;
  multiplier: string | number;
  oracle_pubkeys: string[];
  oracle_threshold: string | number;
  state: string;
  expires_at: string | number;
  created_at: string | number;
  resolved_at: string | number | null;
  dispute_reason: string | null;
  claim_id: string | number | null;
}

interface AttestationRow {
  attestation_id: string | number;
  dispute_id: string;
  oracle_pubkey: string;
  outcome: string;
  signature_hex: string;
  signed_at: string | number;
}

function rowToDispute(r: DisputeRow): AepsDispute {
  return {
    dispute_id: r.dispute_id,
    disputant_pubkey: r.disputant_pubkey,
    respondent_pubkey: r.respondent_pubkey,
    dispute_type: r.dispute_type as DisputeType,
    receipt_id: r.receipt_id !== null ? Number(r.receipt_id) : null,
    fork_event_id: r.fork_event_id !== null ? Number(r.fork_event_id) : null,
    multiplier: Number(r.multiplier),
    oracle_pubkeys: r.oracle_pubkeys,
    oracle_threshold: Number(r.oracle_threshold),
    state: r.state as DisputeState,
    expires_at: Number(r.expires_at),
    created_at: Number(r.created_at),
    resolved_at: r.resolved_at !== null ? Number(r.resolved_at) : null,
    dispute_reason: r.dispute_reason,
    claim_id: r.claim_id !== null ? Number(r.claim_id) : null,
  };
}

function rowToAttestation(r: AttestationRow): AepsDisputeAttestation {
  return {
    attestation_id: Number(r.attestation_id),
    dispute_id: r.dispute_id,
    oracle_pubkey: r.oracle_pubkey,
    outcome: r.outcome as AttestationOutcome,
    signature_hex: r.signature_hex,
    signed_at: Number(r.signed_at),
  };
}
