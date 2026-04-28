-- Phase 5.14 — endpoint_stage_posteriors : un Beta(α, β) par stage du contrat
-- L402, par endpoint. Hub structurel du PR-1 "5-stage foundation".
--
-- Stages :
--   1 = challenge       — l'endpoint répond 402 avec WWW-Authenticate parseable
--                          (mesuré aujourd'hui via endpoint_streaming_posteriors,
--                          source 'probe'). Cette table le ré-aggrège dans le
--                          schéma 5-stage uniformisé.
--   2 = invoice_validity — BOLT11 décodable, payee routable, montant cohérent,
--                          non-expiré (Phase 5.11, gratuit).
--   3 = payment          — invoice settled, preimage retourné (Phase 5.12, paid).
--   4 = delivery         — recall HTTP 2xx, body non-vide, content-type cohérent
--                          (Phase 5.12, side-effect du paid probe).
--   5 = quality          — schema-valid (5a) OU heuristiques body (5b) OU
--                          crowd-sourced NIP-85 (5c, déféré au PR-5).
--
-- Composition (chain rule multiplicatif, calculée côté service) :
--   p_e2e = produit des p_i pour les stages avec n_obs effectif >= threshold.
--   Stages sans données → exclus de la composition (pas multiplier par 0.5
--   prior, ce qui pénaliserait à tort les endpoints sains).
--
-- Une row par (endpoint_url_hash, stage). Idempotent : ON CONFLICT update les
-- αβ, last_updated et n_obs. Le cleanup est implicit via TAU_DAYS decay côté
-- service (pas de TTL au niveau row).

CREATE TABLE IF NOT EXISTS endpoint_stage_posteriors (
  endpoint_url_hash TEXT NOT NULL,
  stage SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 5),
  -- α et β du Beta-Binomial. Defaults Beta(1.5, 1.5) = prior légèrement
  -- informatif, identique à DEFAULT_PRIOR_ALPHA/BETA dans bayesianConfig.ts.
  alpha DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  beta DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  -- Compteur d'observations (avec décroissance exponentielle τ=7d appliquée
  -- côté écriture). n_obs_effective = (α + β) − (α₀ + β₀) sert à gater
  -- l'inclusion dans la composition (threshold = IS_MEANINGFUL_MIN_N_OBS).
  n_obs DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Epoch seconds, dernière mise à jour. Drives la décroissance temporelle
  -- au moment de la lecture (decay-at-read).
  last_updated BIGINT NOT NULL,
  PRIMARY KEY (endpoint_url_hash, stage)
);

-- Index pour le lookup all-stages-of-one-endpoint (charge typique :
-- intentService construit le candidate, lit les 5 stages d'un endpoint).
CREATE INDEX IF NOT EXISTS idx_stage_posteriors_url
  ON endpoint_stage_posteriors (endpoint_url_hash);

-- Index pour le scan par stage (utilisé par les calibration crons et les
-- statistiques d'aggregate cross-endpoint, ex. mean p_4_delivery).
CREATE INDEX IF NOT EXISTS idx_stage_posteriors_stage
  ON endpoint_stage_posteriors (stage);

INSERT INTO schema_version (version, applied_at, description)
VALUES (49, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 5.14 - endpoint_stage_posteriors (5-stage L402 contract hub)')
ON CONFLICT (version) DO NOTHING;
