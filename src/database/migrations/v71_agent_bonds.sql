-- Phase 11B.1 (2026-05-04) — Agent bonds (symmetric to operator_bonds).
--
-- Per autonomy audit 2026-05-04 (lens L2 Identity & reputation portability,
-- sev-5 gaps "no-rogue-agent-eviction" + "agent-sybil-unbounded"). Phase 7
-- gave operators bonds, claims, slashing — agents have NONE of that. Free
-- secp256k1 keypairs let an adversary spawn 10k pubkeys, each with its own
-- 30/min rate-limit and credit-line allowance, and drain the pool absorption
-- budget at scale. Symmetric agent bonds close that loop : an agent posts
-- refundable sats, SatRank tier-gates rate-limit, credit, and result-cache
-- writes on the bond size, and slashes the bond when validated abuse is
-- detected.
--
-- agent_bonds mirrors operator_bonds : one row per (agent_pubkey,
-- bond_payment_hash). Lifecycle states are the same. Slashing is
-- application-level via AgentSlashingEngine (Phase 11B.3) ; this DDL only
-- encodes the storage model.
--
-- Trust tiering (target wiring after P11B.2) :
--   bond < 1000 sats        → bronze : 5/min rate, no credit, no cache writes
--   1000 ≤ bond < 10000     → silver : 30/min rate, credit ≤ bond/2, cache OK
--   bond ≥ 10000            → gold   : 300/min rate, credit ≤ bond, cache OK
-- These tiers are advisory — the actual gating is computed at runtime in
-- Phase 11B.2 (reputation_score modulates tier) and not encoded here.

CREATE TABLE IF NOT EXISTS agent_bonds (
  bond_id BIGSERIAL PRIMARY KEY,
  agent_pubkey TEXT NOT NULL,
  bond_payment_hash TEXT NOT NULL UNIQUE,  -- LN payment hash of the deposit
  bond_committed_sats INTEGER NOT NULL CHECK (bond_committed_sats > 0),
  bond_slashed_sats INTEGER NOT NULL DEFAULT 0,
  bond_pending_sats INTEGER NOT NULL DEFAULT 0,  -- in-flight slashes not yet settled
  min_floor_sats INTEGER NOT NULL DEFAULT 100,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'frozen', 'released')),
  created_at INTEGER NOT NULL,  -- epoch sec
  releasable_at INTEGER NOT NULL,
  released_at INTEGER,           -- set on terminal release
  slashed_total_at INTEGER,      -- set when cumulative slashed reaches committed
  CHECK (bond_slashed_sats + bond_pending_sats <= bond_committed_sats)
);

CREATE INDEX IF NOT EXISTS idx_agent_bonds_agent
  ON agent_bonds (agent_pubkey, state);

CREATE INDEX IF NOT EXISTS idx_agent_bonds_below_floor
  ON agent_bonds (state)
  WHERE state = 'active'
    AND (bond_committed_sats - bond_slashed_sats - bond_pending_sats) < min_floor_sats;

CREATE INDEX IF NOT EXISTS idx_agent_bonds_releasable
  ON agent_bonds (releasable_at)
  WHERE state = 'active';

-- Pending bond deposits — invoice issued but not yet settled. Cleared on
-- settle (row promoted into agent_bonds with bond_payment_hash) or on
-- expire (~24h). Mirrors the pattern used for operator_bonds.
CREATE TABLE IF NOT EXISTS agent_bond_pending_deposits (
  pending_id BIGSERIAL PRIMARY KEY,
  agent_pubkey TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  payment_request TEXT NOT NULL,
  amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_bond_pending_agent
  ON agent_bond_pending_deposits (agent_pubkey, settled_at)
  WHERE settled_at IS NULL;

COMMENT ON TABLE agent_bonds IS
  'Phase 11B.1 (2026-05-04) — Agent stake symmetric to operator_bonds. See project_autonomy_audit_20260504.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (71, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'agent_bonds — Phase 11B.1 : agent stake table symmetric to operator_bonds, blocks Sybil + enables rogue agent eviction')
ON CONFLICT (version) DO NOTHING;
