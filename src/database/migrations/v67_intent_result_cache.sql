-- Phase 9.3 (2026-05-01) — Intent-keyed result cache + signed freshness.
--
-- Successful fulfill_jobs have their delivered body cached server-side keyed
-- by canonical intent_hash + a freshness window. Subsequent identical-intent
-- requests served from cache : agent pays a reduced premium (cache hit fee,
-- default 10% of original sats_paid) and gets a SatRank-signed freshness
-- attestation pointing back to the original preimage + body_sha256.
--
-- Cross-agent amortization : a single primary fulfill funds N derivative
-- consumers in the freshness window. SatRank captures premium revenue on
-- the cache hits (~= the operator pay would have been) without re-paying
-- the operator. Operator gets the original premium ; the network gets
-- cheaper subsequent calls.
--
-- TTL is per-category (server-side default 5 min for `data`, 30s for
-- `bitcoin`, 10 min for `data/government`, etc.). Hard cap 1h.

CREATE TABLE IF NOT EXISTS intent_result_cache (
  cache_id BIGSERIAL PRIMARY KEY,
  intent_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  -- Source attribution : the original successful fulfill_jobs.job_id and
  -- attempt that populated this cache row. Verifiers can join with
  -- evidence_receipts to confirm the cached body has a real preimage chain.
  source_job_id TEXT NOT NULL REFERENCES fulfill_jobs(job_id) ON DELETE CASCADE,
  source_attempt_index INTEGER NOT NULL,
  source_candidate_url TEXT NOT NULL,
  source_operator_pubkey TEXT,
  source_preimage TEXT NOT NULL,
  source_sats_paid INTEGER NOT NULL,
  -- Original agent who paid for the primary fulfill (for split-revenue
  -- accounting in Phase 9.3.1 ; v1 just records).
  source_agent_pubkey TEXT NOT NULL,
  -- Lifecycle.
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Hit counter for analytics.
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_intent_result_cache_lookup
  ON intent_result_cache (intent_hash, expires_at DESC);

-- Plain B-tree on expires_at for the prune cron's `WHERE expires_at < now`
-- scan. (A partial index with `now()` predicate is illegal — non-IMMUTABLE.)
CREATE INDEX IF NOT EXISTS idx_intent_result_cache_expired
  ON intent_result_cache (expires_at);

COMMENT ON TABLE intent_result_cache IS
  'Phase 9.3 — cross-agent intent-keyed result cache with signed freshness attestation. See project_indispensability_audit_20260501.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (67, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 9.3 — intent_result_cache')
ON CONFLICT (version) DO NOTHING;
