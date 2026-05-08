-- V2 recentrage (2026-05-08) — drop tables for archived AgentBonds subsystem.
--
-- Phase 11B (agent_bonds + reputation tiers + tier-aware rate-limit) was
-- retired on the restructure/v2-recentered branch. Code is preserved on
-- archive/agent-bonds-tier-aware.
--
-- The application no longer reads or writes any of these tables. The
-- agent consumer parcours (V2) doesn't need bond/reputation/slashing — a
-- flat rate-limit + the agent_credit_balance suffice. Operator-side
-- quarantine (Phase 12.6/12.8/12.9) handles the coordination problems
-- without the symmetric agent bonding.
--
-- Restoration = checkout archive branch + replay v71 + v72.

DROP TABLE IF EXISTS agent_bonds CASCADE;
DROP TABLE IF EXISTS agent_reputation_profiles CASCADE;
DROP TABLE IF EXISTS agent_reputation_observations CASCADE;
DROP TABLE IF EXISTS agent_slashing_events CASCADE;
