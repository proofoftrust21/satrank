-- Phase 12B — enable extensions required at first boot
-- Runs exactly once when pgdata is empty.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
