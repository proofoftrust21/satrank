-- Vague 1 G.2: ingest 402index quality signals as upstream prior.
-- 402index already exposes per-entry health metrics that SatRank used to
-- ignore (uptime_30d, latency_p50_ms, reliability_score, etc.). We persist
-- them as nullable columns on service_endpoints and use them in the
-- Bayesian prior cascade so newly-ingested rows enter the ranking with a
-- meaningful prior instead of the flat Beta(1.5, 1.5).
ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS upstream_health_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS upstream_uptime_30d DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS upstream_latency_p50_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS upstream_reliability_score INTEGER NULL,
  ADD COLUMN IF NOT EXISTS upstream_last_checked BIGINT NULL,
  ADD COLUMN IF NOT EXISTS upstream_source TEXT NULL DEFAULT '402index',
  ADD COLUMN IF NOT EXISTS upstream_signals_updated_at BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_service_endpoints_upstream_reliability
  ON service_endpoints (upstream_reliability_score)
  WHERE upstream_reliability_score IS NOT NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (43, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Vague 1 G.2 - upstream quality signals from 402index (health_status, uptime_30d, latency_p50_ms, reliability_score)');
