-- Phase 11B.6 (2026-05-05) — agent-bond settlement watcher.
--
-- The agent-bond deposit flow generates an LND hold-invoice + preimage at
-- /api/agent/bond/deposit time, but a settlement watcher needs the preimage
-- to call /v2/invoices/settle once the HTLC is ACCEPTED on the LND side.
-- Without it, even a paid invoice never gets settled and the bond stays
-- locked forever (bond_pending_sats == bond_committed_sats == no available
-- tier benefit).
--
-- Add a preimage_hex column to agent_bond_pending_deposits so the cron can
-- claim the HTLC by revealing the preimage to LND. The column is nullable
-- only for back-compat with the (currently empty) v71 rows ; new deposits
-- always populate it.

ALTER TABLE agent_bond_pending_deposits
  ADD COLUMN IF NOT EXISTS preimage_hex TEXT;

INSERT INTO schema_version (version, applied_at, description)
VALUES (73, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'agent_bond_preimage — Phase 11B.6 : preimage_hex column on agent_bond_pending_deposits so the settlement watcher can call /v2/invoices/settle')
ON CONFLICT (version) DO NOTHING;
