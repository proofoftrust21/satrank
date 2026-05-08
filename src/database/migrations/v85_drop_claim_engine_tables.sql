-- V2 recentrage (2026-05-08) — drop tables for archived ClaimEngine subsystem.
--
-- ClaimEngine + OperatorBondService were retired on the
-- restructure/v2-recentered branch. Code is preserved on
-- archive/claim-engine-operator-bonds.
--
-- The application no longer reads or writes any of these tables.
-- The agent consumer parcours (Phase 12 quarantine + 5-stage posterior)
-- handles operator faults without per-attempt slashing claims.
--
-- Restoration = checkout archive branch + replay v63.

DROP TABLE IF EXISTS agent_claims CASCADE;
DROP TABLE IF EXISTS operator_bonds CASCADE;
