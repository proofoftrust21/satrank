# Phase 12C — Ops issues backlog

Issues opérationnelles non-bloquantes détectées lors de phases antérieures,
à investiguer une fois la prod stabilisée post-cut-over Phase 12B.

---

## Finding A — `score_snapshots.n_obs` BIGINT rejette les valeurs décayées

- **Date :** 2026-04-21
- **Severity :** HIGH — bloquait 100 % des nouveaux snapshots post-cut-over
- **Status :** **RESOLVED in Phase 12B hotfix** (commit `d9128e6`)
- **Issue :** le port v41 a typé `score_snapshots.n_obs` en `BIGINT`, mais
  la colonne reçoit `round3(nObsEffective) = (α + β) − (α₀ + β₀)` après
  décroissance exponentielle τ=7j — une valeur réelle (ex. 0.987), pas
  un compteur entier. Sous typage strict Postgres, chaque insertion
  échouait avec `invalid input syntax for type bigint: "0.987"` et
  `unscoredCount` restait bloqué.
- **Cause racine :** héritage direct du schema SQLite (INTEGER permissif
  acceptait les floats silencieusement) sans revue sémantique au moment
  du port. Le pattern correct existait déjà dans la même DDL :
  `nostr_published_events.n_obs_effective DOUBLE PRECISION`.
- **Fix :**
  1. `ALTER TABLE score_snapshots ALTER COLUMN n_obs TYPE DOUBLE PRECISION
     USING n_obs::double precision` — exécuté sur prod en **128.7 ms**
     (lock ACCESS EXCLUSIVE sous 1 s, conversion sans perte car les
     12 291 lignes pré-existantes avaient toutes `n_obs = 0`).
  2. `src/database/postgres-schema.sql:93` aligné pour les fresh installs
     et le template DB des tests vitest.
  3. `src/tests/snapshotNobsFloat.test.ts` — test de régression couvrant
     0.987 + bornes (0, 42, 12.375, 1 000 000.125).
- **Post-fix :** un cycle rescore a écrit 5 515 nouveaux snapshots (max
  `n_obs = 0.982`), zéro erreur bigint sur les 5 min suivantes, 4 des 5
  agents explicitement bloqués (`fa44376c`, `cb0c2aff`, `ec1c4124`,
  `f35ed6ba`) re-scorés ; le 5ème (`6bea5652`) est en attente du cycle
  suivant, pas d'erreur spécifique.
- **Audit de scope effectué :** les 5 `*_streaming_posteriors` (α/β
  DOUBLE PRECISION ✅, `total_ingestions` BIGINT ✅ — counter brut), les
  5 `*_daily_buckets` (n_obs/success/failure BIGINT ✅ — counters
  entiers par jour), `nostr_published_events.n_obs_effective DOUBLE
  PRECISION` ✅. Aucune autre colonne mal typée sémantiquement.

---

## Finding B — `/api/intent/categories` renvoie une liste vide post-migration

- **Date :** 2026-04-21 (détecté pendant le smoke iso-network Phase 12B B7)
- **Severity :** MEDIUM — n'affecte que `/api/intent` (0 user au moment
  de la détection)
- **Status :** **OPEN** — to be investigated in Phase 12C
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
- **Action Phase 12C :**
  1. Vérifier si `service_endpoints` a des lignes avec `category IS NOT NULL`
     et `agent_hash IS NOT NULL` en prod (`SELECT COUNT(*)` par filtre).
  2. Laisser tourner le crawler une fois et re-tester.
  3. Si toujours vide, auditer le port B3.b du crawler registry
     (`src/crawler/registryCrawler.ts`) + `ServiceEndpointRepository.upsert*`.

---

## Finding D — Observer Protocol sunset

- **Date :** 2026-04-22
- **Severity :** MEDIUM (produit) / HIGH (observabilité)
- **Status :** **RESOLVED** — sunset complet exécuté en Phase 12C
- **Issue :** `api.observerprotocol.org/observer/transactions` retournait
  401 en continu (~1 440 lignes ERROR/WARN par 24 h). Ingestion Observer
  à zéro depuis le cut-over Phase 12B ; impossible de dater le moment
  exact du passage anonymous → auth requis côté upstream. Root-cause
  détaillée dans `OBSERVER-401-INVESTIGATION.md`.
- **Décision produit :** option 2 (désactivation complète + retrait code).
  Motivée par : (a) repositionnement Observer Protocol comme concurrent
  narratif, (b) aucune clé API jamais négociée, (c) env var orpheline
  (`OBSERVER_API_URL` vs `OBSERVER_BASE_URL` mismatch) pointant vers un
  host NXDOMAIN — le coût opérationnel d'un sunset est zéro.
- **Fix :**
  1. Suppression complète du code crawler Observer (client + crawler +
     branches dans services/repositories/tests/scripts).
  2. Enum `AgentSource` : `observer_protocol` → `attestation`.
  3. Enum `BucketSource` : retrait de `observer`.
  4. Purge DB : aucune ligne `source IN ('observer', 'observer_protocol')`
     à supprimer (ingestion à zéro).
  5. Config : retrait `OBSERVER_BASE_URL`, `OBSERVER_TIMEOUT_MS`,
     `CRAWL_INTERVAL_OBSERVER_MS` du schéma zod, `.env.example`, `DEPLOY.md`.
     Retrait de l'orphelin `OBSERVER_API_URL` de `/root/satrank/.env.production`.
  6. Narratif : repositionnement « AI agents » → « autonomous agents on
     Bitcoin Lightning » sur 12 fichiers.
- **Réactivation :** conditionnelle à un partenariat explicite écrit
  entre SatRank et Observer Protocol. Par défaut : **pas de réactivation**.
  Détails dans `OBSERVER-SUNSET.md`.
- **Side-effect observabilité :** les logs crawler sont nettoyés (plus
  d'ERROR/WARN 401 en boucle) ; toute alerte basée sur `level>=error`
  redevient pertinente.

---

## Finding C — `scoringStale: true` pré-existant détecté avant B5

- **Date :** 2026-04-21
- **Severity :** LOW — `dbStatus`, `lndStatus`, `cacheHealth`,
  `schemaVersion` tous OK ; seul le flag staleness est levé
- **Status :** **OPEN** — to be investigated in Phase 12C
- **Issue :** `scoringStale: true` observé sur `/api/health` prod avant
  le cut-over B5. `scoringAgeSec ≈ 42 378` (~12 h). Flip `status: error`
  causé uniquement par cette staleness.
- **Status opérationnel :** accepté, non-bloquant. 0 user impacté au
  moment de la détection. Le fix de Finding A devrait débloquer la
  progression de `computed_at` sur `score_snapshots` et faire retomber
  le flag naturellement au prochain cycle rescore — à vérifier.
- **Action Phase 12C :** à investiguer si le flag persiste après un
  cycle rescore complet post-hotfix (cron calibration ? worker bloqué ?
  condition de staleness trop agressive ?).
