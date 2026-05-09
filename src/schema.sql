-- SatRank V3 — minimal schema. 8 tables.
--
-- Run by db.ts on boot. CREATE TABLE IF NOT EXISTS so repeat runs are idempotent.
-- No migrations folder: this file IS the schema. Older rows from V2 tables
-- can be carried over by inserting INTO V3 tables (out-of-band SQL script).

-- 1. Catalogue. The crawler upserts here.
CREATE TABLE IF NOT EXISTS service_endpoints (
  url_hash      TEXT PRIMARY KEY,                          -- sha256(url) hex
  url           TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  http_method   TEXT NOT NULL DEFAULT 'GET' CHECK (http_method IN ('GET', 'POST', 'PUT', 'DELETE')),
  price_sats    INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL,                             -- 'l402_directory' | 'rss' | 'dns' | 'manual'
  added_at      BIGINT NOT NULL,
  last_probe_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_category ON service_endpoints(category);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_last_probe ON service_endpoints(last_probe_at);

-- The CHECK in CREATE TABLE only applies on first creation. For instances
-- that bootstrapped before 2026-05-09 (when the CHECK was added), apply it
-- via ALTER TABLE — guarded so repeat boots don't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'http_method_check' AND conrelid = 'service_endpoints'::regclass
  ) THEN
    ALTER TABLE service_endpoints
      ADD CONSTRAINT http_method_check CHECK (http_method IN ('GET','POST','PUT','DELETE'));
  END IF;
END$$;

-- 2. Per-(endpoint, stage) Bayesian posterior. Streaming Beta(α,β).
CREATE TABLE IF NOT EXISTS endpoint_posteriors (
  url_hash    TEXT NOT NULL,
  stage       TEXT NOT NULL,                               -- 'challenge' | 'invoice' | 'payment' | 'delivery' | 'quality'
  alpha       DOUBLE PRECISION NOT NULL DEFAULT 1.0,       -- Beta(1,1) prior
  beta        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  n_obs       INTEGER NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (url_hash, stage),
  FOREIGN KEY (url_hash) REFERENCES service_endpoints(url_hash) ON DELETE CASCADE
);

-- 3. Probe history. One row per probe attempt. Keeps median latency tractable.
CREATE TABLE IF NOT EXISTS endpoint_observations (
  id              BIGSERIAL PRIMARY KEY,
  url_hash        TEXT NOT NULL REFERENCES service_endpoints(url_hash) ON DELETE CASCADE,
  observed_at     BIGINT NOT NULL,
  challenge_ok   BOOLEAN NOT NULL,
  invoice_ok     BOOLEAN NOT NULL,
  payment_ok     BOOLEAN,                                   -- NULL when probe was unpaid
  delivery_ok    BOOLEAN,
  quality_ok     BOOLEAN,
  latency_ms      INTEGER NOT NULL,
  http_status     INTEGER,
  body_sha256     TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_url_observed
  ON endpoint_observations (url_hash, observed_at DESC);

-- 4. Paid probe budget log (transparency). Each paid probe writes its sats spent.
CREATE TABLE IF NOT EXISTS paid_probe_results (
  payment_hash    TEXT PRIMARY KEY,
  url_hash        TEXT NOT NULL REFERENCES service_endpoints(url_hash) ON DELETE CASCADE,
  invoice_sats    INTEGER NOT NULL,
  delivery_ok     BOOLEAN NOT NULL,
  paid_at         BIGINT NOT NULL,
  preimage        TEXT
);
CREATE INDEX IF NOT EXISTS idx_paid_probe_paid_at ON paid_probe_results(paid_at DESC);

-- 5. Signed Nostr trust assertions (kind 30782) we have published.
CREATE TABLE IF NOT EXISTS attestations (
  event_id        TEXT PRIMARY KEY,                        -- 32-byte hex Nostr id
  url_hash        TEXT NOT NULL REFERENCES service_endpoints(url_hash) ON DELETE CASCADE,
  oracle_pubkey   TEXT NOT NULL,                           -- 32-byte hex
  p_e2e           DOUBLE PRECISION NOT NULL,
  n_obs           INTEGER NOT NULL,
  valid_until     BIGINT NOT NULL,
  raw_event       JSONB NOT NULL,                          -- full Nostr event for re-publish
  published_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attestations_url_hash ON attestations(url_hash, published_at DESC);

-- 6. Daily Merkle anchor of evidence_receipts (compatibility shim ; stays minimal).
CREATE TABLE IF NOT EXISTS daily_anchors (
  day_utc       TEXT PRIMARY KEY,                          -- 'YYYY-MM-DD'
  merkle_root   TEXT NOT NULL,                             -- 32-byte hex
  n_leaves      INTEGER NOT NULL,
  computed_at   BIGINT NOT NULL,
  l1_txid       TEXT,                                       -- when broadcast to bitcoin L1
  l1_broadcast_at BIGINT
);

-- 7. Revenue log (budget transparency). One row per paid /api/intent.
CREATE TABLE IF NOT EXISTS revenue_log (
  payment_hash   TEXT PRIMARY KEY,
  route          TEXT NOT NULL,                             -- '/intent' for now
  sats_received  INTEGER NOT NULL,
  received_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_received_at ON revenue_log(received_at DESC);

-- 8. Optional consumer registry. NIP-05 style. Tracks volume per pubkey.
CREATE TABLE IF NOT EXISTS agents (
  pubkey         TEXT PRIMARY KEY,                         -- 32-byte hex
  first_seen     BIGINT NOT NULL,
  last_seen      BIGINT NOT NULL,
  query_count    INTEGER NOT NULL DEFAULT 0
);
