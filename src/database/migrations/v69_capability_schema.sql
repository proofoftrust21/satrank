-- Phase 11A.1 (2026-05-04) — Capability schema v1.
--
-- Per autonomy audit 2026-05-04 (lens L1 Discovery, sev-5 gaps
-- "no-capability-vocabulary" + "parameterised-endpoints-undiscoverable") :
-- Categories alone (ai/*, data/*) are too coarse for an autonomous agent
-- to filter on. Without standardised capability tags, an agent looking
-- for "French OCR returning JSON" must probe and pay until one delivers
-- the right shape — burning sats on validator violations.
--
-- This migration adds machine-readable capability columns to
-- service_endpoints so /api/intent and /api/services can return them
-- alongside p_e2e ranking. Phase 10 self-registration (v68) gains a
-- new requirement : operators MUST supply at least input_schema +
-- output_schema OR an OpenAPI doc that we can distill from. Existing
-- crawler-fed entries get NULL (provenance='unknown') and are eligible
-- for LLM-assisted backfill in a later phase.
--
-- Columns :
--   input_schema           JSONB    JSON Schema of request body (POST/PUT only)
--   output_schema          JSONB    JSON Schema of expected response body
--   modalities             TEXT[]   ['text','image','audio','video','code','embedding']
--   languages              TEXT[]   BCP-47 codes ('en','fr','es',...) — empty = N/A
--   freshness_sla_sec      INT      Max acceptable staleness for time-sensitive data (NULL = N/A)
--   deterministic          BOOLEAN  TRUE if same input → same output (e.g. archives, schemas)
--   capability_provenance  TEXT     'operator_signed' | 'crawler_inferred' | 'unknown'
--
-- Backwards compatibility : every column is nullable. Existing rows keep
-- working with capability_provenance=NULL until backfilled.

ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS input_schema           JSONB,
  ADD COLUMN IF NOT EXISTS output_schema          JSONB,
  ADD COLUMN IF NOT EXISTS modalities             TEXT[],
  ADD COLUMN IF NOT EXISTS languages              TEXT[],
  ADD COLUMN IF NOT EXISTS freshness_sla_sec      INT,
  ADD COLUMN IF NOT EXISTS deterministic          BOOLEAN,
  ADD COLUMN IF NOT EXISTS capability_provenance  TEXT;

-- Same columns on the operator self-registration staging table so the
-- Phase 10 verifier can validate them at registration time before the
-- entry is promoted into service_endpoints.
ALTER TABLE operator_endpoint_registrations
  ADD COLUMN IF NOT EXISTS input_schema       JSONB,
  ADD COLUMN IF NOT EXISTS output_schema      JSONB,
  ADD COLUMN IF NOT EXISTS modalities         TEXT[],
  ADD COLUMN IF NOT EXISTS languages          TEXT[],
  ADD COLUMN IF NOT EXISTS freshness_sla_sec  INT,
  ADD COLUMN IF NOT EXISTS deterministic      BOOLEAN;

-- Partial index : queries like "all endpoints supporting French text input
-- with deterministic output" should not full-scan the catalogue.
CREATE INDEX IF NOT EXISTS service_endpoints_modalities_gin
  ON service_endpoints USING GIN (modalities)
  WHERE modalities IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_endpoints_languages_gin
  ON service_endpoints USING GIN (languages)
  WHERE languages IS NOT NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (69, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'capability_schema_v1 — Phase 11A.1 : input/output JSON Schema + modalities + languages + freshness_sla + deterministic on service_endpoints and operator_endpoint_registrations')
ON CONFLICT (version) DO NOTHING;
