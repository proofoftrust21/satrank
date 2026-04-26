-- Axe 1 — tiered probes + freshness gate.
-- Tracks the last time an endpoint was actually queried via /api/intent
-- or /api/decide. Drives the hot/warm/cold tiering in serviceHealthCrawler.
ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS last_intent_query_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_service_endpoints_last_intent_query_at
  ON service_endpoints (last_intent_query_at);

INSERT INTO schema_version (version, applied_at, description)
VALUES (42, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Axe 1 — last_intent_query_at column for tiered HTTP probe scheduling');
