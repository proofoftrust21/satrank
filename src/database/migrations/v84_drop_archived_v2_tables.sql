-- V2 recentrage (2026-05-08) — drop tables for archived AEPS subsystems.
--
-- The following subsystems were retired on the restructure/v2-recentered
-- branch and their code is preserved on archive/* branches :
--   - AEPS multi-hop HTLC chains    (archive/htlc-multihop)
--   - AEPS fork detection observer  (archive/aeps-dispute-fork-detection)
--   - AEPS dispute oracle           (archive/aeps-dispute-fork-detection)
--
-- The application no longer reads or writes any of these tables. Dropping
-- frees disk + simplifies the schema audit trail. Re-introduction would
-- replay the original migration (v78–v82) from the archive branch.
--
-- DROP order respects foreign-key dependencies (CASCADE just in case).

DROP TABLE IF EXISTS aeps_multihop_chain_legs CASCADE;
DROP TABLE IF EXISTS aeps_multihop_chains CASCADE;

DROP TABLE IF EXISTS aeps_fork_events CASCADE;
DROP TABLE IF EXISTS aeps_observed_anchors CASCADE;

DROP TABLE IF EXISTS aeps_dispute_attestations CASCADE;
DROP TABLE IF EXISTS aeps_disputes CASCADE;

DROP TABLE IF EXISTS aeps_oracle_slash_intents CASCADE;
DROP TABLE IF EXISTS aeps_oracle_equivocations CASCADE;
