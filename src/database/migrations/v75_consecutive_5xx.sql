-- Phase 12.6 (2026-05-06) — operator quarantine via consecutive_5xx_count.
--
-- Per Sim 15 finding (a3 MarketIntelligenceAI HARMFUL) : "21 sats burned
-- on a known-dead Cloudflare 502 endpoint suggests health/quarantine
-- signals are not being applied to ranking". The audit's catalog-quality
-- recommendation : auto-deprecate endpoints that 5xx for N consecutive
-- probes, mirroring the existing v44 consecutive_404_count fossile
-- pruning.
--
-- Same column shape as v44 ; same auto-revert pattern (a probe success
-- resets the counter to 0). Threshold is application-level
-- (DEPRECATED_5XX_THRESHOLD = 3 in serviceHealthCrawler) so we can tune
-- without migration.

ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS consecutive_5xx_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_service_endpoints_5xx_streak
  ON service_endpoints (consecutive_5xx_count)
  WHERE consecutive_5xx_count >= 3;

INSERT INTO schema_version (version, applied_at, description)
VALUES (75, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'consecutive_5xx_count — Phase 12.6 : operator quarantine when an endpoint returns 5xx for N consecutive probes (mirrors v44 fossile 404 pattern)')
ON CONFLICT (version) DO NOTHING;
