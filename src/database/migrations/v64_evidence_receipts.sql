-- Phase 8.2 (2026-05-01) — Evidence receipts (Indispensability Cluster 2).
--
-- Per fulfill_jobs success, EvidenceService issues a SatRank-signed receipt
-- agents can hand to a regulator/auditor without recomputing client-side.
-- The receipt binds : preimage (LN payment proof) + body_sha256 (content hash)
-- + intent_hash + candidate_url + operator_pubkey (Phase 8.4 attestation
-- joined separately) + ts_issued. Signed via Ed25519 keypair loaded by
-- SignerService.
--
-- Idempotent: receipts are issued lazily on first GET /api/fulfill/:job_id/evidence
-- and cached. Same (job_id, attempt_index) → same receipt. UNIQUE enforces this.
--
-- Optional RFC-3161 timestamp token storage is provisioned in tsa_token_b64
-- so a future Phase 8.2.1 follow-up can attach a TSA-stamped countersignature
-- without a schema change.

CREATE TABLE IF NOT EXISTS evidence_receipts (
  receipt_id BIGSERIAL PRIMARY KEY,
  -- Foreign key to fulfill_jobs (TEXT job_id matching fulfill_jobs.job_id).
  job_id TEXT NOT NULL REFERENCES fulfill_jobs(job_id) ON DELETE CASCADE,
  attempt_index INTEGER NOT NULL,
  -- The cryptographic content of the receipt :
  -- payload_canonical_json is the deterministic-key-order JSON the signature
  -- was computed over ; verifiers reconstruct it byte-exact.
  payload_canonical_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  satrank_pubkey TEXT NOT NULL,
  -- ISO 8601 UTC string for human-readable display (separate from the
  -- canonical payload that contains the same value as a stable string).
  signed_at_iso TEXT NOT NULL,
  -- Epoch sec for SQL queries / indexing.
  signed_at INTEGER NOT NULL,
  -- Optional RFC-3161 TSA token (base64). NULL when SatRank-only signature.
  tsa_token_b64 TEXT,
  tsa_authority_url TEXT,
  -- Idempotency: one receipt per (job_id, attempt_index).
  CONSTRAINT evidence_receipts_unique UNIQUE (job_id, attempt_index)
);

CREATE INDEX IF NOT EXISTS idx_evidence_receipts_job
  ON evidence_receipts (job_id);
CREATE INDEX IF NOT EXISTS idx_evidence_receipts_signed_at
  ON evidence_receipts (signed_at DESC);

COMMENT ON TABLE evidence_receipts IS
  'Phase 8.2 — SatRank-signed Ed25519 evidence receipts per (job_id, attempt_index). See project_indispensability_audit_20260501.md cluster 2.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (64, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 8.2 — evidence_receipts (regulator-grade signed receipts)')
ON CONFLICT (version) DO NOTHING;
