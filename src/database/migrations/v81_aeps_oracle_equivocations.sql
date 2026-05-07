-- AEPS §10 (2026-05-08) — Oracle equivocation detection.
--
-- An oracle who signs `disputant_wins` AND `respondent_wins` for the same
-- dispute publicly equivocates. The two BIP-340 signatures over the
-- canonical outcome messages are themselves cryptographic proof, verifiable
-- by anyone with the spec.
--
-- Pre-v81 the attestations table was idempotent on (dispute_id,
-- oracle_pubkey) and the second submission silently overwrote the first.
-- That lost the equivocation evidence. v81 :
--
-- 1. Adds `equivocated BOOLEAN DEFAULT FALSE` on aeps_dispute_attestations.
--    When the service detects a vote change, it sets this true on the
--    attestation row.
-- 2. Adds aeps_oracle_equivocations storing BOTH signatures + outcomes
--    + signed_at as the slashable evidence bundle.
-- 3. Threshold counting excludes attestations where equivocated = TRUE
--    (the oracle has lost trust and their vote no longer counts toward
--    resolution).
--
-- Slashing : equivocations open a 5× claim against the oracle's own
-- operator_bond (oracles ARE operators serving in another operator's
-- dispute set). Wired in a follow-up commit to ClaimEngine.

-- 1. Add the equivocated flag.
ALTER TABLE aeps_dispute_attestations
  ADD COLUMN IF NOT EXISTS equivocated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_aeps_dispute_attestations_equivocated
  ON aeps_dispute_attestations (dispute_id, oracle_pubkey)
  WHERE equivocated = TRUE;

-- 2. Equivocation evidence bundle.
CREATE TABLE IF NOT EXISTS aeps_oracle_equivocations (
  equivocation_id BIGSERIAL PRIMARY KEY,
  oracle_pubkey TEXT NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES aeps_disputes(dispute_id) ON DELETE CASCADE,
  -- The two contradictory votes. outcome_a and outcome_b MUST differ.
  outcome_a TEXT NOT NULL,
  signature_hex_a TEXT NOT NULL,
  signed_at_a INTEGER NOT NULL,
  outcome_b TEXT NOT NULL,
  signature_hex_b TEXT NOT NULL,
  signed_at_b INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  -- Set when ClaimEngine opens a slashing claim against the oracle's bond.
  claim_id BIGINT,
  -- One equivocation row per (oracle, dispute) — additional vote changes
  -- after the first equivocation are also evidence but the row is canonical.
  CONSTRAINT aeps_oracle_equivocations_unique UNIQUE (oracle_pubkey, dispute_id),
  CONSTRAINT aeps_oracle_equivocations_distinct CHECK (outcome_a <> outcome_b)
);

CREATE INDEX IF NOT EXISTS idx_aeps_oracle_equivocations_oracle
  ON aeps_oracle_equivocations (oracle_pubkey, detected_at DESC);

COMMENT ON TABLE aeps_oracle_equivocations IS
  'AEPS §10 — oracle equivocation evidence. Both signatures are publicly verifiable proof of the offence. Triggers 5× slashing against oracle_pubkey''s operator bond.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (81, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'AEPS §10 — oracle equivocation detection (publicly slashable)')
ON CONFLICT (version) DO NOTHING;
