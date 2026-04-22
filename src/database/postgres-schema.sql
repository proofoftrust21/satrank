-- Phase 12B — Postgres 16 consolidated schema (port of SQLite v41)
-- Runs idempotently as a single bootstrap. Version 41 is recorded in schema_version.
--
-- Conversions from SQLite:
--   INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED ALWAYS AS IDENTITY
--   BLOB → BYTEA
--   REAL → DOUBLE PRECISION
--   INTEGER (timestamps / sats) → BIGINT (capacity_sats can exceed 32-bit)
--   boolean-like INTEGER (stale, verified, reachable, body_valid) → INTEGER kept as-is
--     (upgrade to BOOLEAN = Phase 12C, out of scope per B0 decision A)
--   Triggers trg_agents_ratings_check* → CHECK constraints directly on columns

-- ========================================================================
-- Meta
-- ========================================================================

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);

-- ========================================================================
-- Core
-- ========================================================================

CREATE TABLE IF NOT EXISTS agents (
  public_key_hash              TEXT PRIMARY KEY,
  alias                        TEXT,
  first_seen                   BIGINT NOT NULL,
  last_seen                    BIGINT NOT NULL,
  source                       TEXT NOT NULL CHECK (source IN ('attestation', '4tress', 'lightning_graph', 'manual')),
  total_transactions           BIGINT NOT NULL DEFAULT 0,
  total_attestations_received  BIGINT NOT NULL DEFAULT 0,
  avg_score                    DOUBLE PRECISION NOT NULL DEFAULT 0,
  capacity_sats                BIGINT,
  public_key                   TEXT,
  positive_ratings             INTEGER NOT NULL DEFAULT 0 CHECK (positive_ratings >= 0),
  negative_ratings             INTEGER NOT NULL DEFAULT 0 CHECK (negative_ratings >= 0),
  lnplus_rank                  INTEGER NOT NULL DEFAULT 0 CHECK (lnplus_rank >= 0 AND lnplus_rank <= 10),
  query_count                  BIGINT NOT NULL DEFAULT 0,
  hubness_rank                 INTEGER NOT NULL DEFAULT 0 CHECK (hubness_rank >= 0),
  betweenness_rank             INTEGER NOT NULL DEFAULT 0 CHECK (betweenness_rank >= 0),
  hopness_rank                 INTEGER NOT NULL DEFAULT 0 CHECK (hopness_rank >= 0),
  unique_peers                 INTEGER,
  last_queried_at              BIGINT,
  stale                        INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  pagerank_score               DOUBLE PRECISION,
  disabled_channels            INTEGER NOT NULL DEFAULT 0 CHECK (disabled_channels >= 0),
  operator_id                  TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_id          TEXT PRIMARY KEY,
  sender_hash    TEXT NOT NULL REFERENCES agents(public_key_hash),
  receiver_hash  TEXT NOT NULL REFERENCES agents(public_key_hash),
  amount_bucket  TEXT NOT NULL CHECK (amount_bucket IN ('micro', 'small', 'medium', 'large')),
  timestamp      BIGINT NOT NULL,
  payment_hash   TEXT NOT NULL,
  preimage       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('verified', 'pending', 'failed', 'disputed')),
  protocol       TEXT NOT NULL CHECK (protocol IN ('l402', 'keysend', 'bolt11')),
  endpoint_hash  TEXT,
  operator_id    TEXT,
  source         TEXT CHECK (source IS NULL OR source IN ('probe', 'report', 'paid', 'intent')),
  window_bucket  TEXT
);

CREATE TABLE IF NOT EXISTS attestations (
  attestation_id  TEXT PRIMARY KEY,
  tx_id           TEXT NOT NULL REFERENCES transactions(tx_id) ON DELETE CASCADE,
  attester_hash   TEXT NOT NULL REFERENCES agents(public_key_hash),
  subject_hash    TEXT NOT NULL REFERENCES agents(public_key_hash),
  score           INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  tags            TEXT,
  evidence_hash   TEXT,
  timestamp       BIGINT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  verified        INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  weight          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  UNIQUE (tx_id, attester_hash)
);

CREATE TABLE IF NOT EXISTS score_snapshots (
  snapshot_id       TEXT PRIMARY KEY,
  agent_hash        TEXT NOT NULL REFERENCES agents(public_key_hash),
  computed_at       BIGINT NOT NULL,
  posterior_alpha   DOUBLE PRECISION,
  posterior_beta    DOUBLE PRECISION,
  p_success         DOUBLE PRECISION,
  ci95_low          DOUBLE PRECISION,
  ci95_high         DOUBLE PRECISION,
  n_obs             DOUBLE PRECISION,
  "window"          TEXT,
  updated_at        BIGINT
);

CREATE TABLE IF NOT EXISTS probe_results (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_hash          TEXT NOT NULL REFERENCES agents(public_key_hash),
  probed_at            BIGINT NOT NULL,
  reachable            INTEGER NOT NULL DEFAULT 0 CHECK (reachable IN (0, 1)),
  latency_ms           INTEGER,
  hops                 INTEGER,
  estimated_fee_msat   BIGINT,
  failure_reason       TEXT,
  probe_amount_sats    BIGINT DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS channel_snapshots (
  agent_hash     TEXT NOT NULL,
  channel_count  INTEGER NOT NULL,
  capacity_sats  BIGINT NOT NULL,
  snapshot_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_snapshots (
  channel_id     TEXT NOT NULL,
  node1_pub      TEXT NOT NULL,
  node2_pub      TEXT NOT NULL,
  fee_base_msat  BIGINT NOT NULL,
  fee_rate_ppm   INTEGER NOT NULL,
  snapshot_at    BIGINT NOT NULL
);

-- ========================================================================
-- Deposits / L402
-- ========================================================================

CREATE TABLE IF NOT EXISTS deposit_tiers (
  tier_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  min_deposit_sats       BIGINT NOT NULL UNIQUE,
  rate_sats_per_request  DOUBLE PRECISION NOT NULL,
  discount_pct           INTEGER NOT NULL,
  created_at             BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_balance (
  payment_hash            BYTEA PRIMARY KEY,
  remaining               INTEGER NOT NULL DEFAULT 21,
  created_at              BIGINT NOT NULL,
  max_quota               INTEGER,
  rate_sats_per_request   DOUBLE PRECISION,
  tier_id                 BIGINT REFERENCES deposit_tiers(tier_id),
  balance_credits         DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS token_query_log (
  payment_hash  BYTEA NOT NULL,
  target_hash   TEXT NOT NULL,
  decided_at    BIGINT NOT NULL,
  UNIQUE (payment_hash, target_hash)
);

CREATE TABLE IF NOT EXISTS preimage_pool (
  payment_hash        TEXT PRIMARY KEY,
  bolt11_raw          TEXT,
  first_seen          BIGINT NOT NULL,
  confidence_tier     TEXT NOT NULL CHECK (confidence_tier IN ('high', 'medium', 'low')),
  source              TEXT NOT NULL CHECK (source IN ('crawler', 'intent', 'report')),
  consumed_at         BIGINT,
  consumer_report_id  TEXT
);

CREATE TABLE IF NOT EXISTS report_bonus_log (
  reporter_hash        TEXT NOT NULL,
  utc_day              TEXT NOT NULL,
  eligible_count       INTEGER NOT NULL DEFAULT 0,
  bonuses_credited     INTEGER NOT NULL DEFAULT 0,
  total_sats_credited  BIGINT NOT NULL DEFAULT 0,
  last_credit_at       BIGINT,
  PRIMARY KEY (reporter_hash, utc_day)
);

-- ========================================================================
-- Services / endpoints
-- ========================================================================

CREATE TABLE IF NOT EXISTS service_endpoints (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_hash           TEXT,
  url                  TEXT NOT NULL UNIQUE,
  last_http_status     INTEGER,
  last_latency_ms      INTEGER,
  last_checked_at      BIGINT,
  check_count          BIGINT DEFAULT 0,
  success_count        BIGINT DEFAULT 0,
  created_at           BIGINT NOT NULL,
  service_price_sats   BIGINT,
  name                 TEXT,
  description          TEXT,
  category             TEXT,
  provider             TEXT,
  source               TEXT NOT NULL DEFAULT 'ad_hoc',
  operator_id          TEXT
);

CREATE TABLE IF NOT EXISTS service_probes (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url                  TEXT NOT NULL,
  agent_hash           TEXT,
  probed_at            BIGINT NOT NULL,
  paid_sats            BIGINT NOT NULL,
  payment_hash         TEXT,
  http_status          INTEGER,
  body_valid           INTEGER NOT NULL DEFAULT 0 CHECK (body_valid IN (0, 1)),
  response_latency_ms  INTEGER,
  error                TEXT
);

-- ========================================================================
-- Operators
-- ========================================================================

CREATE TABLE IF NOT EXISTS operators (
  operator_id          TEXT PRIMARY KEY,
  first_seen           BIGINT NOT NULL,
  last_activity        BIGINT NOT NULL,
  verification_score   INTEGER NOT NULL DEFAULT 0 CHECK (verification_score >= 0 AND verification_score <= 3),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('verified', 'pending', 'rejected')),
  created_at           BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_identities (
  operator_id          TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
  identity_type        TEXT NOT NULL CHECK (identity_type IN ('ln_pubkey', 'nip05', 'dns')),
  identity_value       TEXT NOT NULL,
  verified_at          BIGINT,
  verification_proof   TEXT,
  PRIMARY KEY (operator_id, identity_type, identity_value)
);

CREATE TABLE IF NOT EXISTS operator_owns_node (
  operator_id   TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
  node_pubkey   TEXT NOT NULL,
  claimed_at    BIGINT NOT NULL,
  verified_at   BIGINT,
  PRIMARY KEY (operator_id, node_pubkey)
);

CREATE TABLE IF NOT EXISTS operator_owns_endpoint (
  operator_id   TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
  url_hash      TEXT NOT NULL,
  claimed_at    BIGINT NOT NULL,
  verified_at   BIGINT,
  PRIMARY KEY (operator_id, url_hash)
);

CREATE TABLE IF NOT EXISTS operator_owns_service (
  operator_id   TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
  service_hash  TEXT NOT NULL,
  claimed_at    BIGINT NOT NULL,
  verified_at   BIGINT,
  PRIMARY KEY (operator_id, service_hash)
);

-- ========================================================================
-- Bayesian streaming (buckets + posteriors)
-- ========================================================================

CREATE TABLE IF NOT EXISTS endpoint_daily_buckets (
  url_hash    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  day         TEXT NOT NULL,
  n_obs       BIGINT NOT NULL DEFAULT 0,
  n_success   BIGINT NOT NULL DEFAULT 0,
  n_failure   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (url_hash, source, day)
);

CREATE TABLE IF NOT EXISTS endpoint_streaming_posteriors (
  url_hash           TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  posterior_alpha    DOUBLE PRECISION NOT NULL,
  posterior_beta     DOUBLE PRECISION NOT NULL,
  last_update_ts     BIGINT NOT NULL,
  total_ingestions   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (url_hash, source)
);

CREATE TABLE IF NOT EXISTS node_daily_buckets (
  pubkey      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  day         TEXT NOT NULL,
  n_obs       BIGINT NOT NULL DEFAULT 0,
  n_success   BIGINT NOT NULL DEFAULT 0,
  n_failure   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (pubkey, source, day)
);

CREATE TABLE IF NOT EXISTS node_streaming_posteriors (
  pubkey             TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  posterior_alpha    DOUBLE PRECISION NOT NULL,
  posterior_beta     DOUBLE PRECISION NOT NULL,
  last_update_ts     BIGINT NOT NULL,
  total_ingestions   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (pubkey, source)
);

CREATE TABLE IF NOT EXISTS operator_daily_buckets (
  operator_id  TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  day          TEXT NOT NULL,
  n_obs        BIGINT NOT NULL DEFAULT 0,
  n_success    BIGINT NOT NULL DEFAULT 0,
  n_failure    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (operator_id, source, day)
);

CREATE TABLE IF NOT EXISTS operator_streaming_posteriors (
  operator_id        TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  posterior_alpha    DOUBLE PRECISION NOT NULL,
  posterior_beta     DOUBLE PRECISION NOT NULL,
  last_update_ts     BIGINT NOT NULL,
  total_ingestions   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (operator_id, source)
);

CREATE TABLE IF NOT EXISTS route_daily_buckets (
  route_hash    TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  caller_hash   TEXT NOT NULL,
  target_hash   TEXT NOT NULL,
  day           TEXT NOT NULL,
  n_obs         BIGINT NOT NULL DEFAULT 0,
  n_success     BIGINT NOT NULL DEFAULT 0,
  n_failure     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (route_hash, source, day)
);

CREATE TABLE IF NOT EXISTS route_streaming_posteriors (
  route_hash         TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  caller_hash        TEXT NOT NULL,
  target_hash        TEXT NOT NULL,
  posterior_alpha    DOUBLE PRECISION NOT NULL,
  posterior_beta     DOUBLE PRECISION NOT NULL,
  last_update_ts     BIGINT NOT NULL,
  total_ingestions   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (route_hash, source)
);

CREATE TABLE IF NOT EXISTS service_daily_buckets (
  service_hash   TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  day            TEXT NOT NULL,
  n_obs          BIGINT NOT NULL DEFAULT 0,
  n_success      BIGINT NOT NULL DEFAULT 0,
  n_failure      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (service_hash, source, day)
);

CREATE TABLE IF NOT EXISTS service_streaming_posteriors (
  service_hash       TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('probe', 'report', 'paid')),
  posterior_alpha    DOUBLE PRECISION NOT NULL,
  posterior_beta     DOUBLE PRECISION NOT NULL,
  last_update_ts     BIGINT NOT NULL,
  total_ingestions   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (service_hash, source)
);

-- ========================================================================
-- Nostr publishing ledger
-- ========================================================================

CREATE TABLE IF NOT EXISTS nostr_published_events (
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('node', 'endpoint', 'service')),
  entity_id           TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  event_kind          INTEGER NOT NULL,
  published_at        BIGINT NOT NULL,
  payload_hash        TEXT NOT NULL,
  verdict             TEXT,
  advisory_level      TEXT,
  p_success           DOUBLE PRECISION,
  n_obs_effective     DOUBLE PRECISION,
  PRIMARY KEY (entity_type, entity_id)
);

-- ========================================================================
-- Indexes (mirror SQLite final state)
-- ========================================================================

CREATE INDEX IF NOT EXISTS idx_agents_alias                ON agents(alias);
CREATE INDEX IF NOT EXISTS idx_agents_operator_id          ON agents(operator_id);
CREATE INDEX IF NOT EXISTS idx_agents_public_key           ON agents(public_key);
CREATE INDEX IF NOT EXISTS idx_agents_score                ON agents(avg_score DESC);
CREATE INDEX IF NOT EXISTS idx_agents_source               ON agents(source);
CREATE INDEX IF NOT EXISTS idx_agents_stale                ON agents(stale);
CREATE INDEX IF NOT EXISTS idx_agents_stale_score          ON agents(stale, avg_score DESC);

CREATE INDEX IF NOT EXISTS idx_attestations_attester                ON attestations(attester_hash);
CREATE INDEX IF NOT EXISTS idx_attestations_attester_subject_time   ON attestations(attester_hash, subject_hash, timestamp);
CREATE INDEX IF NOT EXISTS idx_attestations_category                ON attestations(category);
CREATE INDEX IF NOT EXISTS idx_attestations_subject                 ON attestations(subject_hash);
CREATE INDEX IF NOT EXISTS idx_attestations_timestamp               ON attestations(timestamp);

CREATE INDEX IF NOT EXISTS idx_channel_snapshots_agent    ON channel_snapshots(agent_hash, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_deposit_tiers_min          ON deposit_tiers(min_deposit_sats);

CREATE INDEX IF NOT EXISTS idx_endpoint_buckets_day       ON endpoint_daily_buckets(day);
CREATE INDEX IF NOT EXISTS idx_endpoint_streaming_ts      ON endpoint_streaming_posteriors(last_update_ts);

CREATE INDEX IF NOT EXISTS idx_fee_snapshots_channel      ON fee_snapshots(channel_id, node1_pub, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_fee_snapshots_node         ON fee_snapshots(node1_pub, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_node_buckets_day           ON node_daily_buckets(day);
CREATE INDEX IF NOT EXISTS idx_node_streaming_ts          ON node_streaming_posteriors(last_update_ts);

CREATE INDEX IF NOT EXISTS idx_nostr_published_kind       ON nostr_published_events(event_kind);
CREATE INDEX IF NOT EXISTS idx_nostr_published_updated    ON nostr_published_events(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_buckets_day              ON operator_daily_buckets(day);
CREATE INDEX IF NOT EXISTS idx_operator_identities_value         ON operator_identities(identity_value);
CREATE INDEX IF NOT EXISTS idx_operator_identities_verified_at   ON operator_identities(verified_at);
CREATE INDEX IF NOT EXISTS idx_operator_owns_endpoint_url_hash   ON operator_owns_endpoint(url_hash);
CREATE INDEX IF NOT EXISTS idx_operator_owns_node_pubkey         ON operator_owns_node(node_pubkey);
CREATE INDEX IF NOT EXISTS idx_operator_owns_service_hash        ON operator_owns_service(service_hash);
CREATE INDEX IF NOT EXISTS idx_operator_streaming_ts             ON operator_streaming_posteriors(last_update_ts);
CREATE INDEX IF NOT EXISTS idx_operators_last_activity           ON operators(last_activity);
CREATE INDEX IF NOT EXISTS idx_operators_status                  ON operators(status);

CREATE INDEX IF NOT EXISTS idx_preimage_pool_confidence   ON preimage_pool(confidence_tier);
CREATE INDEX IF NOT EXISTS idx_preimage_pool_consumed     ON preimage_pool(consumed_at);

CREATE INDEX IF NOT EXISTS idx_probe_reachable            ON probe_results(reachable, probed_at);
CREATE INDEX IF NOT EXISTS idx_probe_target               ON probe_results(target_hash);
CREATE INDEX IF NOT EXISTS idx_probe_target_time          ON probe_results(target_hash, probed_at);
CREATE INDEX IF NOT EXISTS idx_probe_time                 ON probe_results(probed_at);

CREATE INDEX IF NOT EXISTS idx_report_bonus_log_day       ON report_bonus_log(utc_day);

CREATE INDEX IF NOT EXISTS idx_route_buckets_day          ON route_daily_buckets(day);
CREATE INDEX IF NOT EXISTS idx_route_streaming_caller     ON route_streaming_posteriors(caller_hash);
CREATE INDEX IF NOT EXISTS idx_route_streaming_target     ON route_streaming_posteriors(target_hash);
CREATE INDEX IF NOT EXISTS idx_route_streaming_ts         ON route_streaming_posteriors(last_update_ts);

CREATE INDEX IF NOT EXISTS idx_service_buckets_day              ON service_daily_buckets(day);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_checked        ON service_endpoints(last_checked_at);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_operator_id    ON service_endpoints(operator_id);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_source         ON service_endpoints(source);
CREATE INDEX IF NOT EXISTS idx_service_endpoints_url            ON service_endpoints(url);
CREATE INDEX IF NOT EXISTS idx_service_probes_url               ON service_probes(url, probed_at);
CREATE INDEX IF NOT EXISTS idx_service_streaming_ts             ON service_streaming_posteriors(last_update_ts);

CREATE INDEX IF NOT EXISTS idx_snapshots_agent            ON score_snapshots(agent_hash);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_computed   ON score_snapshots(agent_hash, computed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_time       ON score_snapshots(agent_hash, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_computed         ON score_snapshots(computed_at);

CREATE INDEX IF NOT EXISTS idx_token_balance_tier         ON token_balance(tier_id);
CREATE INDEX IF NOT EXISTS idx_token_query_log_ph         ON token_query_log(payment_hash);

CREATE INDEX IF NOT EXISTS idx_transactions_endpoint_window   ON transactions(endpoint_hash, window_bucket);
CREATE INDEX IF NOT EXISTS idx_transactions_operator_window   ON transactions(operator_id, window_bucket);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver          ON transactions(receiver_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_sender            ON transactions(sender_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_source            ON transactions(source);
CREATE INDEX IF NOT EXISTS idx_transactions_status            ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp         ON transactions(timestamp);

-- ========================================================================
-- Version marker
-- ========================================================================

INSERT INTO schema_version (version, applied_at, description)
VALUES (41, NOW()::text, 'Phase 12B — Postgres consolidated schema (port of SQLite v41)')
ON CONFLICT (version) DO NOTHING;
