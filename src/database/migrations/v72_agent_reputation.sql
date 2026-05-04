-- Phase 11B.2 (2026-05-04) — Agent reputation ledger.
--
-- Per autonomy audit 2026-05-04 (lens L2 Identity & reputation portability,
-- sev-5 gap "no-agent-reputation-ledger"). An agent that has shipped
-- hundreds of clean fulfills is treated identically to a brand-new
-- pubkey ; good behaviour does not compound. This table makes the
-- behaviour stick.
--
-- One row per agent_pubkey. Columns track per-outcome counts so a
-- Bayesian Beta posterior (alpha/(alpha+beta) with Laplace smoothing) is
-- a simple computation away. Decay (exponential half-life on old
-- observations) is application-level — kept out of the DDL so we can
-- iterate without migrations.

CREATE TABLE IF NOT EXISTS fulfill_agent_profiles (
  agent_pubkey TEXT PRIMARY KEY,
  -- Counters. Updated by AgentReputationService.recordOutcome on every
  -- fulfill terminal status. Failed fulfills include refunded + violated.
  total_fulfills INTEGER NOT NULL DEFAULT 0 CHECK (total_fulfills >= 0),
  successful_fulfills INTEGER NOT NULL DEFAULT 0 CHECK (successful_fulfills >= 0),
  refunded_fulfills INTEGER NOT NULL DEFAULT 0 CHECK (refunded_fulfills >= 0),
  validator_violations INTEGER NOT NULL DEFAULT 0 CHECK (validator_violations >= 0),
  -- Cached score : alpha / (alpha+beta) with Laplace smoothing where
  -- alpha = successful_fulfills + 1 and beta = (refunded_fulfills +
  -- validator_violations) + 1. Recomputed on each recordOutcome call.
  -- Default 0.5 (neutral prior — equivalent to alpha=beta=1).
  reputation_score REAL NOT NULL DEFAULT 0.5
    CHECK (reputation_score >= 0 AND reputation_score <= 1),
  -- Tier label cached for cheap reads. Computed by service.
  -- bronze : score < 0.5 OR total_fulfills < 5 (insufficient signal)
  -- silver : 0.5 ≤ score < 0.85
  -- gold   : score ≥ 0.85 AND total_fulfills ≥ 50
  reputation_tier TEXT NOT NULL DEFAULT 'bronze'
    CHECK (reputation_tier IN ('bronze', 'silver', 'gold')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reputation_updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fulfill_agent_profiles_tier
  ON fulfill_agent_profiles (reputation_tier);

CREATE INDEX IF NOT EXISTS idx_fulfill_agent_profiles_last_seen
  ON fulfill_agent_profiles (last_seen_at DESC);

COMMENT ON TABLE fulfill_agent_profiles IS
  'Phase 11B.2 (2026-05-04) — Per-agent reputation profile (Bayesian Beta posterior). See project_autonomy_audit_20260504.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (72, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'fulfill_agent_profiles — Phase 11B.2 : per-agent reputation_score + tier (bronze|silver|gold) computed from fulfill outcomes')
ON CONFLICT (version) DO NOTHING;
