-- AEPS §10 (2026-05-07) — Dispute resolution via DLC oracle attestations.
--
-- Per the whitepaper, disputes are resolved by Discreet Log Contract oracles
-- pre-agreed in the capability descriptor's `dlc_oracles` field. Each oracle
-- in the threshold set independently fetches the disputed receipt(s),
-- validates against the published output_schema, and signs a BIP-340
-- Schnorr attestation over the canonical outcome message
--
--   canonical_message = canonicalJson({
--     v: "AEPS-§10",
--     dispute_id: "<uuid>",
--     outcome: "disputant_wins" | "respondent_wins"
--   })
--   signed_bytes = sha256(canonical_message)
--
-- When `dlc_threshold` oracles have all signed the SAME outcome, the
-- dispute resolves automatically and triggers slashing (or refund) per
-- §7.2 distribution.
--
-- Dispute types per §10.1 with multipliers :
--   content_correctness  → 5×
--   fork                 → 5×
--   sla_breach           → 3×
--   false_dispute        → 3×
--   non_payment          → 1×
--
-- v0.1 stores disputes + attestations + handles state machine. On-chain
-- DLC contract construction (anchoring resolution to Bitcoin L1 via
-- adaptor signatures) is a v0.2 follow-up — the cryptographic substance
-- (Schnorr threshold attestation) is here.

CREATE TABLE IF NOT EXISTS aeps_disputes (
  dispute_id TEXT PRIMARY KEY,
  disputant_pubkey TEXT NOT NULL,
  respondent_pubkey TEXT NOT NULL,
  -- content_correctness | sla_breach | fork | non_payment | false_dispute
  dispute_type TEXT NOT NULL,
  -- AT MOST ONE of these is non-null. Disputes typically reference either a
  -- specific receipt (content_correctness, sla_breach, non_payment) or a
  -- specific fork event.
  receipt_id BIGINT,
  fork_event_id BIGINT REFERENCES aeps_fork_events(fork_event_id),
  multiplier INTEGER NOT NULL,
  -- The pre-agreed oracle threshold set. Stored as TEXT[] (Postgres array)
  -- of 64-char hex BIP-340 x-only pubkeys.
  oracle_pubkeys TEXT[] NOT NULL,
  oracle_threshold INTEGER NOT NULL,
  -- open | resolved_disputant | resolved_respondent | expired | aborted
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- Free-text reason for the dispute, max ~500 chars (enforced at app layer).
  dispute_reason TEXT,
  -- agent_claims.id when slashing is triggered.
  claim_id BIGINT,
  CHECK (multiplier IN (1, 2, 3, 5)),
  CHECK (oracle_threshold > 0),
  CHECK (cardinality(oracle_pubkeys) >= oracle_threshold)
);

CREATE INDEX IF NOT EXISTS idx_aeps_disputes_state
  ON aeps_disputes (state)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS idx_aeps_disputes_disputant
  ON aeps_disputes (disputant_pubkey, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aeps_disputes_respondent
  ON aeps_disputes (respondent_pubkey, created_at DESC);

CREATE TABLE IF NOT EXISTS aeps_dispute_attestations (
  attestation_id BIGSERIAL PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES aeps_disputes(dispute_id) ON DELETE CASCADE,
  oracle_pubkey TEXT NOT NULL,
  -- 'disputant_wins' | 'respondent_wins'
  outcome TEXT NOT NULL,
  -- BIP-340 Schnorr signature, 64 bytes = 128 hex chars.
  signature_hex TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  -- Idempotent : one attestation per (dispute, oracle).
  CONSTRAINT aeps_dispute_attestations_unique UNIQUE (dispute_id, oracle_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_aeps_dispute_attestations_dispute
  ON aeps_dispute_attestations (dispute_id);

COMMENT ON TABLE aeps_disputes IS
  'AEPS §10 — disputes resolved via BIP-340 Schnorr threshold oracle attestation. See spec/AEPS-whitepaper.md §10.';

COMMENT ON TABLE aeps_dispute_attestations IS
  'AEPS §10.2 — per-oracle Schnorr signatures over the canonical outcome message. Threshold = dispute.oracle_threshold for the same outcome resolves the dispute.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (80, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'AEPS §10 — disputes + Schnorr threshold oracle attestations')
ON CONFLICT (version) DO NOTHING;
