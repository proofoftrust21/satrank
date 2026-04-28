-- Phase 5.15 — calibration moat. Deux nouvelles tables :
--
-- 1. endpoint_stage_outcomes_log — log par-observation des stages 2-5.
--    Chaque observation paid/free écrite par invoiceValidityService et
--    paidProbeRunner est aussi insérée ici, avec timestamp précis. Sert
--    à reconstruire les fenêtres temporelles (ex. "successes des 7
--    derniers jours") sans dépendre du modèle de décroissance des
--    streaming posteriors.
--
--    Stage 1 (challenge) reste mesuré via endpoint_streaming_posteriors
--    source='probe' jusqu'à un futur backfill ; on ne loggue ici que les
--    stages 2-5 qui sont la cible directe de la calibration.
--
-- 2. oracle_calibration_runs — audit local des runs hebdo. Le source of
--    truth public est la chaîne Nostr (kind 30783) ; cette table sert au
--    debug interne, à la consultation API future, et à l'idempotence
--    (ne pas re-publier deux fois la même semaine).

CREATE TABLE IF NOT EXISTS endpoint_stage_outcomes_log (
  id BIGSERIAL PRIMARY KEY,
  endpoint_url_hash TEXT NOT NULL,
  stage SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 5),
  success BOOLEAN NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  -- Outcome textuel pour debug : 'valid' / 'decode_failed' / 'pay_ok' /
  -- 'delivery_4xx' / 'quality_low' / etc. Cf. enums dans paidProbeRunner.
  outcome_label TEXT,
  observed_at BIGINT NOT NULL
);

-- Index pour queries time-window (calibration cron : "outcomes des 7d").
CREATE INDEX IF NOT EXISTS idx_outcomes_log_time
  ON endpoint_stage_outcomes_log (observed_at);

-- Index pour queries per-endpoint (audit, debug).
CREATE INDEX IF NOT EXISTS idx_outcomes_log_endpoint_stage
  ON endpoint_stage_outcomes_log (endpoint_url_hash, stage, observed_at);

CREATE TABLE IF NOT EXISTS oracle_calibration_runs (
  id BIGSERIAL PRIMARY KEY,
  -- Fenêtre temporelle évaluée. window_end - window_start = window_days.
  window_start BIGINT NOT NULL,
  window_end BIGINT NOT NULL,
  -- Statistiques agrégées du delta |p_predicted - p_observed| par endpoint.
  delta_mean DOUBLE PRECISION,
  delta_median DOUBLE PRECISION,
  delta_p95 DOUBLE PRECISION,
  -- Combien d'endpoints/outcomes ont contribué au calcul ; n_endpoints=0
  -- est légitime pendant la phase de bootstrap (pas encore d'outcomes).
  n_endpoints INTEGER NOT NULL DEFAULT 0,
  n_outcomes INTEGER NOT NULL DEFAULT 0,
  -- ID de l'event Nostr kind 30783 publié (32 bytes hex). NULL pendant la
  -- phase compute → publish. Permet de retrouver l'event sur le relais.
  published_event_id TEXT,
  -- Timestamp d'insertion locale (debug only ; le source of truth temporel
  -- est window_end + Nostr created_at).
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calibration_runs_window
  ON oracle_calibration_runs (window_end DESC);

INSERT INTO schema_version (version, applied_at, description)
VALUES (50, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 5.15 - outcomes log + oracle calibration runs (the moat)')
ON CONFLICT (version) DO NOTHING;
