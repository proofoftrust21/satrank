-- Phase 6 (2026-05-01) — Hold-invoice non-custodial mode for /api/fulfill.
--
-- Phase 1-5 ran the fulfill proxy in CUSTODIAL mode: the agent prepays
-- via /api/deposit, gets credits in token_balance, fulfill debits at
-- success time. That works but requires the agent to trust SatRank with
-- a balance.
--
-- Phase 6 adds HOLD-INVOICE mode (non-custodial). The flow:
--   1. POST /api/fulfill {mode:'hold', intent, max_sats, max_latency_ms}
--      → SatRank generates a Lightning hold-invoice for max_sats+premium_max,
--        returns 402 with the BOLT11 + job_id, marks hold_invoice_state='awaiting_payment'.
--   2. Agent pays the hold-invoice (HTLCs locked across the path; SatRank
--      can either settle or cancel — never holds the agent's sats outside
--      the HTLC routing window).
--   3. POST /api/fulfill/{job_id}/execute (idempotent) → SatRank looks up
--      the invoice on LND. If state=ACCEPTED (= paid, awaiting settle),
--      orchestrator runs. On success: SettleInvoice(preimage) claims the
--      HTLC for actual_spent+premium. On full-fail: CancelInvoice() releases
--      the HTLC, agent's sats unblock automatically.
--   4. Reconciliation cron auto-cancels hold-invoices older than the
--      configured timeout so HTLCs can't dangle.
--
-- Custodial mode (Phase 1-5) stays available; the `mode` column lets agents
-- pick per-call. Defaults to 'deposit' for back-compat.

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'deposit'
    CHECK (mode IN ('deposit', 'hold'));

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS hold_invoice_payment_request TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS hold_invoice_payment_hash TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS hold_invoice_preimage TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS hold_invoice_state TEXT
    CHECK (hold_invoice_state IS NULL OR hold_invoice_state IN (
      'awaiting_payment', 'accepted', 'settled', 'cancelled', 'expired'
    ));

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS hold_invoice_expires_at INTEGER;

-- Index for the reconciliation cron — find expired hold-invoices to cancel.
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_hold_awaiting
  ON fulfill_jobs (hold_invoice_state, hold_invoice_expires_at)
  WHERE hold_invoice_state IN ('awaiting_payment', 'accepted');

-- Allow the new in_flight semantic for hold mode without changing the
-- existing 'in_flight' state for deposit mode. Status state-machine in
-- application code handles the cross-mode transitions.

INSERT INTO schema_version (version, applied_at, description)
VALUES (61, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'fulfill_hold_invoice — Phase 6 non-custodial hold-invoice mode')
ON CONFLICT (version) DO NOTHING;
