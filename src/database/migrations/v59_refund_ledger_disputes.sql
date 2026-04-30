-- Phase 2 (2026-05-01) — Refund engine.
--
-- Two append-only tables: refund_ledger captures every absorbed-sat event
-- (paid attempt that didn't deliver), refund_disputes lets operators contest
-- a Tier-2 body-shape classification within a 24h window.
--
-- The refund_ledger is the accounting source of truth for SatRank's pool
-- exposure: sum(sats_absorbed) over a window = sats SatRank paid operators
-- but couldn't return to agents. Phase 4 (premium calibration cron) reads
-- this aggregate to keep the insurance pool solvent.
--
-- The refund_disputes table is intentionally lightweight: NIP-98-signed
-- operator complaint, status state machine (open → accepted/rejected),
-- 24h auto-reject sweep handled in app.ts. Accepting a dispute does NOT
-- re-debit the agent — the win is reputational (we lift the negative
-- attempt observation from the operator's stage posteriors).

CREATE TABLE IF NOT EXISTS refund_ledger (
  ledger_id        BIGSERIAL    PRIMARY KEY,
  job_id           TEXT         NOT NULL REFERENCES fulfill_jobs(job_id) ON DELETE CASCADE,
  candidate_url    TEXT         NOT NULL,
  agent_pubkey     TEXT         NOT NULL,
  sats_absorbed    INTEGER      NOT NULL CHECK (sats_absorbed > 0 AND sats_absorbed <= 100000),
  classification   TEXT         NOT NULL CHECK (classification IN (
                                  'tier1_http_4xx',
                                  'tier1_http_5xx',
                                  'tier1_http_other',
                                  'tier1_recall_network_error',
                                  'tier2_body_shape',
                                  'tier2_empty_body'
                                )),
  heuristic_reasons JSONB       NOT NULL DEFAULT '{}'::jsonb,
  http_status      INTEGER,
  preimage         TEXT,
  ts               INTEGER      NOT NULL
);

-- Idempotency: one refund per (job_id, candidate_url) pair. A retried
-- fulfill against the same job replays into the same ledger row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_ledger_idempotent
  ON refund_ledger (job_id, candidate_url);

-- Per-agent daily cap query.
CREATE INDEX IF NOT EXISTS idx_refund_ledger_agent_ts
  ON refund_ledger (agent_pubkey, ts DESC);

-- Pool accounting window queries.
CREATE INDEX IF NOT EXISTS idx_refund_ledger_ts
  ON refund_ledger (ts DESC);

CREATE TABLE IF NOT EXISTS refund_disputes (
  dispute_id       BIGSERIAL    PRIMARY KEY,
  ledger_id        BIGINT       NOT NULL REFERENCES refund_ledger(ledger_id) ON DELETE CASCADE,
  operator_pubkey  TEXT         NOT NULL,
  status           TEXT         NOT NULL CHECK (status IN ('open', 'accepted', 'rejected')) DEFAULT 'open',
  reason           TEXT,
  evidence         JSONB,
  signed_event_id  TEXT         NOT NULL,
  opened_at        INTEGER      NOT NULL,
  resolved_at      INTEGER,
  resolution_note  TEXT
);

-- One dispute per (ledger_id, operator_pubkey) — an operator can't spam
-- multiple disputes against the same refund.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_disputes_unique
  ON refund_disputes (ledger_id, operator_pubkey);

-- Sweeper picks up stale `open` disputes for auto-rejection after 24h.
CREATE INDEX IF NOT EXISTS idx_refund_disputes_open_age
  ON refund_disputes (status, opened_at)
  WHERE status = 'open';

COMMENT ON TABLE refund_ledger IS
  'Phase 2 (2026-05-01) — append-only ledger of absorbed-sat events. Phase 4 reads sum() to calibrate premium. See project_fulfill_proxy_plan.md.';

COMMENT ON TABLE refund_disputes IS
  'Phase 2 (2026-05-01) — operator NIP-98 challenges to Tier 2 body-shape classifications. Reputation-only resolution.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (59, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'refund_ledger + refund_disputes — Phase 2 fulfill proxy refund engine')
ON CONFLICT (version) DO NOTHING;
