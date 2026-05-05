-- Phase 12.1 (2026-05-05) — capability inference audit log.
--
-- Per audit semantic-rank-layer 2026-05-05 (lens L6 Lightning-pur, impact 2 :
-- "anthropic-backfill-not-reproducible"). Capability backfill via Anthropic
-- API produces non-deterministic outputs ; re-running yields different
-- schemas. This table persists the full provenance (model_id, prompt_hash,
-- raw response, parsed result, timestamp) so :
--   1. We can re-run with a different LLM or human review later
--   2. Forensic trail when a downstream ranking decision is contested
--   3. capability_provenance='crawler_inferred' rows are auditable end-to-end
--
-- One row per (endpoint_url, model_id, run_id). Newer runs supersede older
-- in service_endpoints but the log keeps every version.
--
-- Why a separate table from service_endpoints :
--   - service_endpoints carries the LATEST capability fields for the rank
--     hot path. The inference log carries the FULL HISTORY for compliance
--     and is rarely read.
--   - prompt + raw_response can be 4-32 KB each ; not appropriate on a
--     hot row that's read 10× per /api/intent.

CREATE TABLE IF NOT EXISTS capability_inference_log (
  log_id        BIGSERIAL PRIMARY KEY,
  endpoint_url  TEXT      NOT NULL,
  -- LLM identity. We pin model_id (e.g. "claude-haiku-4-5-20251001") so a
  -- model upgrade is traceable. prompt_hash is sha256 of the canonical
  -- prompt template + endpoint payload, lets us detect when the prompt
  -- format itself changed without re-reading the raw column.
  model_id      TEXT      NOT NULL,
  prompt_hash   TEXT      NOT NULL,
  prompt_raw    TEXT      NOT NULL,
  -- LLM output exactly as received. Useful for forensic re-parse if our
  -- parser is updated and we want to retroactively re-extract fields.
  response_raw  TEXT      NOT NULL,
  -- Parsed capability fields that ended up written to service_endpoints.
  -- JSONB so we can index into specific fields and detect drift later.
  parsed_capability JSONB NOT NULL,
  -- Bucketing. 'backfill' = bulk run on existing crawler-fed rows.
  -- 'enrichment' = single-row top-up (e.g. new endpoint without operator-
  -- signed schema). 'review' = human-led correction.
  run_kind      TEXT      NOT NULL DEFAULT 'backfill'
                            CHECK (run_kind IN ('backfill', 'enrichment', 'review')),
  -- Group ID for a single bulk run, lets ops query "all backfill_2026_05_05".
  run_id        TEXT      NOT NULL,
  created_at    INTEGER   NOT NULL,
  -- Whether the parsed result was actually written back to service_endpoints.
  -- false when the LLM refused / parse failed / a newer run already won.
  applied       BOOLEAN   NOT NULL DEFAULT FALSE,
  applied_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_capability_inference_log_endpoint
  ON capability_inference_log (endpoint_url, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capability_inference_log_run
  ON capability_inference_log (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capability_inference_log_applied
  ON capability_inference_log (applied, created_at DESC)
  WHERE applied = TRUE;

COMMENT ON TABLE capability_inference_log IS
  'Phase 12.1 (2026-05-05) — Audit trail for LLM-inferred capability fields. See project_audit_semrank_20260505.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (74, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'capability_inference_log — Phase 12.1 : audit trail for LLM-inferred capability backfill (Lightning-pur sovereignty)')
ON CONFLICT (version) DO NOTHING;
