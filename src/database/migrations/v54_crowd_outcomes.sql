-- Phase 8.1 — kind 7402 crowd-sourced outcome events.
--
-- Permet à n'importe quel agent (Nostr identity-keyed) de publier un
-- outcome event après avoir consommé un endpoint L402. SatRank ingère
-- ces events avec un Sybil-resistant weighting (PoW + identity-age +
-- preimage-proof) et les écrit pondérés dans endpoint_stage_outcomes_log.
--
-- Schema kind 7402 (proposed, range 7000-7999 NIP-90 job feedback adjacent) :
--   tags:
--     e=<trust_assertion_event_id>           — référence kind 30782 si connue
--     endpoint_url_hash=<64 hex>             — endpoint visé (mandatory)
--     outcome=<delivered|delivery_4xx|delivery_5xx|timeout|pay_failed>
--     preimage=<64 hex>?                     — proof of payment
--     payment_hash=<64 hex>?                 — pour vérifier preimage
--     latency_ms=<int>?                      — observabilité
--     pow=<bits>?                            — declared NIP-13 PoW bits
--     agent_id=<nostr pubkey>?               — pour reputation (optionnel)
--   content: JSON détail (body_size, content_type, error_message)
--
-- Sybil-resistant weighting :
--   base_weight = 0.3
--   pow_factor       = min(2.0, 1.0 + verified_bits / 32)
--   identity_age_factor = min(2.0, 1.0 + days_since_first_seen / 30)
--   preimage_factor  = 2.0 si preimage_valid_against_payment_hash else 1.0
--   total = base × pow × age × preimage
--   Max ≈ 0.3 × 2 × 2 × 2 = 2.4 (≈ poids paid probe SatRank weight=2)
--
-- 1. crowd_outcome_reports : log per-report avec weight calculé.
-- 2. nostr_identity_first_seen : first observation timestamp par pubkey
--    pour la formule identity_age. UPSERT preserves first_seen.

CREATE TABLE IF NOT EXISTS crowd_outcome_reports (
  id BIGSERIAL PRIMARY KEY,
  -- Nostr event id (32-byte hex). PRIMARY identifier dedup.
  event_id TEXT UNIQUE NOT NULL,
  agent_pubkey TEXT NOT NULL,
  endpoint_url_hash TEXT NOT NULL,
  trust_assertion_event_id TEXT,
  outcome TEXT NOT NULL,
  -- Stage du contrat L402 que ce report alimente. 1-5. Default 4 (delivery)
  -- car c'est l'observation la plus naturelle d'un agent end-user.
  stage SMALLINT NOT NULL DEFAULT 4,
  success BOOLEAN NOT NULL,
  -- Weight calculé par CrowdOutcomeIngestor. Persisté pour audit + replay.
  effective_weight DOUBLE PRECISION NOT NULL,
  -- Composantes du weight pour audit.
  pow_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  identity_age_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  preimage_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  declared_pow_bits INTEGER,
  verified_pow_bits INTEGER,
  preimage_verified BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER,
  observed_at BIGINT NOT NULL,
  ingested_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crowd_outcomes_endpoint
  ON crowd_outcome_reports (endpoint_url_hash, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_crowd_outcomes_agent
  ON crowd_outcome_reports (agent_pubkey, observed_at DESC);

CREATE TABLE IF NOT EXISTS nostr_identity_first_seen (
  pubkey TEXT PRIMARY KEY,
  first_seen BIGINT NOT NULL,
  -- Compteur de reports émis — utile pour future signaux de reputation.
  report_count BIGINT NOT NULL DEFAULT 0,
  last_seen BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nostr_identity_first_seen_first
  ON nostr_identity_first_seen (first_seen);

INSERT INTO schema_version (version, applied_at, description)
VALUES (54, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 8.1 - crowd_outcome_reports + nostr_identity_first_seen (web of trust)')
ON CONFLICT (version) DO NOTHING;
