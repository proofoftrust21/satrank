# Phase 12C — Ops issues backlog

Issues opérationnelles non-bloquantes détectées lors de phases antérieures,
à investiguer une fois la prod stabilisée post-cut-over Phase 12B.

---

## scoringStale pré-existant détecté avant B5

- **Date :** 2026-04-21
- **Issue :** `scoringStale: true` observé sur `/api/health` prod avant le
  cut-over B5. `scoringAgeSec ≈ 42378` (~12h). Flip `status: error` causé
  uniquement par cette staleness — `dbStatus`, `lndStatus`, `cacheHealth`
  et `schemaVersion` sont OK.
- **Status :** accepté, non-bloquant. 0 user impacté au moment de la détection.
- **Action Phase 12C :** à investiguer (cron calibration ? worker bloqué ?
  condition de staleness trop agressive ?).

---

## `/api/intent/categories` renvoie une liste vide post-migration

- **Date :** 2026-04-21 (détecté pendant le smoke iso-network Phase 12B B7)
- **Issue :** `GET /api/intent/categories` retourne `{ "categories": [] }`
  sur prod après le cut-over B5. Conséquence : `POST /api/intent` rejette
  toute requête avec `INVALID_CATEGORY` (HTTP 400). Les fixtures historiques
  (`data`, `tools`, `bitcoin`) qui fonctionnaient en A6 retournent 400 en B7.
- **Cause probable :** la requête
  `SELECT DISTINCT category FROM service_endpoints WHERE category IS NOT NULL
   AND agent_hash IS NOT NULL AND source IN ('402index', 'self_registered')`
  ne renvoie aucune ligne post-migration. Soit `category`/`agent_hash`/`source`
  n'ont pas été backfillés correctement, soit le crawler n'a pas encore
  repopulé la table, soit l'INSERT crawler vise une autre colonne post-port.
- **Status :** non-bloquant tant que 0 user réel utilise `/api/intent`.
  Latence serveur OK (~45 ms p50), seul le contenu est vide.
- **Action Phase 12C :**
  1. Vérifier si `service_endpoints` a des lignes avec `category IS NOT NULL`
     et `agent_hash IS NOT NULL` en prod (`SELECT COUNT(*)` par filtre).
  2. Laisser tourner le crawler une fois et re-tester.
  3. Si toujours vide, auditer le port B3.b du crawler registry
     (`src/crawler/registryCrawler.ts`) + `ServiceEndpointRepository.upsert*`.
