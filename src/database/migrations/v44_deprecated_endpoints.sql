-- Vague 3 Phase 2.6 — flag fossiles 404 et autres endpoints à exclure du
-- ranking sans les supprimer. Permet la réversibilité automatique : si un
-- provider revient en ligne, le crawler re-flag deprecated=false.
ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deprecated_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS consecutive_404_count INTEGER NOT NULL DEFAULT 0;

-- Partial index — la plupart des rows sont not-deprecated et la majorité des
-- queries filtrent WHERE deprecated = FALSE, donc on indexe seulement le
-- subset utile.
CREATE INDEX IF NOT EXISTS idx_service_endpoints_not_deprecated
  ON service_endpoints (deprecated)
  WHERE deprecated = FALSE;

INSERT INTO schema_version (version, applied_at, description)
VALUES (44, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Vague 3 Phase 2.6 - deprecated flag + consecutive_404_count for fossile auto-pruning');
