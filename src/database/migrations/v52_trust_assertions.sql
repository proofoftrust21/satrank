-- Phase 6.2 — kind 30782 trust assertions published log.
--
-- Audit local des trust assertions kind 30782 publiées par l'oracle.
-- Source of truth est la chaîne Nostr (relays) — cette table sert au :
--   - debug interne (latest published per endpoint)
--   - lookup rapide pour /api/oracle/assertion/:url_hash sans toucher
--     les relays (Phase 6.3)
--   - idempotence cron (skip si publié il y a < 6 jours)
--
-- Schema NIP-33 addressable : un seul event actif par (kind, pubkey,
-- d-tag) à un moment donné. Les relais auto-replace les anciens events ;
-- la DB locale ne garde qu'un row par endpoint (UPSERT).

CREATE TABLE IF NOT EXISTS trust_assertions_published (
  endpoint_url_hash TEXT PRIMARY KEY,
  -- Nostr event id (32-byte hex). Permet de retrouver l'event sur les relais.
  event_id TEXT NOT NULL,
  -- Pubkey Schnorr de l'oracle qui a signé. Cohérent avec
  -- NOSTR_PRIVATE_KEY → getPublicKey().
  oracle_pubkey TEXT NOT NULL,
  -- TTL de la trust assertion. valid_until = published_at + 7 jours
  -- par défaut. Les relais et clients doivent rejeter au-delà.
  valid_until BIGINT NOT NULL,
  -- Snapshot des composants au moment du publish, pour audit.
  -- Permet de retrouver pourquoi l'assertion a été émise sans relire le
  -- content du Nostr event.
  p_e2e DOUBLE PRECISION,
  meaningful_stages_count INTEGER NOT NULL DEFAULT 0,
  -- Calibration proof : event_id du dernier kind 30783 publié au moment
  -- du publish. Permet aux agents/oracles de chaîner trust assertion →
  -- calibration history pour valider la crédibilité de l'oracle.
  calibration_proof_event_id TEXT,
  published_at BIGINT NOT NULL,
  -- Liste des relays auquels l'assertion a été publiée avec succès.
  -- Sert au /api/oracle/assertion/:url_hash → renseigne où l'agent peut
  -- aller chercher l'event si non en cache local.
  relays TEXT[]
);

-- Index pour les queries time-window (last_24h, last_7d, etc.).
CREATE INDEX IF NOT EXISTS idx_trust_assertions_published_at
  ON trust_assertions_published (published_at DESC);

-- Index pour les queries par valid_until (cleanup futurs des stale, etc.).
CREATE INDEX IF NOT EXISTS idx_trust_assertions_valid_until
  ON trust_assertions_published (valid_until);

INSERT INTO schema_version (version, applied_at, description)
VALUES (52, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 6.2 - trust_assertions_published (kind 30782 audit)')
ON CONFLICT (version) DO NOTHING;
