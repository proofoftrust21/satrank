-- Phase 7.0 + 7.1 — Federation discovery infrastructure.
--
-- 1. oracle_announcements_published : audit local des kind 30784 que CETTE
--    instance SatRank a émis. Sert à l'idempotence cron + debug.
-- 2. oracle_peers : autres oracles SatRank-compatible découverts via les
--    kind 30784 ingérés sur les relays. UPSERT par pubkey ; le `last_seen`
--    indique la dernière fois qu'on a vu un announcement à jour.
--
-- Schema kind 30784 (proposed parameterized replaceable, NIP-33) :
--   tags:
--     d=satrank-oracle-announcement
--     oracle_pubkey=<32 bytes hex>
--     lnd_pubkey=<33 bytes hex>             (sovereign LN identity)
--     catalogue_size=<int>                  (active trusted endpoints)
--     calibration_event_id=<event_id>       (latest kind 30783, optional)
--     last_assertion_event_id=<event_id>    (latest kind 30782, optional)
--     contact=<nostr or email>              (optional)
--     onboarding_url=<https URL>            (optional)
--   content: JSON detail (about, version, capabilities[])
--
-- Discovery model : SatRank subscribe permanent au filter
--     {kinds: [30784], #d: ['satrank-oracle-announcement']}
-- sur les relays configurés. Chaque event valide → upsert oracle_peers.

CREATE TABLE IF NOT EXISTS oracle_announcements_published (
  id BIGSERIAL PRIMARY KEY,
  -- Event id Nostr de l'announcement émis. NIP-33 replace, donc le row le
  -- plus récent reflète l'état courant.
  event_id TEXT NOT NULL,
  oracle_pubkey TEXT NOT NULL,
  catalogue_size INTEGER NOT NULL DEFAULT 0,
  calibration_event_id TEXT,
  last_assertion_event_id TEXT,
  published_at BIGINT NOT NULL,
  relays TEXT[] NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oracle_announcements_published_at
  ON oracle_announcements_published (published_at DESC);

CREATE TABLE IF NOT EXISTS oracle_peers (
  -- PRIMARY KEY = pubkey Schnorr de l'oracle peer. Unique → UPSERT replace.
  oracle_pubkey TEXT PRIMARY KEY,
  -- LND pubkey (33 bytes hex) annoncé par le peer. Permet aux clients
  -- d'éventuellement vérifier la sovereignty (peer fait tourner son propre
  -- LND, pas un proxy SaaS).
  lnd_pubkey TEXT,
  catalogue_size INTEGER NOT NULL DEFAULT 0,
  -- Pointer vers la dernière calibration kind 30783 du peer. Permet aux
  -- clients de vérifier l'historique avant d'agréger.
  calibration_event_id TEXT,
  last_assertion_event_id TEXT,
  contact TEXT,
  onboarding_url TEXT,
  -- Last announcement received timestamp. Stale si > 7d → afficher avec
  -- une advisory côté /api/oracle/peers, ne pas exclure (le peer peut
  -- juste avoir baissé sa cadence).
  last_seen BIGINT NOT NULL,
  -- First time this peer was observed. Permet aux clients de pondérer
  -- les peers récents avec un peu plus de scepticisme (Sybil-resistance
  -- minimale ; la vraie protection vient via PoW + calibration history).
  first_seen BIGINT NOT NULL,
  -- ID de l'event 30784 le plus récent — permet l'audit "depuis quand
  -- le peer ne re-publie plus".
  latest_announcement_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_oracle_peers_last_seen
  ON oracle_peers (last_seen DESC);

INSERT INTO schema_version (version, applied_at, description)
VALUES (53, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 7.0/7.1 - oracle_announcements_published + oracle_peers (federation discovery)')
ON CONFLICT (version) DO NOTHING;
