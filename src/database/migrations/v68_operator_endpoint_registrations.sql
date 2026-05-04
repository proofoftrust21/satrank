-- Phase 10 (2026-05-04) — Operator-side SDK : self-service endpoint registration.
--
-- Sim 12 follow-up Audit 2 Move C : transform SatRank from crawler-fed catalogue
-- (350 endpoints from 4 sources) into a two-sided marketplace where operators
-- self-register their L402 endpoints with structured metadata :
--   - OpenAPI 3 schema (request shape, response shape, parameter docs)
--   - Recall body template — orchestrator auto-composes the post-pay POST body
--     when the agent doesn't supply recall_body (Sim 12 Fix B extension)
--   - Recommended validators (Phase 7.4 DSL — min_bytes/has_field/contains)
--   - Expected price range (sats min/max)
--   - Optional bond stake (Phase 7.2 — operator commits collateral)
--
-- Verification flow :
--   1. POST /api/operator/register-endpoint with NIP-98 auth (operator's Nostr key)
--   2. Domain validated via operatorAttestationService.validateOperatorDomain
--   3. State = 'pending'. Crawler tick verifies DNS TXT _satrank-operator.<domain>
--      contains the operator_pubkey (reuses Phase 8.4 OperatorAttestationService).
--   4. On match → state = 'verified'. Endpoint becomes available in /api/intent.
--   5. On mismatch / no record → state = 'failed'. Retry after 24h.
--
-- Why a separate table from existing service_endpoints :
--   - service_endpoints is crawler-fed (sources : 402index, l402.directory, etc.)
--   - operator_endpoint_registrations is operator-fed (self-attested, signed)
--   - The two converge into a unified candidates view at intentService.resolveIntent
--   - operator-registered entries get a higher rank prior (proven owner)

CREATE TABLE IF NOT EXISTS operator_endpoint_registrations (
  registration_id   BIGSERIAL   PRIMARY KEY,
  endpoint_url      TEXT        NOT NULL,
  http_method       TEXT        NOT NULL CHECK (http_method IN ('GET', 'POST')),
  operator_pubkey   TEXT        NOT NULL,    -- LN node pubkey or Nostr pubkey
  domain            TEXT        NOT NULL,    -- root domain for DNS TXT verification
  state             TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'verified', 'failed', 'revoked')),
  -- OpenAPI 3 schema covering request + response shape. Capped to ~64 KB per row.
  openapi_json      JSONB,
  -- Default recall body template the orchestrator uses when the agent
  -- doesn't supply one (Sim 12 Fix B). Either a fixed JSON object OR a
  -- template-with-placeholders string the orchestrator interpolates from
  -- the agent's intent.keywords / category. Capped 4 KB.
  recall_body_template TEXT,
  -- Phase 7.4 DSL strings the operator promises to satisfy on every recall.
  -- Validator failures slash the bond. Up to 10 entries by Zod cap.
  recommended_validators TEXT[],
  -- Expected pricing band. Helps agents budget. NULL = variable.
  expected_price_sats_min INTEGER,
  expected_price_sats_max INTEGER,
  -- Optional Phase 7.2 bond. NULL when operator hasn't staked.
  bond_id           INTEGER     REFERENCES operator_bonds(bond_id),
  -- Operator's signature over the registration payload (Ed25519 or Nostr).
  -- Used to prevent post-hoc tampering ; verified at registration time.
  signed_payload_sha256 TEXT    NOT NULL,
  signature_b64     TEXT        NOT NULL,
  -- Audit trail.
  registered_at     INTEGER     NOT NULL,
  verified_at       INTEGER,
  last_health_at    INTEGER,
  -- Counter incremented on each fulfill attempt that resolved through this
  -- registration. Helps populate reliability_score.
  fulfill_count     INTEGER     NOT NULL DEFAULT 0,
  fulfill_success_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT operator_endpoint_registrations_url_unique UNIQUE (endpoint_url)
);

-- Lookup by operator (their submission history).
CREATE INDEX IF NOT EXISTS idx_oer_operator
  ON operator_endpoint_registrations (operator_pubkey, registered_at DESC);

-- Lookup by state (cron crawls 'pending' rows).
CREATE INDEX IF NOT EXISTS idx_oer_state
  ON operator_endpoint_registrations (state, registered_at);

-- Lookup by URL for fast catalogue join with service_endpoints.
CREATE INDEX IF NOT EXISTS idx_oer_url
  ON operator_endpoint_registrations (endpoint_url) WHERE state = 'verified';

COMMENT ON TABLE operator_endpoint_registrations IS
  'Phase 10 (2026-05-04) — Operator-side SDK self-registrations. See project_phase10_operator_sdk.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (68, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'operator_endpoint_registrations — Phase 10 operator-side SDK : self-service endpoint registration with OpenAPI + recall_body_template + bond')
ON CONFLICT (version) DO NOTHING;
