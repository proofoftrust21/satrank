-- AEPS §8.5 (2026-05-07) — Open observer fork detection.
--
-- Per the whitepaper, the L1 chain is the transparency log : an operator who
-- anchors two different daily Merkle roots for the same UTC day produces two
-- L1 transactions, both public. Any observer scanning operator anchors can
-- detect the inconsistency and publish a fork-evidence Nostr event. The
-- mechanism does not require coordinated witnesses or a federation — only
-- that observation is permissionless and detectable forks are attestable
-- on-chain.
--
-- v0.1 of this schema records :
--   - aeps_observed_anchors : every (operator, day, root) tuple this server
--     has observed, regardless of source (own L1 anchor, ingested from
--     Nostr kind 31403, ingested from a peer's HTTP API).
--   - aeps_fork_events : detected forks, where two observed_anchors with
--     the same (operator_pubkey, day_utc) have different root_hex values.
--
-- Fork events become a slashing trigger per AEPS §10.1 (fork detection,
-- multiplier 5×). v0.1 records the event ; the slashing wire-up to the
-- DLC oracle path lives in a follow-up.

CREATE TABLE IF NOT EXISTS aeps_observed_anchors (
  observation_id BIGSERIAL PRIMARY KEY,
  operator_pubkey TEXT NOT NULL,
  day_utc DATE NOT NULL,
  root_hex TEXT NOT NULL,
  -- Where we observed this anchor : 'self' (this server's own anchor),
  -- 'l1' (from a Bitcoin L1 OP_RETURN scan), 'nostr' (kind 31403 event),
  -- 'http' (peer node's API), 'manual' (operator/admin submitted).
  source TEXT NOT NULL,
  -- Source-specific reference: txid for L1, event_id for Nostr, URL for
  -- HTTP. Used to break ties + audit.
  source_ref TEXT,
  observed_at INTEGER NOT NULL,
  -- Same observation seen twice from same source = idempotent.
  CONSTRAINT aeps_observed_anchors_unique
    UNIQUE (operator_pubkey, day_utc, root_hex, source, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_aeps_observed_anchors_operator_day
  ON aeps_observed_anchors (operator_pubkey, day_utc);

CREATE INDEX IF NOT EXISTS idx_aeps_observed_anchors_observed_at
  ON aeps_observed_anchors (observed_at DESC);

CREATE TABLE IF NOT EXISTS aeps_fork_events (
  fork_event_id BIGSERIAL PRIMARY KEY,
  operator_pubkey TEXT NOT NULL,
  day_utc DATE NOT NULL,
  -- The two competing roots. Lexicographic order (root_hex_a < root_hex_b)
  -- so re-detection from observations in any order produces the same row.
  root_hex_a TEXT NOT NULL,
  root_hex_b TEXT NOT NULL,
  observation_id_a BIGINT NOT NULL REFERENCES aeps_observed_anchors(observation_id),
  observation_id_b BIGINT NOT NULL REFERENCES aeps_observed_anchors(observation_id),
  detected_at INTEGER NOT NULL,
  -- Once published as Nostr fork-event (kind 31410, proposed) this fills in.
  nostr_event_id TEXT,
  nostr_published_at INTEGER,
  -- Once a slashing claim is opened against the operator's bond on the basis
  -- of this fork, this points to the agent_claims row.
  claim_id BIGINT,
  -- Idempotency : one fork event per (operator, day, two distinct roots).
  CONSTRAINT aeps_fork_events_unique UNIQUE (operator_pubkey, day_utc, root_hex_a, root_hex_b),
  -- Sanity : the two roots must differ.
  CONSTRAINT aeps_fork_events_distinct CHECK (root_hex_a <> root_hex_b)
);

CREATE INDEX IF NOT EXISTS idx_aeps_fork_events_operator
  ON aeps_fork_events (operator_pubkey, detected_at DESC);

COMMENT ON TABLE aeps_observed_anchors IS
  'AEPS §8.5 — every (operator, day, root) tuple ever observed, by any source. Inputs to fork detection.';

COMMENT ON TABLE aeps_fork_events IS
  'AEPS §8.5 — forks detected when same (operator, day) yields multiple roots. Slashing trigger per §10.1, multiplier 5×.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (79, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'AEPS §8.5 — observer + fork events (permissionless non-equivocation)')
ON CONFLICT (version) DO NOTHING;
