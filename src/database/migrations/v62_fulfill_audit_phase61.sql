-- Phase 6.1 (2026-05-01) — Audit fixes + residue refund.
--
-- Two distinct concerns share a migration because both touch fulfill_jobs:
--
-- 1. RESIDUE REFUND (Phase 6.1 spec)
--    Hold-mode currently settles the full reserve_sats_max even when actual
--    sats_spent + premium is much smaller. Agent provides an optional
--    refund_bolt11 (open-amount BOLT11) at /api/fulfill mode=hold time;
--    on orchestrator success SatRank settles the hold (claims reserve_sats_max),
--    then pays out residue=reserve - actual_spent - premium to refund_bolt11.
--    refund_state tracks the outbound pay so the cron can retry on transient
--    failure or surface stuck residue.
--
-- 2. AUDIT C1 + H4 — strict hold_invoice_state machine
--    setHoldInvoiceState currently has no guard, so the cron and orchestrator
--    can both write 'cancelled' / 'settled' on the same row in either order.
--    Adding refund_state means another column with similar transition rules.
--    The state-machine guard moves to the application layer (we keep
--    FulfillJobRepository methods that reject illegal transitions). No
--    DDL change required for the guard itself; this column add is the
--    only schema move.

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_bolt11 TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_state TEXT
    CHECK (refund_state IS NULL OR refund_state IN (
      'not_required', 'pending', 'paid', 'failed_absorbed'
    ));

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_amount_sats INTEGER;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_payment_preimage TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_attempts SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_last_error TEXT;

ALTER TABLE fulfill_jobs
  ADD COLUMN IF NOT EXISTS refund_settled_at INTEGER;

-- Index for the residue-refund retry cron — find pending refunds, oldest first.
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_refund_pending
  ON fulfill_jobs (refund_state, refund_settled_at)
  WHERE refund_state = 'pending';

INSERT INTO schema_version (version, applied_at, description)
VALUES (62, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'fulfill_audit_phase61 — residue refund + audit C1/H4 state-machine guards')
ON CONFLICT (version) DO NOTHING;
