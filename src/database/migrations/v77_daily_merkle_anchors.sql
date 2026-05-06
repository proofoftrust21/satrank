-- AEPS §8 (2026-05-07) — Daily Merkle anchor of evidence_receipts to Bitcoin L1.
--
-- Each UTC day, an operator (this server, in its role as an AEPS operator)
-- aggregates all evidence_receipts issued in that day into an RFC 6962
-- Merkle tree. The root is published in OP_RETURN on Bitcoin L1, signed by
-- the operator's bond root key. The L1 transaction is the trust root: any
-- agent or auditor can verify a receipt by fetching the daily root from the
-- L1 anchor and computing the Merkle inclusion proof.
--
-- L1 broadcast is gated by env L1_ANCHOR_ENABLED (default false). Until
-- enabled, the table records the computed root + receipt count + computed_at
-- so verification still works for any party that ingests our root via the
-- /api/aeps/evidence/daily-anchor endpoint.
--
-- Idempotency: one anchor per (day_utc, operator_pubkey).
--
-- Reference: spec/AEPS-whitepaper.md §8.

CREATE TABLE IF NOT EXISTS daily_merkle_anchors (
  anchor_id BIGSERIAL PRIMARY KEY,
  -- The UTC date this anchor covers (YYYY-MM-DD).
  day_utc DATE NOT NULL,
  -- The operator anchoring this root. For SatRank-as-operator, this is the
  -- SignerService public key. For multi-operator deployments, this is the
  -- specific operator's pubkey.
  operator_pubkey TEXT NOT NULL,
  -- 32-byte SHA-256 root, hex (64 chars).
  root_hex TEXT NOT NULL,
  -- Number of evidence_receipts included in this Merkle tree.
  receipt_count INTEGER NOT NULL,
  -- Bookkeeping: the inclusive range of receipt_id values in this tree
  -- (NULL when receipt_count = 0).
  receipt_first_id BIGINT,
  receipt_last_id BIGINT,
  -- Bitcoin L1 anchor (populated when L1_ANCHOR_ENABLED + tx broadcast).
  -- l1_txid is 32-byte hex (64 chars). l1_op_return_hex is the raw OP_RETURN
  -- payload bytes hex-encoded (45 bytes = 90 chars).
  l1_txid TEXT,
  l1_block_height INTEGER,
  l1_op_return_hex TEXT,
  l1_broadcast_at INTEGER,
  -- Nostr publication of the anchor (kind 31403, proposed). 32-byte hex.
  nostr_event_id TEXT,
  nostr_published_at INTEGER,
  -- When the local computation completed.
  computed_at INTEGER NOT NULL,
  -- One anchor per (day, operator).
  CONSTRAINT daily_merkle_anchors_unique UNIQUE (day_utc, operator_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_daily_merkle_anchors_day
  ON daily_merkle_anchors (day_utc DESC);

CREATE INDEX IF NOT EXISTS idx_daily_merkle_anchors_operator
  ON daily_merkle_anchors (operator_pubkey, day_utc DESC);

CREATE INDEX IF NOT EXISTS idx_daily_merkle_anchors_l1_txid
  ON daily_merkle_anchors (l1_txid)
  WHERE l1_txid IS NOT NULL;

COMMENT ON TABLE daily_merkle_anchors IS
  'AEPS §8 — daily Merkle root over evidence_receipts. OP_RETURN broadcast to Bitcoin L1 is the trust root. See spec/AEPS-whitepaper.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (77, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'AEPS §8 — daily_merkle_anchors (Bitcoin L1 trust root for evidence)')
ON CONFLICT (version) DO NOTHING;
