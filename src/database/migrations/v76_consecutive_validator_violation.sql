-- Phase 12.8 (2026-05-06) — operator quarantine via consecutive validator
-- violations. Mirror of v75 consecutive_5xx_count for body-shape failures.
--
-- Per Sim 16 a2 + a6 HARMFUL findings : bitcoinbenji /mempool returns
-- HTTP 200 with body `{error: "Could not reach Bitcoin Core"}` — the
-- Phase 7.4 validator (P11A.4) catches it and triggers refund + bond
-- claim, but the agent already paid 5 sats. Repeated calls keep paying.
-- This counter auto-deprecates an endpoint after N consecutive validator
-- violations (default threshold = 3) so the ranker stops surfacing it.
--
-- Same column shape as v44 (404) and v75 (5xx) ; reset on a clean
-- delivery_ok ; deprecated_reason = 'validator_violation_persistent' so
-- clear5xxStreak / clear404Streak / clearValidatorViolationStreak each
-- only own their own deprecated rows.

ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS consecutive_validator_violation_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_service_endpoints_validator_streak
  ON service_endpoints (consecutive_validator_violation_count)
  WHERE consecutive_validator_violation_count >= 3;

INSERT INTO schema_version (version, applied_at, description)
VALUES (76, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'consecutive_validator_violation_count — Phase 12.8 : auto-deprecate body-shape repeat-offenders (mirror v75 5xx pattern)')
ON CONFLICT (version) DO NOTHING;
