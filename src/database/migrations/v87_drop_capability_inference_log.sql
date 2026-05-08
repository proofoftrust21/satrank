-- V2 audit (2026-05-08) — drop capability_inference_log table.
--
-- Phase 12.1 audit trail for LLM-inferred capability backfill was
-- never wired into the runtime pipeline (the corresponding repository
-- was only imported by its own test file). Drop the orphan table.

DROP TABLE IF EXISTS capability_inference_log CASCADE;
