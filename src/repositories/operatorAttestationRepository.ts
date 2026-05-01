// Phase 8.4 (2026-05-01) — Operator attestation storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type AttestationState = 'pending' | 'verified' | 'failed' | 'expired';
export type VerificationMethod = 'dns_txt' | 'wellknown_https' | 'lei';

export interface OperatorAttestation {
  attestation_id: number;
  operator_pubkey: string;
  domain: string;
  verification_method: VerificationMethod;
  state: AttestationState;
  raw_record: string | null;
  created_at: number;
  verified_at: number | null;
  expires_at: number | null;
}

export interface CreateAttestationInput {
  operator_pubkey: string;
  domain: string;
  verification_method: VerificationMethod;
  expires_at?: number;
  created_at: number;
}

const ATTESTATION_TTL_SEC = 90 * 86400;

export class OperatorAttestationRepository {
  constructor(private db: Queryable) {}

  async createOrGet(input: CreateAttestationInput): Promise<OperatorAttestation> {
    const { rows } = await this.db.query<AttestationRow>(
      `INSERT INTO operator_attestations
        (operator_pubkey, domain, verification_method, state, created_at, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       ON CONFLICT (operator_pubkey, domain) DO UPDATE
         SET operator_pubkey = operator_attestations.operator_pubkey
       RETURNING *`,
      [
        input.operator_pubkey,
        input.domain,
        input.verification_method,
        input.created_at,
        input.expires_at ?? input.created_at + ATTESTATION_TTL_SEC,
      ],
    );
    return rowTo(rows[0]);
  }

  async findVerifiedByOperator(operatorPubkey: string): Promise<OperatorAttestation[]> {
    const { rows } = await this.db.query<AttestationRow>(
      `SELECT * FROM operator_attestations
       WHERE operator_pubkey = $1 AND state = 'verified'
         AND (expires_at IS NULL OR expires_at > EXTRACT(EPOCH FROM now())::int)
       ORDER BY verified_at DESC NULLS LAST`,
      [operatorPubkey],
    );
    return rows.map(rowTo);
  }

  async findById(id: number): Promise<OperatorAttestation | null> {
    const { rows } = await this.db.query<AttestationRow>(
      'SELECT * FROM operator_attestations WHERE attestation_id = $1',
      [id],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findRecheckable(nowSec: number, batchSize = 50): Promise<OperatorAttestation[]> {
    // Re-check pending + verified attestations 24h before expiry, OR pending
    // ones that have lingered > 5 minutes (initial verification cycle).
    const { rows } = await this.db.query<AttestationRow>(
      `SELECT * FROM operator_attestations
       WHERE (state = 'pending' AND created_at < $1 - 300)
         OR (state = 'verified' AND expires_at < $1 + 86400)
       ORDER BY expires_at ASC NULLS FIRST
       LIMIT $2`,
      [nowSec, batchSize],
    );
    return rows.map(rowTo);
  }

  async markVerified(id: number, rawRecord: string, nowSec: number, expiresAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_attestations
          SET state = 'verified', raw_record = $2, verified_at = $3, expires_at = $4
        WHERE attestation_id = $1`,
      [id, rawRecord, nowSec, expiresAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async markFailed(id: number, rawRecord: string | null, nowSec: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_attestations
          SET state = 'failed', raw_record = $2, verified_at = $3
        WHERE attestation_id = $1`,
      [id, rawRecord, nowSec],
    );
    return (rowCount ?? 0) === 1;
  }
}

interface AttestationRow {
  attestation_id: string | number;
  operator_pubkey: string;
  domain: string;
  verification_method: VerificationMethod;
  state: AttestationState;
  raw_record: string | null;
  created_at: string | number;
  verified_at: string | number | null;
  expires_at: string | number | null;
}

function rowTo(r: AttestationRow): OperatorAttestation {
  return {
    attestation_id: Number(r.attestation_id),
    operator_pubkey: r.operator_pubkey,
    domain: r.domain,
    verification_method: r.verification_method,
    state: r.state,
    raw_record: r.raw_record,
    created_at: Number(r.created_at),
    verified_at: r.verified_at != null ? Number(r.verified_at) : null,
    expires_at: r.expires_at != null ? Number(r.expires_at) : null,
  };
}
