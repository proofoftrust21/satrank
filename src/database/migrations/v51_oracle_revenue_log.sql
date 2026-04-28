-- Phase 6.4 — self-funding loop tracker.
--
-- oracle_revenue_log : append-only log de tous les flux financiers de
-- l'oracle. Permet d'exposer publiquement (/api/oracle/budget) le ratio
-- revenue/spending pour démontrer la durabilité économique de l'oracle.
--
-- Type 'revenue' : crédits entrants (paiements L402 sur /intent fresh=true,
-- /probe, /verdicts, /profile/:id, donations futures).
-- Type 'spending' : sats dépensés (paid probe runner Phase 5.12, futurs
-- crédits operator).
--
-- Source labels :
--   'fresh_query'    — /intent?fresh=true (Mix A+D, 2 sats)
--   'probe_query'    — /probe (5 sats)
--   'verdict_query'  — /verdicts (1 sat)
--   'profile_query'  — /profile/:id (1 sat)
--   'paid_probe'     — paidProbeRunner spending (Phase 5.12)
--   'donation'       — futur, NIP-57 zaps ou direct payments
--   'other'          — fallback
--
-- Métadonnées flexibles (jsonb) pour audit : payment_hash, endpoint_url,
-- intent_canonical, etc. Pas de PII (le payment_hash est public).

CREATE TABLE IF NOT EXISTS oracle_revenue_log (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('revenue', 'spending')),
  source TEXT NOT NULL,
  amount_sats BIGINT NOT NULL CHECK (amount_sats > 0),
  observed_at BIGINT NOT NULL,
  metadata JSONB
);

-- Index pour les queries time-window (lifetime, 30d, 7d).
CREATE INDEX IF NOT EXISTS idx_oracle_revenue_log_observed
  ON oracle_revenue_log (observed_at DESC);

-- Index pour les aggregations par type (revenue vs spending) sur fenêtre.
CREATE INDEX IF NOT EXISTS idx_oracle_revenue_log_type_observed
  ON oracle_revenue_log (type, observed_at DESC);

INSERT INTO schema_version (version, applied_at, description)
VALUES (51, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 6.4 - oracle_revenue_log (self-funding loop tracker)')
ON CONFLICT (version) DO NOTHING;
