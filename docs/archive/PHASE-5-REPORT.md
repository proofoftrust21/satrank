# Phase 5 — /api/intent structuré

**Branche** : `phase-5-intent`
**Date** : 2026-04-19
**Contexte** : Phase 4 (merge `290896b`, advisory overlay + bayésien-native) mergée sur `main` avec 897 tests. Phase 5 introduit la première API **discovery structurée** de SatRank : l'agent déclare une intention (`category + keywords + budget + max_latency`), le serveur répond par des candidats L402 rankés bayésien-native, avec overlay advisory et snapshot health. Neutralité d'ordonnancement : pas de `paid_listing`, pas de NLP côté serveur.

---

## TL;DR

- **Nouveau** : `POST /api/intent` + `GET /api/intent/categories` (snake_case).
- **Déprécié** (non supprimé) : `POST /api/decide` et `POST /api/best-route`, signalés via header `Deprecation: true`, `Link: </api/intent>; rel="successor-version"`, et `body.meta.deprecated_use`.
- **Conventions** : snake_case uniquement sur les nouveaux endpoints ; le reste de l'API reste camelCase (harmonisation différée à Phase 10).
- **Validation** : catégorie normalisée (alias) + regex `^[a-z][a-z0-9/_-]{1,31}$` à l'ingest (crawler + self-register) ET à la query. Enum dynamique contre `findCategories()`.
- **Neutralité** : tri primaire `p_success DESC → ci95_low DESC → price_sats ASC`. Pas de boost payé. Strictness tiered `strict → relaxed → degraded`.
- **Couverture tests** : 942/942 → +33 tests depuis Phase 4 (12 intentService unit + 12 intent HTTP intégration + 4 deprecation + 5 v2 deprecation + 4 openapi + 12 categoryValidation). Lint clean.

---

## Séquence commits

| Commit | SHA | Portée |
|---|---|---|
| C1 | `6f32a84` | Validator regex partagé (`utils/categoryValidation.ts`) + garde-fou crawler (skip + warn) + 400 self-register. 12 unit tests — les 22 catégories prod matchent. |
| C2 | `3d5fea6` | `IntentService` core avec `resolveIntent` / `listCategories` / `knownCategoryNames`. Extraction de `deriveRecommendation` depuis `decideService` vers `utils/recommendation.ts` (shared entre decide et intent). Nouveaux repo helpers : `findCategoriesWithActive` + `medianHttpLatency7d` (SQL sur `service_probes` 7j, null si < 3 samples). 12 tests unit. |
| C3 | `82436bb` | `IntentController` + wiring `POST /api/intent` et `GET /api/intent/categories` sous `discoveryRateLimit`. Zod validation (format + enum dynamique). Log structuré (caller, category, counts, strictness, warnings). 9 tests intégration supertest. |
| C5 | `ef3eb76` | Tests intégration strictness (`strict`/`relaxed`/`degraded`), tri tertiaire price ASC, fallback warnings. +3 tests. |
| C6 | `fc5ca19` | Déprécation `/api/decide` + `/api/best-route`. Helpers `utils/deprecation.ts` (markDeprecated, patchDeprecatedBody, logDeprecatedCall). Headers RFC 8594/5988 + body.meta.deprecated_use. 5 tests. |
| C7 | `e58ff82` | OpenAPI : paths `/intent` + `/intent/categories` avec schémas complets, `deprecated: true` sur legacy. 4 tests openapi.json. |
| C8 | *(this commit)* | Ce rapport. |

> **Note** : C4 (POST wiring) a été folded dans C3 — le controller + les deux routes partagent l'injection de `IntentService` et ont été commitées ensemble plutôt que séparer artificiellement.

---

## Shape de l'API

### `POST /api/intent`

```jsonc
// Request
{
  "category": "weather",             // enum dynamique, regex validé
  "keywords": ["paris", "forecast"], // AND, LIKE NOCASE
  "budget_sats": 100,
  "max_latency_ms": 2000,
  "caller": "agent-42",              // libre, logué
  "limit": 5                          // défaut 5, max 20
}

// Response
{
  "intent": {
    "category": "weather",
    "keywords": ["paris", "forecast"],
    "budget_sats": 100,
    "max_latency_ms": 2000,
    "resolved_at": 1776614803
  },
  "candidates": [
    {
      "rank": 1,
      "endpoint_url": "https://api.weather.example/paris",
      "endpoint_hash": "a1b2…64hex",
      "operator_pubkey": "02abc…66hex",
      "service_name": "paris-forecast",
      "price_sats": 5,
      "median_latency_ms": 180,
      "bayesian": { "p_success": 0.92, "ci95_low": 0.78, "verdict": "SAFE", … },
      "advisory": { "advisory_level": "green", "risk_score": 0.05, "advisories": [], "recommendation": "proceed" },
      "health": { "reachability": 0.97, "http_health_score": 0.93, "health_freshness": 0.72, "last_probe_age_sec": 180 }
    }
  ],
  "meta": {
    "total_matched": 8,
    "returned": 1,
    "strictness": "strict",
    "warnings": []
  }
}
```

### `GET /api/intent/categories`

```jsonc
{
  "categories": [
    { "name": "weather", "endpoint_count": 7, "active_count": 4 },
    { "name": "data", "endpoint_count": 12, "active_count": 8 }
  ]
}
```

`active_count` = nombre d'endpoints ayant ≥3 probes ET uptime ≥ 0.5. L'écart entre `endpoint_count` et `active_count` signale à l'agent les catégories fossiles vs. saines.

---

## Décisions techniques

### D1 — Enum dynamique vs. table figée

- **Décision** : Enum = `findCategories()` (DISTINCT sur `service_endpoints.category`) au moment de la requête, sans table dédiée.
- **Raison** : L'ensemble des catégories change avec l'ingest 402index. Une table figée demande des migrations à chaque ajout. La validation de format (regex) à l'ingest bloque les valeurs parasites.
- **Conséquence** : Le crawler skip silencieux (warn log) sur valeur non conforme ; self-register renvoie 400 `INVALID_CATEGORY_FORMAT`.

### D2 — Bayesian agent-level, pas endpoint-level

- **Décision** : On expose `agentService.toBayesianBlock(agent_hash)` dans la réponse, cohérent avec `/api/services/best` (Phase 4 P3).
- **Raison** : Source of truth unique, pas de duplication de logique de verdict.
- **Alternative rejetée** : bayésien par endpoint_hash — demandé plus de plumbing sans valeur ajoutée vs. bayésien du node opérateur.

### D3 — snake_case sur /api/intent uniquement

- **Décision** : snake_case sur `IntentRequest` / `IntentResponse` + `ResolvedIntent` / `IntentCandidate` / `IntentMeta`. Les endpoints legacy (`/decide`, `/best-route`, `/services`, `/verdict`) restent camelCase.
- **Raison** : Amorce la convention cible long terme sans casser les agents existants. Harmonisation différée à Phase 10.
- **Traçabilité** : commentaire de tête dans `types/intent.ts` documente explicitement la règle.

### D4 — Median latency réel, pas estimation

- **Décision** : `medianHttpLatency7d(url)` fait un `SELECT response_latency_ms FROM service_probes WHERE url = ? AND probed_at >= now-7d ORDER BY response_latency_ms ASC`, puis calcul côté TS. Retourne `null` si < 3 samples.
- **Raison** : SQLite n'a pas de `MEDIAN()` natif. Un estimator (p50 via percentile_disc) demanderait un index dédié. L'N par URL est faible (~0 en prod au 2026-04-19 — `service_probes` est vide depuis la déprécation du paid probe) ; la médiane côté app reste < 1 ms.
- **Garde-fou** : `null` si moins de 3 points — les agents ne traitent pas une "médiane" sur 1 sample comme un signal.

### Strictness tiers

```
strict    → filtre verdict == 'SAFE'                     warnings: []
relaxed   → filtre !RISKY (SAFE + UNKNOWN + INSUFFICIENT) warnings: ['FALLBACK_RELAXED']
degraded  → pool vide après exclusion RISKY              warnings: ['NO_CANDIDATES']
```

RISKY est **toujours** exclu, même en degraded. Le fallback remonte la tolérance sans jamais retourner un candidat dangereux.

---

## Impact sur le code existant

| Fichier | Nature |
|---|---|
| `src/utils/recommendation.ts` (new) | Extraction de `deriveRecommendation` — shared entre `decideService` et `intentService`, évite la duplication de règles et le risque de dérive. |
| `src/utils/categoryValidation.ts` (C1) | Module partagé — regex + alias + normalize + validate. |
| `src/utils/deprecation.ts` (new) | Helpers headers + body meta + log. |
| `src/services/decideService.ts` | Consomme `deriveRecommendation` depuis l'util, supprime la duplication locale. Pas de changement de behavior. |
| `src/controllers/v2Controller.ts` | Ajout `markDeprecated` + `patchDeprecatedBody` sur `decide` + `bestRoute` (path principal + dégradé). |
| `src/repositories/serviceEndpointRepository.ts` | Nouveaux helpers : `findCategoriesWithActive`, `medianHttpLatency7d`, `findCategoryByUrlHash`, `listUrlHashesByCategory`. |
| `src/app.ts` | Wiring : `IntentService` + `IntentController`, routes. |
| `src/openapi.ts` | Paths `/intent` + `/intent/categories` + deprecation flags. |

Pas de migration de schéma DB.

---

## Tests

```
Tests        942 passed (baseline Phase 4 = 909)
Coverage     +33 tests Phase 5
Lint         clean (tsc --noEmit)
```

Ventilation :
- `categoryValidation.test.ts` — 12 tests (C1)
- `intentService.test.ts` — 12 tests (C2)
- `intentApi.test.ts` — 12 tests (C3 + C5)
- `deprecation.test.ts` — 4 tests (C6)
- `v2.test.ts` — +1 test (C6, déprécation headers sur /api/decide)
- `openapi.test.ts` — 4 tests (C7)

---

## Plan de migration des agents

Les agents peuvent migrer à leur rythme. Les endpoints legacy restent fonctionnels et produisent maintenant trois signaux de déprécation :

1. **Header HTTP** : `Deprecation: true` — détecté par les SDK HTTP modernes.
2. **Header HTTP** : `Link: </api/intent>; rel="successor-version"` — pointe explicitement vers l'URL successeur.
3. **Body JSON** : `meta.deprecated_use: "/api/intent"` — visible quand les proxies filtrent les headers.

Warn logs serveur-side tracent chaque call déprécié avec `caller`, permettant de chiffrer l'adoption de `/api/intent` vs. les legacy dans les métriques.

**Suppression envisageable** : earliest Phase 10, après vérification en prod que les legacy endpoints tombent sous 1% du trafic discovery.

---

## Points ouverts

- **Keywords fulltext** : l'implémentation actuelle fait `LIKE %keyword%` sur `name | description | category | provider`. Pour des résultats plus pertinents, envisager FTS5 sur `service_endpoints` — opt-in via index dédié (coût migration).
- **Sort stabilité** : tri stable garanti par `Array.prototype.sort` natif ES2019. Ties sur `p_success`/`ci95_low`/`price_sats` tombent dans l'ordre DB (aujourd'hui `check_count DESC`, raisonnable comme tertiaire implicite).
- **Rate limit dédié** : `/api/intent` partage le `discoveryRateLimit` (10 req/min/IP). Si une adoption aggressive se profile, il faut soit séparer le bucket, soit gatekeep via L402 (comme `/decide`).
- **SDK NLP** : par design, pas de NLP côté serveur. Si un agent humain veut pouvoir écrire en langage naturel, le parsing vit dans le SDK TS. Artefact laissé hors Phase 5.
