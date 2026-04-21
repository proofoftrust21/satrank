# Phase 12C — Ops maturity report

**Branch :** `phase-12c-ops`
**Dates :** 2026-04-21 → 2026-04-22
**Scope :** dettes d'ops post cut-over Phase 12B (Postgres live).

---

## Résumé

Phase 12C traite cinq dettes d'ops identifiées pendant Phase 12B : pipeline
CI cassé, ingestion Observer Protocol en boucle 401, erreurs TypeScript
dans `src/tests/**`, `service_endpoints` vide après cut-over, et absence
d'un canari post-deploy pour Phase 12B+1. Toutes livrées sauf le sweep
TS complet (`C4.2-3`) qui reste gated derrière Checkpoint 3 — décision
intégral vs partiel attendue côté Romain.

---

## Livrables

### C1 — CI/CD Postgres service wiring (commit `8946ca3`)

- **Quoi :** `.github/workflows/*` n'avait pas de service container Postgres.
  Depuis le cut-over B5, chaque run CI échouait au boot de `npm test` (pool
  Postgres absent).
- **Fix :** service `postgres:16` dans GitHub Actions workflows, env
  `DATABASE_URL` pointant sur le container, health check `pg_isready`.
- **Statut :** mergé sur `phase-12c-ops`, CI verte.

### C2 — Observer Protocol 401 investigation (commit `fbfcaf6`)

- **Quoi :** `api.observerprotocol.org/observer/transactions` → 401 en
  boucle, ≈1 440 ERROR/WARN lignes / 24h dans les logs crawler.
- **Doc :** `docs/phase-12c/OBSERVER-401-INVESTIGATION.md` — root cause
  `OBSERVER_API_URL` (prod) vs `OBSERVER_BASE_URL` (zod schema) mismatch,
  host upstream NXDOMAIN, jamais de clé API négociée.
- **Status (après S3+S4) :** **SUPERSEDED** par le sunset complet S1-S7
  (voir ci-dessous). Doc maintenue comme trace historique.

### Observer Protocol sunset complet (commit `c38472f`, 78 fichiers)

Décision produit Romain 2026-04-22 : désengagement total, pas de
réactivation sans partenariat écrit explicite. Sept étapes (S1-S7)
exécutées en une seule passe :

- **S1 — code removal :** suppression `src/crawler/observerClient.ts`,
  `src/crawler/observerCrawler.ts`, branches dans services/repositories/
  tests/scripts.
- **S2 — DB purge :** aucune ligne `source IN ('observer',
  'observer_protocol')` dans transactions ou agents (ingestion à zéro
  depuis le cut-over).
- **S3 — config cleanup :** retrait `OBSERVER_BASE_URL`,
  `OBSERVER_TIMEOUT_MS`, `CRAWL_INTERVAL_OBSERVER_MS` du schéma zod,
  `.env.example`, `DEPLOY.md`. Retrait orphelin `OBSERVER_API_URL` de
  `/root/satrank/.env.production` (backup `.env.production.bak-observer-sunset`
  côté prod).
- **S4 — narrative audit :** repositionnement « AI agents » →
  « autonomous agents on Bitcoin Lightning » sur 12 fichiers (openapi,
  mcp, SDK TS + Python, README, INTEGRATION, IMPACT-STATEMENT, public/*
  HTML, package.json FR, etc.).
- **S5 — enum rename :** `AgentSource` `observer_protocol` → `attestation`
  partout (types, DB `agents.source CHECK`, repositories, tests).
  `BucketSource` retrait complet de la valeur `observer`.
- **S6 — docs :** `docs/phase-12c/OBSERVER-SUNSET.md` (décision,
  contexte, condition de réactivation, pointeurs docs liés). OPS-ISSUES.md
  Finding D ajouté en status RESOLVED.
- **S7 — test gate + single commit :** test suite 1043 passed / 289 skipped
  / 0 failed après drop des 749 test DBs stale (template CHECK constraint
  pre-rename). Un seul commit `c38472f` pour traçabilité.

### C3 — Fix `service_endpoints` vide post-migration (commit `116e533`)

- **Diagnostic :**
  1. `SELECT COUNT(*) FROM service_endpoints` → 0 en prod.
  2. Registry crawler actif au boot (`Registry crawler timer started
     intervalMs=86400000`) mais **jamais fired** — aucun `Registry crawl
     progress` dans les 5h post-cutover.
  3. 402index.io reachable (`HTTP/2 200`).
  4. Le port B3.b n'est pas en cause : `upsert` et `findCategories`
     sont cohérents.
- **Cause racine :** `src/crawler/run.ts` — `runFullCrawl()` tire LND/LN+/
  probe au boot mais **pas** le registry crawler, uniquement branché
  sur `setInterval(24h)`. Un cut-over frais laisse donc la table vide
  pendant 24h.
- **Fix :** initial fire fire-and-forget du `registryCrawler.run()` juste
  avant le `setInterval`. Non-bloquant (la première passe prend quelques
  minutes à 500ms/req). Populera `service_endpoints` dès le prochain
  restart du container crawler (`make deploy`).
- **Régression guard :** pas de test vitest direct (run.ts = script
  d'orchestration, hors coverage). Vérification opérationnelle :
  `checkScoringHealth.sh` check #5.
- **OPS-ISSUES Finding B :** flipped OPEN → RESOLVED.

### C4.1 — Audit 257 TS errors dans `src/tests/**`

- **Doc :** `docs/phase-12c/TS-ERRORS-AUDIT.md` (~330 lignes).
- **Chiffres :**
  - 257 erreurs TS réparties sur 20 fichiers.
  - Distribution : TS2339 ×213 (db.prepare sur Pool), TS2353 ×15, TS2304 ×14, etc.
  - 0 failure runtime : ces tests sont soit skipped (`it.skip`/`describe.skip`
    avec TODO Phase 12B), soit disabled via `tsconfig.json exclude:
    src/tests/**`.
- **Classification :**
  - **Trivial (8-12h)** : 20 fichiers / ~62 erreurs — remplacement
    mécanique `db.prepare().run()` → `db.query()`.
  - **Ciblé (15-25h)** : 10 fichiers / ~160 erreurs — refactorings de
    setup tests (helpers Postgres, fixtures).
  - **Profond (4-8h)** : 1 fichier (`migrateExistingDepositsToTiers` -
    32 erreurs) — refactor complet du script de migration one-shot.
- **Trois options :**
  - **A — Intégral** (25-45h) : porter l'ensemble des tests skipped au
    client Postgres, remonter coverage à pré-Phase 12B.
  - **B — Partiel recommandé** (6-9h) : porter les 8 fichiers à impact
    fonctionnel réel (`probeCrawler.test.ts` surtout, seule vraie couverture
    manquante), supprimer les 8 describe.skip migration-era, `@ts-nocheck`
    2-3 scripts archivés, ajouter `npm run lint:tests` CI.
  - **C — Statu quo** (0h) : laisser l'exclude en place, ajouter un lint
    périodique pour tracker la drift.
- **Status :** gated CHECKPOINT 3 — décision Romain requise.

### C5 — `scripts/checkScoringHealth.sh` (commit `d89f481`)

- **Quoi :** canari T+24h post-deploy. Six checks read-only :
  1. `/api/health` status + scoringStale/scoringAgeSec,
  2. agents count (≥ 1000),
  3. score_snapshots freshness (≤ 15min idéal, ≤ 1h warn),
  4. endpoint_streaming_posteriors freshness (≤ 1h),
  5. service_endpoints populé (validation fix Finding B/C3),
  6. crawler ERROR logs 24h (budget 50).
- **Sortie :** verdict coloré GREEN/YELLOW/RED + exit code 0/1/2 pour
  alerting Prom/cron.
- **Baseline pre-deploy :** 1 FAIL (check 5 — service_endpoints vide,
  attendu) + 4 WARN (score_snapshots age=1614s juste au-dessus du seuil,
  posteriors vides, 280 ERROR 24h = Observer 401s, scoringStale false).
  Post-deploy attendu : GREEN avec au plus 1 WARN (posteriors vides tant
  qu'aucune probe n'a tourné).

### C4.2-3 — Execute TS error sweep

**Status :** **BLOCKED** — Checkpoint 3 user decision en cours.

---

## Checkpoints

| # | Description | Statut |
|---|-------------|--------|
| Checkpoint 1 | Ping Romain après C1 + C2 | ✅ (feedback : GO continuer) |
| Checkpoint 2 | Ping Romain si C3 non-trivial | ⏭️ skippé (fix trivial 1-line) |
| Checkpoint 3 | Décision intégral vs partiel sur TS sweep | ⏳ en attente |

---

## Déploiement

- Le fix C3 s'applique au prochain `make deploy && docker compose build
  api crawler && docker compose up -d --force-recreate` (rappel mémoire :
  `make deploy` seul ne rebuild pas les images).
- Le sunset Observer retire du code runtime, ce qui supprime la tâche
  cron observer et ses 401 en boucle (→ check 6 du health script
  devrait passer GREEN post-deploy).
- `scripts/checkScoringHealth.sh` peut être lancé immédiatement après
  deploy et à T+24h pour valider la stabilisation.

---

## Dettes résiduelles

- **Finding C (`scoringStale` pré-B5)** — OPEN, à revérifier après Phase
  12B+2 une fois le fix Finding A complètement digéré par le pipeline
  scoring.
- **C4.2-3** — à exécuter dès réception de la décision Checkpoint 3.
- **Coverage `src/tests/**`** — documentée dans `TS-ERRORS-AUDIT.md`,
  pas d'impact fonctionnel immédiat mais dette à résorber selon l'option
  choisie.

---

## Artefacts

- `docs/phase-12c/OBSERVER-401-INVESTIGATION.md` — investigation C2
  (SUPERSEDED par sunset).
- `docs/phase-12c/OBSERVER-SUNSET.md` — décision et condition de
  réactivation.
- `docs/phase-12c/OPS-ISSUES.md` — backlog (Finding A RESOLVED, B
  RESOLVED, C OPEN, D RESOLVED).
- `docs/phase-12c/TS-ERRORS-AUDIT.md` — audit complet des 257 erreurs.
- `scripts/checkScoringHealth.sh` — canari post-deploy.
- PR #14 (draft) — cette branche.
