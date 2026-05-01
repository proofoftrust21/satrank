-- Phase 9.4 (2026-05-01) — Reputation-bonded credit line for agents.
--
-- Each fulfill_jobs.success grants the agent +1 sat in `accumulated_sats`
-- (the "delivery credit" — a reputation reward for productive history).
-- Agents can borrow up to `accumulated_sats - borrowed_sats` against
-- future fulfills (deferred token_balance debit ; settles when the next
-- successful fulfill credits enough to repay).
--
-- Solves Sim 10 EdgeDecisionAI / SearchScoutAI starvation : agents whose
-- per-call budget is too small to bootstrap a meaningful pool of
-- token_balance hit "insufficient_balance" repeatedly. With a credit line
-- they can ride a deficit early and repay as their reputation accrues.

CREATE TABLE IF NOT EXISTS agent_credits (
  agent_pubkey TEXT PRIMARY KEY,
  -- Lifetime sum of delivery_ok events (1 sat per ok).
  accumulated_sats INTEGER NOT NULL DEFAULT 0,
  -- Currently outstanding borrow (≤ accumulated_sats).
  borrowed_sats INTEGER NOT NULL DEFAULT 0,
  -- Last action timestamp for rate-limiting / cleanup.
  last_event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (borrowed_sats >= 0),
  CHECK (borrowed_sats <= accumulated_sats)
);

CREATE INDEX IF NOT EXISTS idx_agent_credits_borrowed
  ON agent_credits (borrowed_sats DESC)
  WHERE borrowed_sats > 0;

COMMENT ON TABLE agent_credits IS
  'Phase 9.4 — agent reputation credit line. +1 sat per delivery_ok, borrowable against future fulfills. See project_indispensability_audit_20260501.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (66, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 9.4 — agent_credits (reputation-bonded credit line)')
ON CONFLICT (version) DO NOTHING;
