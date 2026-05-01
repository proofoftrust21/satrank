-- Phase 8.4 (2026-05-01) — Operator domain attestations.
--
-- Each operator declares a domain via DNS TXT record :
--   _satrank-operator.<domain> "satrank-operator-pubkey=<hex_pubkey>"
-- The attestation crawler verifies the record matches the operator's
-- registered Nostr/L402 pubkey. Verified attestations get embedded in
-- evidence receipts so a regulator can resolve "operator X" → real-world
-- domain X.com without trusting SatRank's bare claim.
--
-- LEI lookup + HTTPS .well-known/satrank-operator.json crawler are deferred
-- to Phase 8.4.1 (more involved : LEI registry API, HTTPS crawl + signature
-- verification chain).

CREATE TABLE IF NOT EXISTS operator_attestations (
  attestation_id BIGSERIAL PRIMARY KEY,
  operator_pubkey TEXT NOT NULL,
  domain TEXT NOT NULL,
  -- Method used to verify the attestation. v1 = 'dns_txt' only.
  verification_method TEXT NOT NULL CHECK (verification_method IN ('dns_txt', 'wellknown_https', 'lei')),
  -- Status: 'pending' (just created, awaiting crawler) ; 'verified' (matches
  -- operator_pubkey) ; 'failed' (record missing or mismatched) ; 'expired'
  -- (re-check passed window without re-verification — attestations live 90d
  -- by default and require re-publishing).
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'verified', 'failed', 'expired')),
  -- Last-seen DNS TXT value or .well-known JSON for forensics.
  raw_record TEXT,
  -- ISO 8601 strings + epoch seconds for query convenience.
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  expires_at INTEGER,  -- created_at + 90d default
  -- Idempotency: one attestation per (operator_pubkey, domain).
  CONSTRAINT operator_attestations_unique UNIQUE (operator_pubkey, domain)
);

CREATE INDEX IF NOT EXISTS idx_operator_attestations_pubkey
  ON operator_attestations (operator_pubkey, state);

CREATE INDEX IF NOT EXISTS idx_operator_attestations_recheck
  ON operator_attestations (expires_at)
  WHERE state IN ('verified', 'pending');

COMMENT ON TABLE operator_attestations IS
  'Phase 8.4 — operator domain ownership proofs (DNS TXT v1). Embedded in evidence receipts.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (65, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 8.4 — operator_attestations (DNS TXT v1)')
ON CONFLICT (version) DO NOTHING;
