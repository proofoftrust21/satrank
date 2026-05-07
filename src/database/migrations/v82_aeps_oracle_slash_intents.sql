-- AEPS §10 (2026-05-08) — Oracle slash intents.
--
-- When an oracle equivocates (signs both outcomes for the same dispute,
-- evidence in aeps_oracle_equivocations), the EquivocationClaimAdapter
-- records the slashing intent here. v0.1 :
--   - Find oracle's operator_bond ; if exists, reservePending the slash
--     amount to lock it from being used for other claims.
--   - state='reserved' when bond found and pending lock acquired.
--   - state='no_bond_found' when oracle has not posted a bond — the
--     equivocation evidence is recorded but no economic punishment is
--     possible (oracle has no skin in the game).
--   - state='executed' is set by a separate cron (v0.2) when the slash
--     actually moves bond_slashed_sats and credits 80% to the dispute
--     beneficiary, 15% to observers, 5% burned per §7.2.
--
-- The dispute window for equivocation is shorter than for delivery
-- claims (24h) because both signatures are themselves cryptographic
-- proof — there's nothing to dispute.
--
-- See spec/AEPS-whitepaper.md §10.

CREATE TABLE IF NOT EXISTS aeps_oracle_slash_intents (
  slash_intent_id BIGSERIAL PRIMARY KEY,
  oracle_pubkey TEXT NOT NULL,
  equivocation_id BIGINT NOT NULL UNIQUE REFERENCES aeps_oracle_equivocations(equivocation_id) ON DELETE CASCADE,
  -- Nullable : oracle may have no bond when the slash intent is recorded.
  bond_id BIGINT,
  -- Computed at intent-record time : 5 × EQUIVOCATION_BASELINE_SATS, default
  -- 50_000 sats baseline → 250_000 sats slash. Configurable via env later.
  slash_sats INTEGER NOT NULL,
  -- recorded | reserved | executed | no_bond_found | expired
  state TEXT NOT NULL DEFAULT 'recorded',
  created_at INTEGER NOT NULL,
  reserved_at INTEGER,
  executed_at INTEGER,
  -- 80%/15%/5% per §7.2 distribution. Set when state='executed'.
  -- payout_disputant_sats is the share that goes to the original
  -- equivocation-beneficiary disputant (the party who would have benefited
  -- if the oracle voted honestly).
  payout_disputant_sats INTEGER,
  payout_observer_sats INTEGER,
  payout_burned_sats INTEGER
);

CREATE INDEX IF NOT EXISTS idx_aeps_oracle_slash_intents_oracle
  ON aeps_oracle_slash_intents (oracle_pubkey, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aeps_oracle_slash_intents_state
  ON aeps_oracle_slash_intents (state)
  WHERE state IN ('recorded', 'reserved');

COMMENT ON TABLE aeps_oracle_slash_intents IS
  'AEPS §10 — slash intents recorded when an oracle equivocation is detected. Reserved against operator_bond pending bucket. Executed by a separate cron (v0.2) per §7.2 distribution.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (82, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'AEPS §10 — oracle slash intents (5× equivocation slashing tracker)')
ON CONFLICT (version) DO NOTHING;
