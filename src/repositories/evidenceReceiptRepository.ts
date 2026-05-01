// Phase 8.2 (2026-05-01) — Evidence receipt storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface EvidenceReceipt {
  receipt_id: number;
  job_id: string;
  attempt_index: number;
  payload_canonical_json: string;
  payload_sha256: string;
  signature_b64: string;
  satrank_pubkey: string;
  signed_at_iso: string;
  signed_at: number;
  tsa_token_b64: string | null;
  tsa_authority_url: string | null;
}

export interface CreateReceiptInput {
  job_id: string;
  attempt_index: number;
  payload_canonical_json: string;
  payload_sha256: string;
  signature_b64: string;
  satrank_pubkey: string;
  signed_at_iso: string;
  signed_at: number;
  tsa_token_b64?: string;
  tsa_authority_url?: string;
}

export class EvidenceReceiptRepository {
  constructor(private db: Queryable) {}

  /** Idempotent insert — re-issuing for the same (job_id, attempt_index)
   *  returns the existing row (preserves the original signature). */
  async createOrGet(input: CreateReceiptInput): Promise<EvidenceReceipt> {
    const { rows } = await this.db.query<EvidenceReceiptRow>(
      `INSERT INTO evidence_receipts
        (job_id, attempt_index, payload_canonical_json, payload_sha256,
         signature_b64, satrank_pubkey, signed_at_iso, signed_at,
         tsa_token_b64, tsa_authority_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id, attempt_index) DO UPDATE
         SET job_id = evidence_receipts.job_id
       RETURNING *`,
      [
        input.job_id,
        input.attempt_index,
        input.payload_canonical_json,
        input.payload_sha256,
        input.signature_b64,
        input.satrank_pubkey,
        input.signed_at_iso,
        input.signed_at,
        input.tsa_token_b64 ?? null,
        input.tsa_authority_url ?? null,
      ],
    );
    return rowToReceipt(rows[0]);
  }

  async findByJobAttempt(jobId: string, attemptIndex: number): Promise<EvidenceReceipt | null> {
    const { rows } = await this.db.query<EvidenceReceiptRow>(
      'SELECT * FROM evidence_receipts WHERE job_id = $1 AND attempt_index = $2',
      [jobId, attemptIndex],
    );
    return rows[0] ? rowToReceipt(rows[0]) : null;
  }

  async listByJob(jobId: string): Promise<EvidenceReceipt[]> {
    const { rows } = await this.db.query<EvidenceReceiptRow>(
      'SELECT * FROM evidence_receipts WHERE job_id = $1 ORDER BY attempt_index ASC',
      [jobId],
    );
    return rows.map(rowToReceipt);
  }
}

interface EvidenceReceiptRow {
  receipt_id: string | number;
  job_id: string;
  attempt_index: string | number;
  payload_canonical_json: string;
  payload_sha256: string;
  signature_b64: string;
  satrank_pubkey: string;
  signed_at_iso: string;
  signed_at: string | number;
  tsa_token_b64: string | null;
  tsa_authority_url: string | null;
}

function rowToReceipt(r: EvidenceReceiptRow): EvidenceReceipt {
  return {
    receipt_id: Number(r.receipt_id),
    job_id: r.job_id,
    attempt_index: Number(r.attempt_index),
    payload_canonical_json: r.payload_canonical_json,
    payload_sha256: r.payload_sha256,
    signature_b64: r.signature_b64,
    satrank_pubkey: r.satrank_pubkey,
    signed_at_iso: r.signed_at_iso,
    signed_at: Number(r.signed_at),
    tsa_token_b64: r.tsa_token_b64,
    tsa_authority_url: r.tsa_authority_url,
  };
}
