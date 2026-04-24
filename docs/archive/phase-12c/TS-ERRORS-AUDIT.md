# Phase 12C — Audit TypeScript errors in `src/tests/**`

- **Date :** 2026-04-22
- **Branch :** `phase-12c-ops`
- **Commit anchor :** `c38472f` (post Observer sunset)
- **Scope :** research-only — compte, classe et estime l'effort.
  Aucune correction dans ce doc. Décision fix intégral vs partiel reportée
  au Checkpoint 3 avec Romain.

---

## Résumé exécutif

- **257 erreurs TS** dans `src/tests/**` (baseline pré-sunset : 268 —
  suppression des 6 fichiers Observer a libéré 11 erreurs).
- **31 fichiers** portent au moins une erreur.
- **213 / 257 (83 %)** sont `TS2339 "Property '<...>' does not exist on
  type 'Pool'"` — dette mécanique directement liée au port SQLite → pg.
- **0 erreur runtime** — toutes les erreurs sont en `src/tests/**` exclu
  de `tsconfig.json`. `npm test` passe 1043/1043 avec 289 skipped.
- **Effort total estimé :** 25–45 h selon option (intégral vs partiel).

### Distribution par code erreur

| Code | Count | Signification |
|---|---|---|
| `TS2339` | 213 | `Property '<method>' does not exist on type 'Pool' \| 'Database'` (db.prepare, db.transaction, db.totalCount, etc.) |
| `TS2353` | 15 | Object literal ne matche pas le type attendu (fixtures Bayesian / transaction row qui ont évolué post-port) |
| `TS2304` | 14 | `Cannot find name '<…>'` (imports orphelins, constants retirées) |
| `TS1064` | 5 | Return type mismatch async (fonctions de test déclarées sync mais utilisant `await`) |
| `TS2345` | 3 | Argument type mismatch (appel repo avec shape ancienne) |
| `TS18047` | 2 | `'<…>' is possibly 'null'` (narrowing manquant après `findById`) |
| `TS2454` | 1 | Used before assignment |
| `TS18004` | 1 | No value exists in scope |

### Pattern dominant

```
Property 'prepare' does not exist on type 'Pool'.
```

`Pool` (pg) remplace `Database` (better-sqlite3). Les tests utilisent
encore `db.prepare(sql).run(...)` / `db.prepare(sql).get(...)`. Le port
correct est `await db.query(sql, [...])` avec `rows[0]` pour `.get()` et
rien pour `.run()`. Aucune exception de shape, c'est mécanique.

---

## Classification par fichier

### Trivial — < 10 erreurs, port superficiel (~30–60 min / fichier)

Fichiers isolés où l'erreur touche 1–8 call-sites. La plupart ont déjà
l'essentiel porté ; il reste quelques lignes résiduelles.

| Fichier | Erreurs | État runtime |
|---|---|---|
| `verdict.test.ts` | 8 | mixte (actif + `it.skip`) |
| `phase3EndToEndAcceptance.test.ts` | 8 | `it.skip` |
| `dualWrite/idempotence-reportService.test.ts` | 7 | `describe.skip` |
| `reportAuth.test.ts` | 6 | mixte |
| `nostrMultiKindScheduler.test.ts` | 5 | `it.skip` |
| `integration.test.ts` | 4 | mixte (1 actif / 2 skip) |
| `dualWrite/mode-active.test.ts` | 4 | `describe.skip` |
| `reportBonus.test.ts` | 3 | actif |
| `dualWrite/mode-off.test.ts` | 3 | `describe.skip` |
| `dualWrite/mode-dryRun.test.ts` | 3 | `describe.skip` |
| `verdictAdvanced.test.ts` | 2 | actif |
| `serviceHealth.test.ts` | 1 | actif |
| `security/ssrf-probe-poc.ts` | 1 | script isolé |
| `reportSignal.test.ts` | 1 | actif |
| `production.test.ts` | 1 | actif |
| `nostrMultiKindPublisher.test.ts` | 1 | actif |
| `nostrDeletionService.test.ts` | 1 | actif |
| `lndGraph.test.ts` | 1 | actif |
| `depositTierService.test.ts` | 1 | actif |
| `anonymousReport/voie3-anonymous-report.test.ts` | 1 | `describe.skip` |

**Sous-total Trivial :** ~62 erreurs, 20 fichiers. Effort estimé **8–12 h**.

### Ciblé — 10–30 erreurs, port mécanique db.prepare → pg (~2–4 h / fichier)

Fichiers où la dette est concentrée sur un pattern unique (db.prepare)
répété. Port fiable mais volumineux ; chaque call-site demande
conversion sync → async + signature de query adaptée.

| Fichier | Erreurs | État runtime | Notes |
|---|---|---|---|
| `probeControllerIngest.test.ts` | 30 | `describe.skip` | Intégralement migration-era |
| `rebuildStreamingPosteriors.test.ts` | 21 | `describe.skip` (partiel) | Script one-shot post-cutover |
| `pruneBayesianRetention.test.ts` | 19 | `describe.skip` | Script one-shot |
| `balanceAuth.test.ts` | 16 | `describe.skip` (2 blocs) | Couvert par `depositRateLimit.test.ts` |
| `endpoint.test.ts` | 15 | `it.skip` | Couvert par `operator*` + `serviceHealth` |
| `probeCrawler.test.ts` | 14 | `describe.skip` | Actif fonctionnellement via probe bridge tests |
| `reportBayesianBridge.test.ts` | 13 | `describe.skip` | Couvert par `reportService` tests directs |
| `retention.test.ts` | 11 | mixte | Actif via `pruneBayesianRetention` + `purge` |
| `dualWrite/idempotence-serviceProbes.test.ts` | 11 | `describe.skip` | Migration-era |
| `dualWrite/idempotence-decideService.test.ts` | 10 | `describe.skip` | Migration-era |

**Sous-total Ciblé :** ~160 erreurs, 10 fichiers. Effort estimé **15–25 h**.

### Profond — 30+ erreurs ou rewrite significatif (4–8 h / fichier)

| Fichier | Erreurs | État runtime | Notes |
|---|---|---|---|
| `migrateExistingDepositsToTiers.test.ts` | 32 | `describe.skip` | Script one-shot pre-Phase 9 ; valeur archivage seulement |

**Sous-total Profond :** ~32 erreurs, 1 fichier. Effort estimé **4–8 h**.

---

## Couverture fonctionnelle — pourquoi 0 runtime failure malgré 257 erreurs TS

Chaque fichier à erreurs reçoit soit une **couverture équivalente** via un
autre fichier déjà porté, soit est **script one-shot** devenu obsolète :

| Fichier cassé | Remplacement runtime |
|---|---|
| `probeControllerIngest` | `probeCrawler` (passe) + `probeController` (intégré à `api.test.ts`) |
| `rebuildStreamingPosteriors` | script one-shot, ran pendant Phase 12B cut-over |
| `pruneBayesianRetention` | `retention` (partiel actif) + cron manuel |
| `balanceAuth` | `depositRateLimit`, `l402Paywall`, `tokenBalance` (3 fichiers passent) |
| `endpoint` | `operatorShowApi`, `operatorListApi`, `serviceHealth` (tous passent) |
| `probeCrawler` | couvert par `probeControllerIngest` (skip) — **trou réel** si on veut re-tester le crawl |
| `reportBayesianBridge` | `reportService`, `reportAuth` (mixte), `reportBonus` |
| `retention` (partiel) | actif, le skip porte sur 3 blocs spécifiques |
| `dualWrite/*` | couvert par `dualWrite/audit-script.test.ts` (passe) + `dualWrite/backfill.test.ts` |
| `verdict` (partiel) | `verdictAdvanced`, `verdictOperator`, `verdict.test.ts` blocs actifs |
| `reportAuth` | mixte, 1 bloc actif couvre le chemin critique NIP-98 |
| `migrateExistingDepositsToTiers` | script migration Phase 9, ran une fois en prod 2026-04-09 |

**Trou réel identifié :** `probeCrawler.test.ts` — le seul test qui
valide la boucle de probe crawler à bout-en-bout. À porter si on garde
le crawler probe (oui, c'est le cœur du produit).

---

## Options de fix

### Option A — Fix intégral (25–45 h)

Port complet des 31 fichiers, retrait de l'exclude tests dans
`tsconfig.json`, réactivation de `npm run lint` en CI avec tests
inclus.

**Pour :**
- 100 % du code tapé, dette zéro.
- Un IDE (VSCode, JetBrains) donne autocomplétion correcte dans tous
  les tests.
- Future évolution des repos (ajout de colonnes, changement de shape)
  sera flaguée immédiatement dans les tests, pas silencieuse.

**Contre :**
- Charge importante (1 semaine).
- Beaucoup d'effort sur des fichiers en `describe.skip` qui ne tournent
  pas (ROI test = 0, ROI typage = lisibilité / filet futur).
- `migrateExistingDepositsToTiers` : script one-shot déjà passé en prod,
  porter 32 erreurs pour un fichier qui ne retournera jamais est
  discutable.

### Option B — Fix partiel ciblé (8–12 h)

Triage :
1. **Port prioritaire (actif ou trou réel)** — `probeCrawler`,
   `verdict`, `reportAuth`, `integration`, `verdictAdvanced`,
   `reportBonus`, `serviceHealth`, `lndGraph`, `reportSignal`,
   `production` + singletons actifs. ~8 fichiers, **~4–6 h**.
2. **Supprimer les migration-era `describe.skip`** dont le scope
   est éteint :
   - `dualWrite/idempotence-*` (3 fichiers)
   - `dualWrite/mode-*` (3 fichiers)
   - `migrateExistingDepositsToTiers`
   - `balanceAuth` (couvert ailleurs)
   - `probeControllerIngest` (couvert par `probeCrawler` une fois porté)
   ~8 fichiers, **~1 h** (suppression pure).
3. **Stopgap** pour les scripts one-shot (`rebuildStreamingPosteriors`,
   `pruneBayesianRetention`) : remplacer par un `describe.skip` au
   niveau outer et ajouter `// @ts-nocheck` en tête ; **30 min** au
   total. Garde la trace archéologique sans bruit TS.
4. Laisser exclude `src/tests/**` dans `tsconfig.json`, ajouter un
   script `npm run lint:tests` opt-in pour le port progressif.

**Pour :**
- Budget maîtrisé, priorité aux filets qui servent vraiment.
- Élimine le bruit TS des fichiers sans valeur future.
- Pragma `@ts-nocheck` sur scripts one-shot reste lisible et signalé.

**Contre :**
- Dette résiduelle non nulle (~30–50 erreurs après nettoyage ciblé).
- Option "delete skipped migration-era" demande revue que rien ne
  casse — 1 h d'audit supplémentaire.

### Option C — Status quo (0 h)

Laisser `exclude: ["src/tests/**"]` en place. Accepter que `npm run
lint` ne couvre pas les tests.

**Pour :**
- Zéro effort. Runtime 100 % vert.
- La dette ne grandit pas car les tests actifs sont régulièrement édités
  et les éditeurs flaggent déjà les erreurs fichier par fichier.

**Contre :**
- Pas de filet CI sur shape des tests.
- Les `describe.skip` sans `// @ts-nocheck` polluent l'IDE (rouge partout).
- Dette qui peut se rouvrir silencieusement lors d'un futur port (ex.
  changement de shape BayesianScoringService).

---

## Recommandation technique (à confirmer au Checkpoint 3)

**Option B (partiel ciblé)** — meilleur ratio effort / valeur. Le plan
d'exécution détaillé serait :

| Phase | Scope | Effort |
|---|---|---|
| B1 | Port des 8 fichiers actifs prioritaires | 4–6 h |
| B2 | Suppression de 8 fichiers migration-era `describe.skip` devenus inutiles | 1 h |
| B3 | `@ts-nocheck` sur 2–3 scripts one-shot archivés | 30 min |
| B4 | Retrait partiel du `exclude` : `src/tests/**` → `src/tests/archive/**` seulement | 15 min |
| B5 | Ajout `npm run lint:tests` + wiring CI | 30 min |
| **Total** | | **~6–9 h** |

Résultat cible : **< 20 erreurs résiduelles**, concentrées dans
`archive/` avec `@ts-nocheck` explicite, et `npm run lint:tests` **vert**
sur les fichiers actifs.

---

## Code erreurs — échantillons représentatifs

### TS2339 sur `Pool.prepare` (213 / 257)

```
src/tests/balanceAuth.test.ts(82,20): error TS2339:
  Property 'prepare' does not exist on type 'Pool'.
```

**Pattern de fix :**
```ts
// avant (SQLite)
db.prepare(`INSERT INTO foo (x) VALUES (?)`).run(1);
const row = db.prepare(`SELECT * FROM foo WHERE x = ?`).get(1);

// après (pg)
await db.query(`INSERT INTO foo (x) VALUES ($1)`, [1]);
const { rows } = await db.query(`SELECT * FROM foo WHERE x = $1`, [1]);
const row = rows[0] ?? null;
```

### TS2353 sur Bayesian fixture shape (15)

```
src/tests/dualWrite/mode-active.test.ts(X,Y): error TS2353:
  Object literal may only specify known properties,
  and 'endpointHash' does not exist in type 'TransactionIngest'.
```

**Pattern :** propriétés `endpointHash` / `operatorId` / `source` /
`windowBucket` ont migré de `TransactionIngest` vers `DualWriteEnrichment`
séparé. Mécanique mais demande relecture de chaque fixture.

### TS2304 — import orphelin (14)

```
src/tests/X.test.ts(Y,Z): error TS2304:
  Cannot find name 'ObserverCrawler'.
```

**Pattern :** résidus de l'ère Observer (mais le sunset a déjà supprimé
les plus visibles). Les 14 restants sont surtout des constants refactorés
(ex. `AGENT_SOURCES`, `BUCKET_SOURCES` nommés différemment post-port).

---

## Conclusion

- 257 erreurs TS, 0 runtime failure.
- Option B recommandée, 6–9 h, dette finale < 20 erreurs archivées.
- Checkpoint 3 avec Romain : valider l'option ET le scope exact des
  fichiers à supprimer vs porter (liste dans B2 et B1 à peaufiner avec
  lui).

**Les tâches C4.2 (port) et C4.3 (suppression + lint:tests) restent en
attente du GO Checkpoint 3.**
