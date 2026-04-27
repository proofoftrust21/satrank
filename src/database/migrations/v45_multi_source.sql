-- Vague 3 Phase 3 — multi-source catalogue tracking. The single `source`
-- column collapses cross-source attribution: when an endpoint is announced
-- by both 402index and l402.directory, only the most recent ingest wins.
-- We add `sources TEXT[]` so dedup is additive rather than overwriting,
-- plus two signals only available via l402.directory (consumption_type +
-- provider_contact) so the new ingest path doesn't have to drop them.
ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS sources TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS consumption_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS provider_contact TEXT NULL;

-- GIN index because sources is a small array and queries will mostly use
-- the @> containment operator (e.g. WHERE sources @> ARRAY['l402directory']).
CREATE INDEX IF NOT EXISTS idx_service_endpoints_sources
  ON service_endpoints USING GIN (sources);

-- Backfill: existing rows have a singular source, mirror it into sources[]
-- so the new code can rely on a single source-of-truth without special-casing
-- legacy rows. Idempotent — re-running leaves rows unchanged.
UPDATE service_endpoints
SET sources = ARRAY[source]
WHERE sources = '{}' AND source IS NOT NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (45, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Vague 3 Phase 3 - multi-source sources[] + consumption_type + provider_contact');
