-- Phase 1 (2026-05-01) — Fulfill proxy v1.
--
-- New core primitive: SatRank executes paid L402 calls on behalf of agents
-- and returns result-or-refund. This is the strategic pivot from "trust
-- oracle" (passive observer of metadata) to "execution layer agent-side"
-- documented in project_fulfill_proxy_plan.md.
--
-- A fulfill_jobs row is the durable record of one /api/fulfill request.
-- It is created in `in_flight` state, transitions to one of:
--   success    — at least one candidate delivered a 2xx body, agent's
--                token_balance debited for sats_spent + premium_sats,
--                preimage stored, result_body_sha256 stored as audit trail.
--   refunded   — every candidate failed, no token_balance debit, agent
--                receives 502 with attempts[] for diagnostics.
--   aborted    — orchestrator-side failure (max_latency, repository error,
--                LND outage). Treated as refunded for accounting.
--
-- Idempotency: same (agent_pubkey, intent_hash, max_sats) within a 60s
-- window returns the prior result. The composite index supports a fast
-- range scan; the controller does the time check in JS.
--
-- Privacy-first: result_body_sha256 (32 bytes hex) is the only artefact
-- of the response we keep. The actual body is never persisted (audit
-- agent #2 of project_security_audit_20260430.md — no body in logs/DB).
-- The agent_pubkey is essential for accounting; we don't aggregate by it
-- in public observability surfaces.

CREATE TABLE IF NOT EXISTS fulfill_jobs (
  job_id              TEXT        PRIMARY KEY,
  agent_pubkey        TEXT        NOT NULL,
  intent_hash         TEXT        NOT NULL,
  max_sats            INTEGER     NOT NULL CHECK (max_sats > 0 AND max_sats <= 100000),
  max_latency_ms      INTEGER     NOT NULL CHECK (max_latency_ms BETWEEN 100 AND 600000),
  status              TEXT        NOT NULL CHECK (status IN ('in_flight','success','refunded','aborted')),
  attempts            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sats_spent          INTEGER     NOT NULL DEFAULT 0 CHECK (sats_spent >= 0),
  sats_refunded       INTEGER     NOT NULL DEFAULT 0 CHECK (sats_refunded >= 0),
  premium_sats        INTEGER     NOT NULL DEFAULT 0 CHECK (premium_sats >= 0),
  preimage            TEXT,
  result_body_sha256  TEXT,
  reason              TEXT,
  created_at          INTEGER     NOT NULL,
  settled_at          INTEGER
);

-- Per-agent recent jobs (rate limit, idempotency time-window scan).
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_agent_created
  ON fulfill_jobs (agent_pubkey, created_at DESC);

-- Status sweeper (reconciliation cron picks up stuck in_flight jobs).
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_status_created
  ON fulfill_jobs (status, created_at)
  WHERE status = 'in_flight';

-- Idempotency: agent + same intent + same cap, recent window.
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_idempotency
  ON fulfill_jobs (agent_pubkey, intent_hash, max_sats, created_at DESC);

COMMENT ON TABLE fulfill_jobs IS
  'Phase 1 (2026-05-01) — durable record of /api/fulfill requests. See project_fulfill_proxy_plan.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (58, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'fulfill_jobs — Phase 1 fulfill proxy: durable record of /api/fulfill executions')
ON CONFLICT (version) DO NOTHING;
