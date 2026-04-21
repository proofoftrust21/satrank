-- Phase 12B — SQLite final consolidated schema
-- Dumped at 2026-04-21T12:23:03.252Z
-- Source: src/database/migrations.ts (all versions applied)

-- table: agents
CREATE TABLE agents (
        public_key_hash TEXT PRIMARY KEY,
        alias TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('observer_protocol', '4tress', 'lightning_graph', 'manual')),
        total_transactions INTEGER NOT NULL DEFAULT 0,
        total_attestations_received INTEGER NOT NULL DEFAULT 0,
        avg_score REAL NOT NULL DEFAULT 0,
        capacity_sats INTEGER DEFAULT NULL
      , public_key TEXT DEFAULT NULL, positive_ratings INTEGER NOT NULL DEFAULT 0, negative_ratings INTEGER NOT NULL DEFAULT 0, lnplus_rank INTEGER NOT NULL DEFAULT 0, query_count INTEGER NOT NULL DEFAULT 0, hubness_rank INTEGER NOT NULL DEFAULT 0, betweenness_rank INTEGER NOT NULL DEFAULT 0, hopness_rank INTEGER NOT NULL DEFAULT 0, unique_peers INTEGER, last_queried_at INTEGER, stale INTEGER NOT NULL DEFAULT 0, pagerank_score REAL DEFAULT NULL, disabled_channels INTEGER NOT NULL DEFAULT 0, operator_id TEXT);

-- table: attestations
CREATE TABLE "attestations" (
        attestation_id TEXT PRIMARY KEY,
        tx_id TEXT NOT NULL REFERENCES transactions(tx_id) ON DELETE CASCADE,
        attester_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        subject_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
        tags TEXT,
        evidence_hash TEXT,
        timestamp INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'general', verified INTEGER NOT NULL DEFAULT 0, weight REAL NOT NULL DEFAULT 1.0,
        UNIQUE(tx_id, attester_hash)
      );

-- table: channel_snapshots
CREATE TABLE channel_snapshots (
          agent_hash TEXT NOT NULL,
          channel_count INTEGER NOT NULL,
          capacity_sats INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL
        );

-- table: deposit_tiers
CREATE TABLE deposit_tiers (
        tier_id INTEGER PRIMARY KEY AUTOINCREMENT,
        min_deposit_sats INTEGER NOT NULL UNIQUE,
        rate_sats_per_request REAL NOT NULL,
        discount_pct INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

-- table: endpoint_daily_buckets
CREATE TABLE endpoint_daily_buckets (
        url_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid', 'observer')),
        day TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0,
        n_success INTEGER NOT NULL DEFAULT 0,
        n_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (url_hash, source, day)
      );

-- table: endpoint_streaming_posteriors
CREATE TABLE endpoint_streaming_posteriors (
        url_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid')),
        posterior_alpha REAL NOT NULL,
        posterior_beta REAL NOT NULL,
        last_update_ts INTEGER NOT NULL,
        total_ingestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (url_hash, source)
      );

-- table: fee_snapshots
CREATE TABLE fee_snapshots (
          channel_id TEXT NOT NULL,
          node1_pub TEXT NOT NULL,
          node2_pub TEXT NOT NULL,
          fee_base_msat INTEGER NOT NULL,
          fee_rate_ppm INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL
        );

-- table: node_daily_buckets
CREATE TABLE node_daily_buckets (
        pubkey TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid', 'observer')),
        day TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0,
        n_success INTEGER NOT NULL DEFAULT 0,
        n_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pubkey, source, day)
      );

-- table: node_streaming_posteriors
CREATE TABLE node_streaming_posteriors (
        pubkey TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid')),
        posterior_alpha REAL NOT NULL,
        posterior_beta REAL NOT NULL,
        last_update_ts INTEGER NOT NULL,
        total_ingestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pubkey, source)
      );

-- table: nostr_published_events
CREATE TABLE nostr_published_events (
        entity_type TEXT NOT NULL CHECK(entity_type IN ('node', 'endpoint', 'service')),
        entity_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_kind INTEGER NOT NULL,
        published_at INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        verdict TEXT,
        advisory_level TEXT,
        p_success REAL,
        n_obs_effective REAL,
        PRIMARY KEY (entity_type, entity_id)
      );

-- table: operator_daily_buckets
CREATE TABLE operator_daily_buckets (
        operator_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid', 'observer')),
        day TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0,
        n_success INTEGER NOT NULL DEFAULT 0,
        n_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (operator_id, source, day)
      );

-- table: operator_identities
CREATE TABLE operator_identities (
        operator_id TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
        identity_type TEXT NOT NULL CHECK(identity_type IN ('ln_pubkey', 'nip05', 'dns')),
        identity_value TEXT NOT NULL,
        verified_at INTEGER,
        verification_proof TEXT,
        PRIMARY KEY (operator_id, identity_type, identity_value)
      );

-- table: operator_owns_endpoint
CREATE TABLE operator_owns_endpoint (
        operator_id TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
        url_hash TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        verified_at INTEGER,
        PRIMARY KEY (operator_id, url_hash)
      );

-- table: operator_owns_node
CREATE TABLE operator_owns_node (
        operator_id TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
        node_pubkey TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        verified_at INTEGER,
        PRIMARY KEY (operator_id, node_pubkey)
      );

-- table: operator_owns_service
CREATE TABLE operator_owns_service (
        operator_id TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE CASCADE,
        service_hash TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        verified_at INTEGER,
        PRIMARY KEY (operator_id, service_hash)
      );

-- table: operator_streaming_posteriors
CREATE TABLE operator_streaming_posteriors (
        operator_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid')),
        posterior_alpha REAL NOT NULL,
        posterior_beta REAL NOT NULL,
        last_update_ts INTEGER NOT NULL,
        total_ingestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (operator_id, source)
      );

-- table: operators
CREATE TABLE operators (
        operator_id TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        verification_score INTEGER NOT NULL DEFAULT 0 CHECK(verification_score >= 0 AND verification_score <= 3),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('verified', 'pending', 'rejected')),
        created_at INTEGER NOT NULL
      );

-- table: preimage_pool
CREATE TABLE preimage_pool (
        payment_hash TEXT PRIMARY KEY,
        bolt11_raw TEXT,
        first_seen INTEGER NOT NULL,
        confidence_tier TEXT NOT NULL CHECK(confidence_tier IN ('high', 'medium', 'low')),
        source TEXT NOT NULL CHECK(source IN ('crawler', 'intent', 'report')),
        consumed_at INTEGER,
        consumer_report_id TEXT
      );

-- table: probe_results
CREATE TABLE probe_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        probed_at INTEGER NOT NULL,
        reachable INTEGER NOT NULL DEFAULT 0 CHECK(reachable IN (0, 1)),
        latency_ms INTEGER,
        hops INTEGER,
        estimated_fee_msat INTEGER,
        failure_reason TEXT
      , probe_amount_sats INTEGER DEFAULT 1000);

-- table: report_bonus_log
CREATE TABLE report_bonus_log (
        reporter_hash TEXT NOT NULL,
        utc_day TEXT NOT NULL,
        eligible_count INTEGER NOT NULL DEFAULT 0,
        bonuses_credited INTEGER NOT NULL DEFAULT 0,
        total_sats_credited INTEGER NOT NULL DEFAULT 0,
        last_credit_at INTEGER,
        PRIMARY KEY (reporter_hash, utc_day)
      );

-- table: route_daily_buckets
CREATE TABLE route_daily_buckets (
        route_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid', 'observer')),
        caller_hash TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        day TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0,
        n_success INTEGER NOT NULL DEFAULT 0,
        n_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (route_hash, source, day)
      );

-- table: route_streaming_posteriors
CREATE TABLE route_streaming_posteriors (
        route_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid')),
        caller_hash TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        posterior_alpha REAL NOT NULL,
        posterior_beta REAL NOT NULL,
        last_update_ts INTEGER NOT NULL,
        total_ingestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (route_hash, source)
      );

-- table: schema_version
CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );

-- table: score_snapshots
CREATE TABLE score_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        agent_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        computed_at INTEGER NOT NULL
      , posterior_alpha REAL, posterior_beta REAL, p_success REAL, ci95_low REAL, ci95_high REAL, n_obs INTEGER, window TEXT, updated_at INTEGER);

-- table: service_daily_buckets
CREATE TABLE service_daily_buckets (
        service_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid', 'observer')),
        day TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0,
        n_success INTEGER NOT NULL DEFAULT 0,
        n_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_hash, source, day)
      );

-- table: service_endpoints
CREATE TABLE service_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_hash TEXT,
        url TEXT NOT NULL UNIQUE,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        last_checked_at INTEGER,
        check_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      , service_price_sats INTEGER DEFAULT NULL, name TEXT DEFAULT NULL, description TEXT DEFAULT NULL, category TEXT DEFAULT NULL, provider TEXT DEFAULT NULL, source TEXT NOT NULL DEFAULT 'ad_hoc', operator_id TEXT);

-- table: service_probes
CREATE TABLE service_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        agent_hash TEXT,
        probed_at INTEGER NOT NULL,
        paid_sats INTEGER NOT NULL,
        payment_hash TEXT,
        http_status INTEGER,
        body_valid INTEGER NOT NULL DEFAULT 0,
        response_latency_ms INTEGER,
        error TEXT
      );

-- table: service_streaming_posteriors
CREATE TABLE service_streaming_posteriors (
        service_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('probe', 'report', 'paid')),
        posterior_alpha REAL NOT NULL,
        posterior_beta REAL NOT NULL,
        last_update_ts INTEGER NOT NULL,
        total_ingestions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_hash, source)
      );

-- table: token_balance
CREATE TABLE token_balance (
        payment_hash BLOB PRIMARY KEY,
        remaining INTEGER NOT NULL DEFAULT 21,
        created_at INTEGER NOT NULL
      , max_quota INTEGER, rate_sats_per_request REAL, tier_id INTEGER REFERENCES deposit_tiers(tier_id), balance_credits REAL NOT NULL DEFAULT 0);

-- table: token_query_log
CREATE TABLE "token_query_log" (
        payment_hash BLOB NOT NULL,
        target_hash TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        UNIQUE(payment_hash, target_hash)
      );

-- table: transactions
CREATE TABLE "transactions" (
          tx_id TEXT PRIMARY KEY,
          sender_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
          receiver_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
          amount_bucket TEXT NOT NULL CHECK(amount_bucket IN ('micro', 'small', 'medium', 'large')),
          timestamp INTEGER NOT NULL,
          payment_hash TEXT NOT NULL,
          preimage TEXT,
          status TEXT NOT NULL CHECK(status IN ('verified', 'pending', 'failed', 'disputed')),
          protocol TEXT NOT NULL CHECK(protocol IN ('l402', 'keysend', 'bolt11')),
          endpoint_hash TEXT,
          operator_id TEXT,
          source TEXT CHECK(source IS NULL OR source IN ('probe', 'observer', 'report', 'intent', 'paid')),
          window_bucket TEXT
        );

-- index: idx_agents_alias
CREATE INDEX idx_agents_alias ON agents(alias);

-- index: idx_agents_operator_id
CREATE INDEX idx_agents_operator_id ON agents(operator_id);

-- index: idx_agents_public_key
CREATE INDEX idx_agents_public_key ON agents(public_key);

-- index: idx_agents_score
CREATE INDEX idx_agents_score ON agents(avg_score DESC);

-- index: idx_agents_source
CREATE INDEX idx_agents_source ON agents(source);

-- index: idx_agents_stale
CREATE INDEX idx_agents_stale ON agents(stale);

-- index: idx_agents_stale_score
CREATE INDEX idx_agents_stale_score ON agents(stale, avg_score DESC);

-- index: idx_attestations_attester
CREATE INDEX idx_attestations_attester ON attestations(attester_hash);

-- index: idx_attestations_attester_subject_time
CREATE INDEX idx_attestations_attester_subject_time ON attestations(attester_hash, subject_hash, timestamp);

-- index: idx_attestations_category
CREATE INDEX idx_attestations_category ON attestations(category);

-- index: idx_attestations_subject
CREATE INDEX idx_attestations_subject ON attestations(subject_hash);

-- index: idx_attestations_timestamp
CREATE INDEX idx_attestations_timestamp ON attestations(timestamp);

-- index: idx_channel_snapshots_agent
CREATE INDEX idx_channel_snapshots_agent ON channel_snapshots(agent_hash, snapshot_at);

-- index: idx_deposit_tiers_min
CREATE INDEX idx_deposit_tiers_min ON deposit_tiers(min_deposit_sats);

-- index: idx_endpoint_buckets_day
CREATE INDEX idx_endpoint_buckets_day ON endpoint_daily_buckets(day);

-- index: idx_endpoint_streaming_ts
CREATE INDEX idx_endpoint_streaming_ts ON endpoint_streaming_posteriors(last_update_ts);

-- index: idx_fee_snapshots_channel
CREATE INDEX idx_fee_snapshots_channel ON fee_snapshots(channel_id, node1_pub, snapshot_at);

-- index: idx_fee_snapshots_node
CREATE INDEX idx_fee_snapshots_node ON fee_snapshots(node1_pub, snapshot_at);

-- index: idx_node_buckets_day
CREATE INDEX idx_node_buckets_day ON node_daily_buckets(day);

-- index: idx_node_streaming_ts
CREATE INDEX idx_node_streaming_ts ON node_streaming_posteriors(last_update_ts);

-- index: idx_nostr_published_kind
CREATE INDEX idx_nostr_published_kind ON nostr_published_events(event_kind);

-- index: idx_nostr_published_updated
CREATE INDEX idx_nostr_published_updated ON nostr_published_events(published_at DESC);

-- index: idx_operator_buckets_day
CREATE INDEX idx_operator_buckets_day ON operator_daily_buckets(day);

-- index: idx_operator_identities_value
CREATE INDEX idx_operator_identities_value ON operator_identities(identity_value);

-- index: idx_operator_identities_verified_at
CREATE INDEX idx_operator_identities_verified_at ON operator_identities(verified_at);

-- index: idx_operator_owns_endpoint_url_hash
CREATE INDEX idx_operator_owns_endpoint_url_hash ON operator_owns_endpoint(url_hash);

-- index: idx_operator_owns_node_pubkey
CREATE INDEX idx_operator_owns_node_pubkey ON operator_owns_node(node_pubkey);

-- index: idx_operator_owns_service_hash
CREATE INDEX idx_operator_owns_service_hash ON operator_owns_service(service_hash);

-- index: idx_operator_streaming_ts
CREATE INDEX idx_operator_streaming_ts ON operator_streaming_posteriors(last_update_ts);

-- index: idx_operators_last_activity
CREATE INDEX idx_operators_last_activity ON operators(last_activity);

-- index: idx_operators_status
CREATE INDEX idx_operators_status ON operators(status);

-- index: idx_preimage_pool_confidence
CREATE INDEX idx_preimage_pool_confidence ON preimage_pool(confidence_tier);

-- index: idx_preimage_pool_consumed
CREATE INDEX idx_preimage_pool_consumed ON preimage_pool(consumed_at);

-- index: idx_probe_reachable
CREATE INDEX idx_probe_reachable ON probe_results(reachable, probed_at);

-- index: idx_probe_target
CREATE INDEX idx_probe_target ON probe_results(target_hash);

-- index: idx_probe_target_time
CREATE INDEX idx_probe_target_time ON probe_results(target_hash, probed_at);

-- index: idx_probe_time
CREATE INDEX idx_probe_time ON probe_results(probed_at);

-- index: idx_report_bonus_log_day
CREATE INDEX idx_report_bonus_log_day ON report_bonus_log(utc_day);

-- index: idx_route_buckets_day
CREATE INDEX idx_route_buckets_day ON route_daily_buckets(day);

-- index: idx_route_streaming_caller
CREATE INDEX idx_route_streaming_caller ON route_streaming_posteriors(caller_hash);

-- index: idx_route_streaming_target
CREATE INDEX idx_route_streaming_target ON route_streaming_posteriors(target_hash);

-- index: idx_route_streaming_ts
CREATE INDEX idx_route_streaming_ts ON route_streaming_posteriors(last_update_ts);

-- index: idx_service_buckets_day
CREATE INDEX idx_service_buckets_day ON service_daily_buckets(day);

-- index: idx_service_endpoints_checked
CREATE INDEX idx_service_endpoints_checked ON service_endpoints(last_checked_at);

-- index: idx_service_endpoints_operator_id
CREATE INDEX idx_service_endpoints_operator_id ON service_endpoints(operator_id);

-- index: idx_service_endpoints_source
CREATE INDEX idx_service_endpoints_source ON service_endpoints(source);

-- index: idx_service_endpoints_url
CREATE INDEX idx_service_endpoints_url ON service_endpoints(url);

-- index: idx_service_probes_url
CREATE INDEX idx_service_probes_url ON service_probes(url, probed_at);

-- index: idx_service_streaming_ts
CREATE INDEX idx_service_streaming_ts ON service_streaming_posteriors(last_update_ts);

-- index: idx_snapshots_agent
CREATE INDEX idx_snapshots_agent ON score_snapshots(agent_hash);

-- index: idx_snapshots_agent_computed
CREATE INDEX idx_snapshots_agent_computed ON score_snapshots(agent_hash, computed_at);

-- index: idx_snapshots_agent_time
CREATE INDEX idx_snapshots_agent_time ON score_snapshots(agent_hash, computed_at DESC);

-- index: idx_snapshots_computed
CREATE INDEX idx_snapshots_computed ON score_snapshots(computed_at);

-- index: idx_token_balance_tier
CREATE INDEX idx_token_balance_tier ON token_balance(tier_id);

-- index: idx_token_query_log_ph
CREATE INDEX idx_token_query_log_ph ON token_query_log(payment_hash);

-- index: idx_transactions_endpoint_window
CREATE INDEX idx_transactions_endpoint_window ON transactions(endpoint_hash, window_bucket);

-- index: idx_transactions_operator_window
CREATE INDEX idx_transactions_operator_window ON transactions(operator_id, window_bucket);

-- index: idx_transactions_receiver
CREATE INDEX idx_transactions_receiver ON transactions(receiver_hash);

-- index: idx_transactions_sender
CREATE INDEX idx_transactions_sender ON transactions(sender_hash);

-- index: idx_transactions_source
CREATE INDEX idx_transactions_source ON transactions(source);

-- index: idx_transactions_status
CREATE INDEX idx_transactions_status ON transactions(status);

-- index: idx_transactions_timestamp
CREATE INDEX idx_transactions_timestamp ON transactions(timestamp);

-- trigger: trg_agents_ratings_check
CREATE TRIGGER trg_agents_ratings_check
      BEFORE UPDATE ON agents
      FOR EACH ROW
      WHEN NEW.positive_ratings < 0 OR NEW.negative_ratings < 0
        OR NEW.lnplus_rank < 0 OR NEW.lnplus_rank > 10
        OR NEW.hubness_rank < 0 OR NEW.betweenness_rank < 0 OR NEW.hopness_rank < 0
      BEGIN
        SELECT RAISE(ABORT, 'Invalid rating or rank value');
      END;

-- trigger: trg_agents_ratings_check_insert
CREATE TRIGGER trg_agents_ratings_check_insert
      BEFORE INSERT ON agents
      FOR EACH ROW
      WHEN NEW.positive_ratings < 0 OR NEW.negative_ratings < 0
        OR NEW.lnplus_rank < 0 OR NEW.lnplus_rank > 10
        OR NEW.hubness_rank < 0 OR NEW.betweenness_rank < 0 OR NEW.hopness_rank < 0
      BEGIN
        SELECT RAISE(ABORT, 'Invalid rating or rank value');
      END;

-- final schema_version: 41
[14:23:03.249] [32mINFO[39m (69946): [36mMigrations executed successfully[39m
