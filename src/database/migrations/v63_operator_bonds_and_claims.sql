-- Phase 7.1 (2026-05-01) — Operator bonds + agent claims (Indispensability Phase 7).
--
-- Sim 10 verdict : 7/10 agents said "partially could DIY" — SatRank routes but
-- doesn't take liability. To flip "partially → no" the audit converged on
-- pool-insurance-with-operator-stake : operators post a refundable bond when
-- listed ; SatRank slashes the bond and pays the harmed agent on Tier 2
-- delivery failures (delivery_low_quality, schema_violation, recall_body_read_error,
-- delivery_4xx, delivery_5xx). Single agent cannot self-insure 5-25% delivery
-- gap at sub-100-sat invoice sizes — only SatRank's N-agent × M-operator
-- vantage makes the pool actuarially viable.
--
-- This migration introduces two tables:
--   operator_bonds — what each operator has posted (LN-deposited sats locked)
--   agent_claims  — every Tier-2-or-worse outcome that triggers payout
--
-- The slashing logic is application-level (controlled by ClaimEngine in
-- Phase 7.3). This DDL only encodes the storage model.

-- ============================================================================
-- operator_bonds
-- ============================================================================
-- One row per (operator_pubkey, bond_payment_hash) — operators deposit sats
-- via a Lightning hold-invoice and the bond is held until release_at OR
-- slashed by the claim engine. We track committed (settled) and available
-- (= committed minus pending claims minus slashed_total) so the SQL can
-- enforce "no over-slash" without race.

CREATE TABLE IF NOT EXISTS operator_bonds (
  bond_id BIGSERIAL PRIMARY KEY,
  operator_pubkey TEXT NOT NULL,
  bond_payment_hash TEXT NOT NULL UNIQUE,  -- LN payment hash of the deposit
  bond_committed_sats INTEGER NOT NULL CHECK (bond_committed_sats > 0),
  bond_slashed_sats INTEGER NOT NULL DEFAULT 0,
  bond_pending_sats INTEGER NOT NULL DEFAULT 0,  -- in-flight claims not yet settled
  -- Actuarial floor: a bond drops below this → operator is auto-delisted from
  -- the catalogue until they top up. Ops choose; default 100 sats.
  min_floor_sats INTEGER NOT NULL DEFAULT 100,
  -- Lifecycle: 'active' takes new claims ; 'frozen' refuses new claims while
  -- a dispute is open ; 'released' = bond returned to operator (terminal).
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'frozen', 'released')),
  created_at INTEGER NOT NULL,  -- epoch sec
  -- Earliest the operator can request release (cooldown for in-flight claims).
  -- Default is created_at + 14 days ; computed by the bond-deposit handler.
  releasable_at INTEGER NOT NULL,
  released_at INTEGER,           -- set on terminal release
  slashed_total_at INTEGER,      -- set when the cumulative slashed reaches committed
  CHECK (bond_slashed_sats + bond_pending_sats <= bond_committed_sats)
);

CREATE INDEX IF NOT EXISTS idx_operator_bonds_operator
  ON operator_bonds (operator_pubkey, state);

-- For the auto-delisting cron : find bonds whose available drops below floor.
CREATE INDEX IF NOT EXISTS idx_operator_bonds_below_floor
  ON operator_bonds (state)
  WHERE state = 'active'
    AND (bond_committed_sats - bond_slashed_sats - bond_pending_sats) < min_floor_sats;

-- For the release cron : find bonds whose cooldown has elapsed.
CREATE INDEX IF NOT EXISTS idx_operator_bonds_releasable
  ON operator_bonds (releasable_at)
  WHERE state = 'active';

COMMENT ON TABLE operator_bonds IS
  'Phase 7 — operator-posted bonds backing Tier 2 refund claims. Slashed by ClaimEngine on misdelivery. See project_indispensability_audit_20260501.md.';

-- ============================================================================
-- agent_claims
-- ============================================================================
-- One row per Tier-2-or-worse delivery outcome that triggers a payout. The
-- claim engine writes these synchronously after settle ; the dispute path
-- can flip approved → disputed → (rejected | upheld) within a 24h window.
-- Final payout transitions to paid_out=true and slashes the bond.

CREATE TABLE IF NOT EXISTS agent_claims (
  claim_id BIGSERIAL PRIMARY KEY,
  -- The fulfill_jobs.job_id and per-attempt index that triggered this claim.
  -- fulfill_jobs.job_id is TEXT (we store UUIDs as strings) ; match the type.
  job_id TEXT NOT NULL REFERENCES fulfill_jobs(job_id) ON DELETE CASCADE,
  attempt_index INTEGER NOT NULL,    -- 0-based index into fulfill_jobs.attempts JSONB
  -- The agent who paid for the failed delivery.
  agent_pubkey TEXT NOT NULL,
  -- The bond being slashed.
  bond_id BIGINT NOT NULL REFERENCES operator_bonds(bond_id),
  -- The classification that triggered the claim.
  classification TEXT NOT NULL CHECK (classification IN (
    'tier1_http_4xx', 'tier1_http_5xx', 'tier1_http_other',
    'tier1_recall_network_error',
    'tier2_body_shape', 'tier2_empty_body', 'tier2_schema_violation',
    'sla_breach', 'validator_violation'
  )),
  -- Sats to pay the agent. Always ≥ what the agent paid (sats_paid) ;
  -- typically `sats_paid * multiplier` where multiplier ≥ 1 and depends
  -- on classification severity (set by ClaimEngine, not DDL).
  sats_paid_to_agent INTEGER NOT NULL CHECK (sats_paid_to_agent >= 0),
  sats_slashed_from_bond INTEGER NOT NULL CHECK (sats_slashed_from_bond >= 0),
  -- Lifecycle: 'pending' (just opened, awaiting dispute window) →
  -- 'paid' (window elapsed, bond debited, agent paid) OR
  -- 'disputed' (operator filed counter) → 'upheld' or 'rejected'.
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'paid', 'disputed', 'upheld', 'rejected')),
  -- Dispute window: pending claims become paid at this epoch.
  dispute_until INTEGER NOT NULL,    -- typically created_at + 24h
  dispute_filed_at INTEGER,
  resolved_at INTEGER,
  reason TEXT,                        -- machine-readable detail
  -- Idempotency: the same (job_id, attempt_index) may not produce two claims.
  CONSTRAINT agent_claims_unique_per_attempt UNIQUE (job_id, attempt_index),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_claims_state_dispute_until
  ON agent_claims (state, dispute_until)
  WHERE state IN ('pending', 'disputed');

CREATE INDEX IF NOT EXISTS idx_agent_claims_agent
  ON agent_claims (agent_pubkey, state);

CREATE INDEX IF NOT EXISTS idx_agent_claims_bond
  ON agent_claims (bond_id, state);

COMMENT ON TABLE agent_claims IS
  'Phase 7 — every Tier-2 delivery outcome that triggers an agent payout from an operator bond. Dispute window 24h before bond debit. See project_indispensability_audit_20260501.md.';

-- ============================================================================
-- Schema version bump.
-- ============================================================================
INSERT INTO schema_version (version, applied_at, description)
VALUES (63, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 7.1 — operator_bonds + agent_claims (indispensability audit)')
ON CONFLICT (version) DO NOTHING;
