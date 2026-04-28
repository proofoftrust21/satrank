-- Phase 9.0 + 9.1 — consolidation tracking + peer calibration observations.
--
-- 1. crowd_outcome_reports.consolidated_at — timestamp où le report a été
--    matérialisé dans endpoint_stage_posteriors via le cron de consolidation.
--    NULL = en attente. Délai 1h post-observed pour permettre une fenêtre
--    d'anomaly detection rétroactive avant de pousser dans les posteriors.
--
-- 2. peer_calibration_observations — calibrations kind 30783 publiées par
--    d'autres oracles SatRank-compatible et ingérées via subscribe
--    permanent. Permet aux clients de comparer la calibration prédite par
--    différents oracles (cross-oracle meta-confidence).
--
--    Pas d'UPSERT ici : chaque kind 30783 est un nouveau snapshot d'un
--    fenêtre temporelle distincte (window_start/window_end change à
--    chaque cycle weekly). On veut garder l'historique complet pour
--    l'auditabilité.

ALTER TABLE crowd_outcome_reports
  ADD COLUMN IF NOT EXISTS consolidated_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_crowd_outcomes_consolidation_pending
  ON crowd_outcome_reports (observed_at)
  WHERE consolidated_at IS NULL;

CREATE TABLE IF NOT EXISTS peer_calibration_observations (
  id BIGSERIAL PRIMARY KEY,
  -- Nostr event id (32-byte hex). Dedup key — UNIQUE garantit qu'on
  -- n'enregistre pas le même event 2× (ex. arrivé via 2 relais).
  event_id TEXT UNIQUE NOT NULL,
  -- Pubkey de l'oracle peer qui a publié.
  peer_pubkey TEXT NOT NULL,
  -- Window temporelle annoncée par le peer.
  window_start BIGINT NOT NULL,
  window_end BIGINT NOT NULL,
  -- Stats agrégées extraites des tags de l'event.
  delta_mean DOUBLE PRECISION,
  delta_median DOUBLE PRECISION,
  delta_p95 DOUBLE PRECISION,
  n_endpoints INTEGER NOT NULL DEFAULT 0,
  n_outcomes INTEGER NOT NULL DEFAULT 0,
  observed_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_peer_calibrations_peer
  ON peer_calibration_observations (peer_pubkey, window_end DESC);

CREATE INDEX IF NOT EXISTS idx_peer_calibrations_observed
  ON peer_calibration_observations (observed_at DESC);

INSERT INTO schema_version (version, applied_at, description)
VALUES (55, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 9.0/9.1 - crowd consolidation + peer calibration observations')
ON CONFLICT (version) DO NOTHING;
