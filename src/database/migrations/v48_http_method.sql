-- Phase 5.10A — persist http_method on service_endpoints.
--
-- Le crawler 402index expose http_method par entrée (540 GET / 584 POST
-- observés 2026-04-27, cf. registryCrawler.ts:39-45). Le champ est parsé
-- (`IndexService.http_method`) et utilisé transitoirement dans
-- `discoverNodeFromUrl` pour la stratégie GET-first / POST-fallback, mais
-- il n'est jamais persisté sur service_endpoints. Conséquence : tout caller
-- en aval (intentService, decideService, SDK fulfill) traite chaque endpoint
-- comme méthode-less et défaut sur GET, ce qui fait échouer silencieusement
-- les 444 entrées POST-only de llm402.ai et les ~50% des entrées au global.
--
-- Cette migration ajoute la colonne avec un DEFAULT sûr ('GET') pour que les
-- 345 rows existantes restent valides immédiatement. Le crawler suivant
-- pousse le vrai http_method via upsertUpstreamSignals (cf. PR associé).
-- Idempotent : ADD COLUMN IF NOT EXISTS est un no-op au second passage.

ALTER TABLE service_endpoints
  ADD COLUMN IF NOT EXISTS http_method TEXT NOT NULL DEFAULT 'GET'
  CHECK (http_method IN ('GET', 'POST'));

CREATE INDEX IF NOT EXISTS idx_service_endpoints_http_method
  ON service_endpoints (http_method);

INSERT INTO schema_version (version, applied_at, description)
VALUES (48, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 5.10A - persist http_method on service_endpoints (catalogue completeness)')
ON CONFLICT (version) DO NOTHING;
