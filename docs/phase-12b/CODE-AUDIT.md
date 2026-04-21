# Phase 12B B0 — Code audit (SQLite → Postgres)

**Date :** 2026-04-21
**Branch :** `phase-12b-postgres`
**Goal :** décider la stratégie de migration avant B1 (provision VM Postgres).

---

## TL;DR

| Field | Value |
|---|---|
| **Driver actuel** | `better-sqlite3 ^11.7.0` — **no ORM** (raw SQL partout) |
| **Driver cible** | `pg` ^8.x (node-postgres) — **no ORM** également (port direct) |
| **Complexité** | Medium — raw SQL mécanique, mais sync→async sur tout le codebase |
| **Effort estimé** | **4–5 jours** (upper-end du bucket "raw SQL everywhere" du plan) |
| **Stratégie** | Cut-over brutal, pas de dual-driver, pas de feature flags |
| **Test harness** | Postgres dockerisé (container éphémère par run test) |
| **Plus grosse surprise** | **0 appel `json_extract()`** SQLite — le JSON est 100 % Node-side (`JSON.parse/stringify` sur colonnes TEXT). Grosse économie vs l'hypothèse initiale du plan. |
| **Plus gros risque** | Propagation `Promise<T>` sur 1 635 call sites DB dans 170 fichiers (repos + tests + scripts) |

**Recommandation :** GO pour le cut-over direct. Le 0-user principle rend ce scénario propre ; la surface SQLite-spécifique est plus petite qu'attendu ; le seul vrai coût est la propagation `async` mécanique que TypeScript va surfacer au compilateur.

---

## 1. Inventaire du driver et de la surface

### Dépendance

```
package.json: "better-sqlite3": "^11.7.0"
```

Aucune couche ORM (TypeORM, Prisma, Drizzle, Knex) — tout passe directement par les APIs `db.prepare().run/get/all/exec()` et `db.transaction()`.

### Surface brute

| Mesure | Valeur | Notes |
|---|---:|---|
| Fichiers `src/**/*.ts` qui touchent la DB (hors tests) | **54** | controllers, services, repositories, crawler, scripts |
| Tous fichiers avec appels better-sqlite3 (tests inclus) | **170** | dont 16 fichiers utilisant `db.transaction()` |
| Appels `.prepare/.run/.get/.all/.exec/.pragma/.transaction` | **1 635** | propagation async = le gros du travail |
| Taille `src/database/migrations.ts` | **1 634 lignes** | migrations inline, version-trackée (v1 → v38+) |
| Taille `src/database/connection.ts` | **42 lignes** | singleton simple + PRAGMAs |

### Point d'entrée unique (bon signe)

`src/database/connection.ts:17-30` — singleton `getDatabase()` avec 5 PRAGMAs :

```
journal_mode = WAL        → rien de direct côté PG (WAL est built-in)
foreign_keys = ON         → pas nécessaire (PG le fait par défaut)
synchronous = NORMAL      → pas applicable
busy_timeout = 15 000 ms  → remplacer par `lock_timeout` / `statement_timeout`
wal_autocheckpoint = 1000 → N/A
```

Cible : remplacer par un pool `pg.Pool({ max, idleTimeoutMillis, statement_timeout })` dans le même fichier. Le reste du code ne voit que l'instance ; l'impact est contenu.

---

## 2. Inventaire des patterns SQL (ce qu'il faut réécrire)

| Pattern SQLite | Occurrences | Fichiers | Conversion Postgres | Effort |
|---|---:|---:|---|---|
| `INSERT OR REPLACE` / `INSERT OR IGNORE` / `ON CONFLICT` | 35 | 22 | `INSERT ... ON CONFLICT (...) DO UPDATE / DO NOTHING` | Mécanique |
| `json_extract()` / `json_each()` / `json_array()` | **0** | 0 | Rien à convertir | — |
| `datetime('now')` / `strftime()` / `julianday()` | 1 | 1 (`reportStatsController.ts`) | `NOW()` | Trivial |
| Mots-clés DDL spécifiques (`PRIMARY KEY`, `REAL DEFAULT`, `BLOB`, etc.) dans `migrations.ts` | 55 | 1 | Schema DDL à réécrire (`SERIAL` vs `AUTOINCREMENT`, `BYTEA` vs `BLOB`, `DOUBLE PRECISION` vs `REAL`) | Moyen (1 gros fichier) |
| `db.transaction(() => { … })` (sync) | 19 call sites | 16 | `await client.query('BEGIN') / COMMIT / ROLLBACK` ou wrapper `withTransaction(db, fn)` | Moyen (propagation async) |
| `db.pragma(...)` | 15 | 8 | Supprimer ou remplacer par config PG | Faible |
| `?` placeholders | partout | partout | `$1 / $2 / $n` (pg) | Mécanique — mais tous les `prepare()` sont à réécrire |

### Ce qui N'EST PAS un problème

- **JSON** : 10 occurrences de `JSON.parse/stringify` dans les 5 fichiers Nostr — c'est purement Node-side, la DB stocke du TEXT. **Zéro impact migration.** Les tables SatRank sont majoritairement scalaires (TEXT/INTEGER/REAL). Le jour où on veut indexer un champ JSON on passera en JSONB — pas requis en 12B.
- **Triggers / vues / FTS** : aucun observé dans le scan `migrations.ts` (CHECK contraintes + index uniquement). Migration propre.
- **SQL dynamique complexe** : `agentRepository.findByHashes()` construit des placeholders `?,?,?,...` en runtime ; trivial à porter en `$1,$2,$3,...`.

---

## 3. Hot paths et coût de la propagation sync→async

`better-sqlite3` est **100 % synchrone**. `pg` est **100 % async**. Chaque repo method qui retourne `T` aujourd'hui devra retourner `Promise<T>`, et tous les callers doivent propager `await`. TypeScript strict va surfacer tous les sites d'appel au compilateur — c'est mécanique mais volumineux (1 635 call sites).

### Cas particuliers à surveiller

| Lieu | Pattern | Risque |
|---|---|---|
| `scoringService.ts` | Seulement **2 call sites DB directs** ; passe par des repos | Faible — les repos encapsulent |
| `scoringService.ts` (tight loops) | Boucles sur scored agents pour PageRank, capacity trend, etc. | **Modéré** — un `await` par iteration bottleneck à 1000+ agents ; solution : batcher les queries (`SELECT ... WHERE id IN (...)`) |
| `crawler/run.ts` | Long-running jobs avec PRAGMA wal_checkpoint | Faible — scripts standalone, on les réécrit un par un |
| `src/database/migrations.ts` | 19 usages de `db.transaction()` inline | Moyen — refactor en une passe, wrapper `withTx(pool, fn)` |
| Tests vitest (150+ fichiers) | Chacun crée une in-memory SQLite | **Le vrai gros morceau** — voir section 5 |

### Fichiers qui bougeront le plus (estimation grep-based)

- `src/database/migrations.ts` — 1 634 lignes, refactor complet du schema DDL
- `src/services/scoringService.ts` — sync→async des appels repo
- `src/crawler/*` — crawlers itèrent agents/channels en série
- `src/repositories/*` — 8 repos, signatures toutes Promise<T>
- `src/scripts/*` — ~10 scripts (backup, rollback, calibration, demos) touchent DB
- Tous les tests — voir section 5

---

## 4. Transactions : le piège principal

`better-sqlite3` fournit `db.transaction(fn)` qui retourne une **fonction** (wrapping sync BEGIN/COMMIT). `pg` utilise un checkout de client du pool :

```js
// AVANT (better-sqlite3)
const applyAll = db.transaction((rows) => {
  for (const r of rows) insert.run(r);
});
applyAll(rows);

// APRÈS (pg)
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const r of rows) await client.query('INSERT ...', [r]);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
```

**Mitigation :** créer un helper `withTransaction(pool, async (client) => { ... })` dans `src/database/transaction.ts` dès B3, et ne pas écrire BEGIN/COMMIT à la main ailleurs. 19 call sites × helper = refactor linéaire.

---

## 5. Test harness — le vrai enjeu

Les tests vitest créent aujourd'hui une SQLite in-memory via `new Database(':memory:')`. Pour le cut-over direct, trois options :

### Option A — Postgres dockerisé par run test (retenue)

```
docker run --rm -d -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
```

- Chaque fichier test ouvre sa propre DB via `CREATE DATABASE test_<hash>` sur une instance partagée, puis `DROP` à la fin.
- Ajouter un setup global vitest (`globalSetup` option) qui démarre le container et expose `DATABASE_URL`.
- **Coût :** +5-10 s de démarrage container une fois par run, quelques secondes par fichier test pour la création/drop de DB.
- **Bénéfice :** les tests valident le vrai chemin (migrations + requêtes PG-syntaxe), zéro dérive prod.

### Option B — PGlite (WASM Postgres in-memory)

- Projet ElectricSQL, runtime Postgres dans Node via WASM.
- Pas besoin de Docker, mais compatibilité SQL imparfaite (rejets sur certaines fonctions).
- **Rejetée** : introduit un risque de "les tests passent, prod échoue" exactement comme SQLite cible aujourd'hui.

### Option C — Garder SQLite pour tests, Postgres en prod (dual-driver)

- Nécessiterait un abstraction layer au-dessus de `prepare/run/etc`.
- **Rejetée** : viole le 0-user principle (dual-driver = même coût que dual-write), et masque les bugs PG-spécifiques (ON CONFLICT, `$n` placeholders, types).

### Recommandation

**Option A.** Un seul container partagé entre tous les tests, isolation via DB-per-test. Le setup global vitest garde le coût marginal bas.

---

## 6. Scripts et outils hors-serveur

Fichiers qui tournent comme scripts standalone (pas dans le critical path request) :

```
src/scripts/backup.ts
src/scripts/rollback.ts
src/scripts/calibrationReport.ts
src/scripts/benchmarkBayesian.ts
src/scripts/compareLegacyVsBayesian.ts
src/scripts/inferOperatorsFromExistingData.ts
src/scripts/backfillProbeResultsToTransactions.ts
src/scripts/backfillTransactionsV31.ts
src/scripts/migrateExistingDepositsToTiers.ts
src/scripts/phase8Demo2.ts
src/scripts/rebuildStreamingPosteriors.ts
src/scripts/pruneBayesianRetention.ts
src/scripts/analyzeDeltaDistribution.ts
src/scripts/attestationDemo.ts
```

`backup.ts` utilise `.backup()` de better-sqlite3 — remplacer par `pg_dump` (shell exec) ou le backup streaming de pg. `rollback.ts` s'appuie sur un `.db` file — deviendra un `pg_restore`. Les autres sont des scripts one-shot : migration mécanique, pas bloquants pour le cut-over.

---

## 7. Plan de migration proposé (input pour B3)

Ordre de port (risque minimisé) :

1. **Infrastructure** : `connection.ts` → pool pg, `migrations.ts` → schema Postgres + bootstrap DDL
2. **Transaction helper** : `src/database/transaction.ts` avec `withTransaction(pool, fn)`
3. **Repos read-only d'abord** : `agentRepository.find*`, puis `snapshotRepository`, puis `feeSnapshotRepository` — valider que les lectures marchent
4. **Repos write** : rewrite de chaque `INSERT OR REPLACE` en `INSERT ... ON CONFLICT ... DO UPDATE`
5. **Services / controllers** : propagation `async/await` — le compilateur TS guide
6. **Crawler / scripts** : port en dernier (non-bloquant pour smoke test API)
7. **Tests** : setup Postgres dockerisé + port des helpers (`createTestDb`, `seedAgent`, etc.)
8. **ETL** : script Node dédié qui lit la SQLite prod en read-only + écrit en Postgres staging (B4)

Ordre B3 sur 3 jours :
- J1 : connection + migrations + 3 repos read-only + tests de base
- J2 : repos write + services + controllers
- J3 : crawler + scripts + tests complets green

---

## 8. Risques et mitigations

| Risque | Sévérité | Mitigation |
|---|---|---|
| Propagation async dans tight loops (scoring, crawler) dégrade le throughput | Moyen | Batcher les queries (`WHERE id IN (...)`) ; mesurer en B7 iso-network smoke |
| Types numériques PG ≠ SQLite (INTEGER vs BIGINT, REAL vs DOUBLE PRECISION) | Moyen | Audit type-par-type dans B3 J1 ; `capacity_sats` peut dépasser 32 bits → BIGINT |
| `better-sqlite3` silencieux sur types ; `pg` strict | Faible | TS strict + tests attrapent les mismatches |
| Tests lents à cause du container PG | Faible | Un seul container partagé, DBs éphémères par fichier test |
| Rollback : la SQLite prod frozen comme backup | — | Dump au moment du cut-over B5, gardé pendant 30 j |
| Oubli d'une query `json_extract` cachée (grep manqué) | Faible | TS strict surfacera l'erreur runtime dès B3 ; on vérifiera 0 match avant cut-over |

---

## 9. Questions à Romain avant B1

1. **Test harness** : OK pour Postgres dockerisé (option A) ? Alternative minoritaire : pglite (rejetée ici mais moins d'infra).
2. **Pool size** : je proposerai `pg.Pool({ max: 20 })` sur cpx42 (8 vCPU). OK ou préférence ?
3. **Extensions PG** : aucune requise pour la v1 du port. `pg_stat_statements` recommandé pour l'observabilité en B2. OK ?
4. **ETL window** : le cut-over B5 est "big-bang". Durée estimée : ~30 min (dump SQLite ~80 MB, restore PG, smoke 3 endpoints). OK pour une fenêtre ~1 h annoncée ?
5. **Rollback gate** : si B7 iso-network smoke révèle une régression > 20 % sur un palier A5, on rollback en SQLite ? (SQLite dump + git revert du merge `phase-12b-postgres`). OK comme critère ?

---

## 10. GO/NO-GO

**Recommandation : GO.**

- Surface plus petite qu'anticipée (0 `json_extract`, 1 `datetime('now')`).
- Stack déjà structurée en repositories (pas de SQL raw disséminé dans les controllers).
- TypeScript strict = filet de sécurité pour la propagation async.
- 0-user = aucun risque business sur le cut-over.

**Prêt pour B1 dès validation de ce rapport + réponses aux 5 questions ci-dessus.**

---

## 11. Validation Romain — 2026-04-21 (figé)

Décisions frozen post-review, appliquer tel quel dans B1→B9 :

### Réponses aux 5 questions

1. **Test harness Postgres dockerisé** — OK
2. **Pool sizes** — `API max: 30`, `crawler max: 20` (séparé, pas 20/20)
3. **`pg_stat_statements`** — OK en B2
4. **Fenêtre cut-over (B5)** — pas de fenêtre annoncée (0 user). Budget durée : **<30 min attendu, <1 h acceptable**. Au-delà : pause + debug, pas de marche forcée.
5. **Critère rollback (B5)** — reformulé : **pas** de critère "régression %" (pas de bench post-migration). Rollback déclenché **uniquement** si :
   - 5xx en boucle > 5 min post-cut-over, OU
   - queries > 10 s qui bloquent le crawler

### Décisions supplémentaires figées

**A. JSON storage** — garde `TEXT` pour la migration. Zéro changement de type. JSONB = opportunité Phase 12C, ne pas mélanger ici.

**B. Crawler race conditions** — pendant B3, identifier les sections du crawler qui font *check-then-insert* ou *read-modify-write*. Livrable : `docs/phase-12b/CRAWLER-RACE-CHECK.md`. Pour chacune, wrap dans `withTransaction()` avec `SELECT FOR UPDATE` si nécessaire. **Objectif : pas de race introduite par le passage async/multi-connexion.**

**C. Tests verts — même ratio** — baseline avant migration (B0) et après (fin B3) : total / passing / skip / failing. Même ratio passing attendu. Livrable : `docs/phase-12b/TEST-BASELINE.md`.

**D. Cardinal LND (rappel non-négociable)** — si saturation CPU/RAM prod VM > 70 % pendant dump/restore, **throttle**. Toute suspicion d'impact indirect sur LND → **STOP** et demande.

### Scope autonome

GO pour B1→B4 en autonome. **STOP avant B5** pour validation finale avec checklist pré-cut-over.
