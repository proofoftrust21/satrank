# Phase 10 — Sunset legacy + API stable 1.0.0

**Branche** : `phase-10-sunset-legacy`
**Date** : 2026-04-20
**Contexte** : Phase 9 close (merge `209bd5b` sur main, deposit tiers actifs, `/api/probe` déployé, schema v40). Phase 10 retire les deux derniers endpoints legacy (`/api/decide`, `/api/best-route`), nettoie le code orphelin qui les supportait, renomme la table `decide_log` pour refléter la vraie sémantique, et bump la version API à **1.0.0** — première release stable.

---

## TL;DR

- **Retiré** : `POST /api/decide` et `POST /api/best-route` répondent désormais **410 Gone** avec un body structuré qui pointe vers le successeur (`/api/intent`) et le guide de migration.
- **Renommé** : table SQL `decide_log` → `token_query_log` via migration **v41** (schema 40 → 41). Le nouveau nom reflète la vraie sémantique (L402 token → targets queriés pour l'auth report). Rollback disponible.
- **Version API** : `0.1.0 → 1.0.0`. Bump dans `package.json`, `package-lock.json`, `src/openapi.ts`, `src/mcp/server.ts`, `mcp-server.json`. L'endpoint `/api/version` reporte désormais `1.0.0`.
- **Observabilité** : compteur Prometheus `satrank_legacy_endpoint_calls_total{endpoint=...}` sur chaque hit 410 + log pino structuré `event="legacy endpoint called"` avec IP/UA/request_id. Contrat verrouillé par 5 tests dédiés.
- **Code mort supprimé** : `src/utils/deprecation.ts` (helpers `Deprecation` / `Sunset` qui n'ont plus de caller) et les champs `deprecationBaseMessage` / `aliasBaseMessage` / `DeprecatedDecideRequestSchema` / `DeprecatedBestRouteRequestSchema` dans `V2Controller`.
- **Tests** : 1441/1441 (était 1436 avant Phase 10 → +5 tests dédiés au handler 410). Lint clean.
- **Worker renommé** : `decideLogTimeoutWorker.ts` → `tokenQueryLogTimeoutWorker.ts` (classe `TokenQueryLogTimeoutWorker`), aligné sur le nouveau nom de table.

---

## Séquence commits

| Commit | SHA | Portée |
|---|---|---|
| C1 | *(audit)* | Relevé des candidats à retirer : endpoints `/api/decide` + `/api/best-route`, table `decide_log`, helpers `deprecation.ts`, champs orphelins de `V2Controller`. Arbitrages (cf. §Arbitrages). |
| C2 | `1486db2` | `POST /api/decide` → 410 Gone. `createGoneHandler` dans `src/controllers/legacyGoneController.ts` ; route déplacée de `createV2Routes` vers un handler direct dans `src/routes/v2.ts`. Tests 410 avec body JSON + pointeur vers `/api/intent`. |
| C3 | `02795e0` | `POST /api/best-route` → 410 Gone. Même pattern que C2. `DecideService` est toujours utilisé en interne par le MCP et n'est pas retiré. |
| C4 | `46e0944` | Suppression `src/utils/deprecation.ts` + `src/tests/deprecation.test.ts`. Retrait des 4 champs morts dans `V2Controller` (base messages + schemas zod `DeprecatedDecideRequestSchema` / `DeprecatedBestRouteRequestSchema`). |
| C5 | `5cfb37d` | Migration v41 : `ALTER TABLE decide_log RENAME TO token_query_log` + rename index `idx_decide_log_ph` → `idx_token_query_log_ph`. Rename du worker. Refs SQL mises à jour dans `auth.ts`, `reportService.ts`, `tokenQueryLog.ts`, tests. Bump `EXPECTED_SCHEMA_VERSION = 41`. |
| C6 | *(audit, no-op)* | Audit des réponses JSON de `/api/probe` et `/api/deposit/*` pour snake_case. Résultat : déjà 100% camelCase. Aucun changement nécessaire — documenté dans `MIGRATION-TO-1.0.md`. |
| C7 | `a373db9` | Bump version `0.1.0 → 1.0.0` : `package.json`, `package-lock.json`, `src/openapi.ts` (info.version), `src/mcp/server.ts` (server.version), `mcp-server.json`. |
| C8 | `67e187e` | `CHANGELOG.md` : section `[API 1.0.0]` avec Removed / Changed / Intentionally not changed. `docs/MIGRATION-TO-1.0.md` (nouveau) : guide step-by-step 0.x → 1.0. |
| C9 | `89ec804` | `src/tests/legacyGoneController.test.ts` (5 tests) : verrouille l'incrément du compteur Prometheus + la structure du log pino pour les deux endpoints 410. |
| C10 | *(this commit)* | Ce rapport. |

---

## Architecture

### Avant Phase 10

```
POST /api/decide      → V2Controller.decide       (deprecated headers)
POST /api/best-route  → V2Controller.bestRoute    (deprecated headers)
POST /api/intent      → IntentController.resolve
POST /api/report      → V2Controller.report
GET  /api/agent/:hash → AgentController.get
```

- `V2Controller` portait les handlers de `decide`, `bestRoute`, `report`, `profile`, plus 4 champs de config pour la deprecation.
- `src/utils/deprecation.ts` exposait `Deprecation` + `Sunset` header helpers.
- Table `decide_log` (nom hérité de `/api/decide`) contenait `{payment_hash, target_hash, decided_at}` et servait à gater `/api/report` (un token ne peut reporter que sur ce qu'il a "décidé").

### Après Phase 10

```
POST /api/decide      → 410 Gone   (createGoneHandler → satrank_legacy_endpoint_calls_total)
POST /api/best-route  → 410 Gone   (createGoneHandler)
POST /api/intent      → IntentController.resolve          ← successeur unique
POST /api/report      → V2Controller.report               ← inchangé
GET  /api/agent/:hash → AgentController.get               ← inchangé (camelCase)
```

- `V2Controller` conserve `report` + `profile` uniquement. 260 lignes supprimées.
- Table renommée : `token_query_log` (mêmes colonnes, même index). Le sens du nom est « log des targets queriés par un token L402 » — plus honnête que `decide_log` maintenant que `/api/decide` n'existe plus.
- `DecideService` reste dans le code : il est toujours utilisé en interne par le **MCP server** (tool `decide`), qui n'est pas exposé en HTTP. Retirer le service casserait la surface MCP sans gain.

### Handler 410 Gone (`legacyGoneController.ts`)

```ts
export function createGoneHandler(spec: {
  from: string;        // '/api/decide'
  to: string;          // '/api/intent'
  removedOn: string;   // '2026-04-20'
  docs: string;        // migration guide URL
}): RequestHandler
```

Body JSON (RFC 7231 §6.5.9 conforme) :

```json
{
  "error": {
    "code": "ENDPOINT_REMOVED",
    "message": "This endpoint was removed on 2026-04-20. Use /api/intent instead.",
    "migration": {
      "from": "/api/decide",
      "to": "/api/intent",
      "see": "https://satrank.dev/docs/migration-to-1.0"
    }
  }
}
```

Chaque hit :

1. Incrémente `satrank_legacy_endpoint_calls_total{endpoint}`.
2. Émet un log pino `info` : `{ route, successor, removed_on, ip, user_agent, request_id }`.
3. Répond 410 avec le body JSON.

---

## Arbitrages

### 1. `decide_log → token_query_log` (rename) plutôt que DROP

L'option « DROP table » a été écartée : la table est lue en hot-path sur chaque `POST /api/report` pour gater l'auth d'un token L402. Supprimer nécessiterait un remplacement par un nouveau mécanisme de scope-check — hors scope Phase 10. Le rename aligne la sémantique sans toucher au contrat.

### 2. `AgentController` reste **camelCase**

Le champ `public_key_hash` revient snake_case dans la DB, mais `AgentController` expose `publicKeyHash` + champs dérivés camelCase depuis v1. Conservé tel quel — renommer serait un break silencieux pour tout SDK 1.0 déjà publié. Snake_case ne subsiste que sur les endpoints de découverte où il matche des fields persistés et documentés (`url_hash`, `verification_score`, etc.).

### 3. Worker renommé, pas supprimé

`decideLogTimeoutWorker.ts` → `tokenQueryLogTimeoutWorker.ts`. Le worker balaye la table pour expirer les entrées ; le rename reflète la table. Classe + interface + filename alignés.

### 4. Scripts archivés → pas encore

Un `src/scripts/archive/` avec `README.md` expliquant la raison d'archivage avait été envisagé pour des scripts one-shot passés. Après audit : aucun script actuel ne mérite l'archivage — soit ils servent encore (backup, rollback, calibrate, bayesian:*), soit ils ont été retirés à leur phase propre. Décision : pas d'archive créée.

---

## Tests

- **Avant Phase 10** : 1436 tests (post-Phase 9).
- **Après Phase 10** : 1441 tests (+5 dans `legacyGoneController.test.ts`).

Tests ajustés pour la rename v41 :

- `src/tests/migrations.test.ts` : `EXPECTED_SCHEMA_VERSION = 41`, arrays `[1..41]`.
- `src/tests/modules.test.ts` : idem + healthcheck attend `schemaVersion=41`.
- `src/tests/dualWrite/idempotence-decideService.test.ts` : renommages `seedDecideLog → seedTokenQueryLog`, `DecideLogTimeoutWorker → TokenQueryLogTimeoutWorker`, SQL `decide_log → token_query_log`.
- `src/tests/reportAuth.test.ts` + `reportBayesianBridge.test.ts` : INSERT dans `token_query_log`.
- `src/tests/v2.test.ts` : deux describe blocks dédiés aux 410 Gone avec assertion de migration JSON.

---

## Observabilité

### Métriques

| Metric | Type | Labels | Signal |
|---|---|---|---|
| `satrank_legacy_endpoint_calls_total` | Counter | `endpoint` (`/api/decide` \| `/api/best-route`) | Combien de consommateurs sont encore coincés sur l'ancienne URL. Quand le compteur stagne à 0 sur une fenêtre 30j, le handler 410 peut être retiré. |

### Logs

Sur chaque hit d'un endpoint 410 :

```json
{
  "level": 30,
  "msg": "legacy endpoint called",
  "route": "/api/decide",
  "successor": "/api/intent",
  "removed_on": "2026-04-20",
  "ip": "…",
  "user_agent": "…",
  "request_id": "…"
}
```

Usage : une requête SQL d'agrégation sur `route + user_agent` identifie quel SDK / quel opérateur est à réécrire.

---

## Migration & breaking changes

Voir **[`docs/MIGRATION-TO-1.0.md`](MIGRATION-TO-1.0.md)** pour le guide caller.

| Ancien | Nouveau | Action requise |
|---|---|---|
| `POST /api/decide` | `POST /api/intent` (discovery) ou `GET /api/agent/:hash/verdict` (trust) | **BREAKING** — réécrire l'appel |
| `POST /api/best-route` | `GET /api/services/best?serviceUrl=...` ou `POST /api/intent` | **BREAKING** — réécrire l'appel |
| Table `decide_log` | Table `token_query_log` | **Transparent côté API** — migration v41 s'applique au startup, rollback possible |

Pas de changement sur :

- `/api/intent`, `/api/report`, `/api/deposit/*`, `/api/probe`, `/api/agent/:hash[/verdict|/history|/attestations]`, `/api/services/*`, `/api/operators`, `/api/operator/:id`, `/api/endpoint/:url_hash`, `/api/watchlist`, `/api/stats[/reports]`, `/api/health`, `/api/version`, `/api/top`, `/api/search`, `/api/movers`, `/api/ping/:pubkey`.
- L402 flow (status 402 + `WWW-Authenticate: L402 macaroon=..., invoice=...`).
- Deposit tiers, engraved rates.
- Bayesian / Advisory / Health blocks.
- SDK 1.0-rc.1 (pas de bump requis — le retrait des endpoints ne casse pas le SDK, qui utilise déjà `/api/intent`).

---

## Deploy plan

1. Merger `phase-10-sunset-legacy` sur `main` (fast-forward, pas de rebase — chaque commit a CI verte).
2. `make deploy` sur prod : rsync + reboot container API.
3. Vérifier au startup :
   - `schemaVersion=41` dans `/api/health`.
   - `/api/version` retourne `1.0.0`.
   - `POST /api/decide` retourne 410 avec body migration.
4. Publier l'annonce de release 1.0.0 (canal produit — pas automatisé par Claude Code).

Rollback : `rollbackTo(db, 40)` restaure `decide_log` (table + index). Les deux routes 410 peuvent être re-mappées sur leurs handlers d'origine via revert du commit `1486db2` et `02795e0`.

---

## Ligne de crête pour 2.0

Ce qui **reste sur la route** (non résolu en 1.0, pas de break prévu en 1.x) :

- `DecideService` vit toujours dans le code mais n'a plus qu'un seul consommateur (MCP). À fusionner dans `IntentService` quand le MCP sera réarchitecturé.
- Champs snake_case sur `/api/operators`, `/api/endpoint/:url_hash`, `/api/intent` — contrat public, ne bouge pas en 1.x.
- `V2Controller` gardé intact pour `report` + `profile` — pourrait être scindé en `ReportController` + `ProfileController` purement cosmétiquement mais sans gain fonctionnel.

---

**Phase 10 close.** Next: merge + deploy (CHECKPOINT FINAL).
