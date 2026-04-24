# Phase 6.1 — SDK drift audit (TypeScript + Python)

**Branche :** `phase-6.1-sdk` (branché depuis `origin/main`)
**Date :** 2026-04-22
**Base de comparaison prod :** `src/openapi.ts` + `src/app.ts` (endpoint wiring) à `origin/main`.
**Note Phase 12C :** PR #14 pas encore mergé. Les changements d'énum backend (`observer_protocol` → `attestation`, retrait `observer` de `BucketSource`) ne sont pas encore dans main, mais ils **n'impactent pas le SDK** (voir §4).

---

## 1. Méthodes SDK exposées

### 1.1 TypeScript — `@satrank/sdk` 1.0.0-rc.1

Surface publique (`sdk/src/index.ts`) :

| Classe / fonction              | Signature                                              | Depuis |
|--------------------------------|--------------------------------------------------------|--------|
| `new SatRank(opts)`            | `SatRankOptions → SatRank`                             | rc.1   |
| `sr.fulfill(opts)`             | `FulfillOptions → Promise<FulfillResult>`              | rc.1   |
| `sr.listCategories()`          | `() → Promise<IntentCategoriesResponse>`               | rc.1   |
| `sr.resolveIntent(input)`      | `{category,keywords?,budget_sats?,...} → Promise<IntentResponse>` | rc.1 |
| `parseIntent(text, opts?)`     | subpath `@satrank/sdk/nlp`                             | rc.1   |
| `LndWallet(opts)`              | subpath `@satrank/sdk/wallet`                          | rc.1   |
| `NwcWallet(opts)` + `parseNwcUri` | subpath `@satrank/sdk/wallet`                       | rc.1   |
| `LnurlWallet(opts)`            | subpath `@satrank/sdk/wallet`                          | rc.1   |
| `deriveSharedSecret`, `nip04Encrypt/Decrypt` | subpath `@satrank/sdk/wallet`            | rc.1   |
| Hiérarchie `SatRankError`      | 12 sous-classes (`Balance...`, `Payment...`, etc.)     | rc.1   |

### 1.2 Python — `satrank` 1.0.0rc1

Surface publique (`python-sdk/satrank/__init__.py`) :

| Symbole                        | Équivalent TS            |
|--------------------------------|--------------------------|
| `SatRank(api_base=..., wallet=..., caller=...)` | `new SatRank()`  |
| `sr.fulfill(intent=..., budget_sats=..., ...)` | `sr.fulfill()`   |
| `sr.list_categories()`         | `sr.listCategories()`    |
| `sr.resolve_intent(...)`       | `sr.resolveIntent()`     |
| `LndWallet` / `NwcWallet` / `LnurlWallet` | `@satrank/sdk/wallet` |
| `parse_intent(...)` (satrank.nlp) | `@satrank/sdk/nlp`    |
| 12 erreurs typées              | miroir TS                |

**Observation :** la surface Python est strictement le miroir de TS. Aucun décalage de méthode.

---

## 2. Endpoints prod consommés par le SDK

Le SDK est volontairement **narrow** : il n'appelle que 3 endpoints HTTP.

| Méthode SDK           | Verb + path                     | Auth                           |
|-----------------------|--------------------------------|--------------------------------|
| `listCategories()`    | `GET /api/intent/categories`   | aucune (free discovery)        |
| `resolveIntent()`     | `POST /api/intent`             | aucune (free discovery)        |
| `fulfill()` (interne) | `POST /api/intent` puis fetch candidat + `POST /api/report` optionnel | L402 sur `/api/report` via `depositToken` |

`ApiClient` TS (`sdk/src/client/apiClient.ts`) expose aussi `getAgentVerdict()` **non re-exporté** via `SatRank` — mort-code inerte, pas dans la surface publique. À nettoyer en S2 (pas de drift prod, juste déchet interne).

---

## 3. Inventaire exhaustif des endpoints prod (source = `src/openapi.ts`)

26 endpoints routés sous `/api/*` :

**Agents / scoring** (non utilisés par le SDK 1.0 narrow) :
- `GET /agent/{hash}`
- `GET /agent/{hash}/verdict`
- `GET /agent/{hash}/history`
- `GET /agent/{hash}/attestations`
- `POST /verdicts` (batch 100)
- `GET /agents/top`
- `GET /agents/search`
- `GET /agents/movers`
- `GET /profile/{id}`

**Attestations / reports** :
- `POST /attestations` (free, X-API-Key)
- `POST /report` ✅ *utilisé par `fulfill()` auto-report*

**Système** :
- `GET /health`
- `GET /stats`
- `GET /stats/reports`
- `GET /version`
- `GET /openapi.json`

**Discovery / intent** ✅ *cœur du SDK 1.0* :
- `GET /intent/categories` ✅
- `POST /intent` ✅
- `GET /services`, `/services/best`, `/services/categories`
- `POST /services/register`
- `GET /endpoint/{url_hash}`

**Opérateurs (Phase 7)** :
- `POST /operator/register`, `GET /operators`, `GET /operator/{id}`

**Monétisation / paiement** :
- `POST /deposit` (2-phase invoice)
- `POST /probe` (paid, 5 credits)

**Monitoring / temps-réel** :
- `GET /watchlist`
- `GET /ping/{pubkey}`

**Conclusion :** le SDK couvre 3/26 endpoints (les 3 stables pour le flow discover-pay-deliver). Les 23 autres sont hors scope 1.0 et doivent le rester (pas de surface chargée).

---

## 4. Drifts identifiés

### 4.1 Drift narratif (MINOR — user-visible)

Brief Phase 6.1 demande : `"AI agents"` → `"autonomous agents on Bitcoin Lightning"`. Matches :

| Fichier                           | Ligne | Texte actuel                                                       |
|-----------------------------------|-------|--------------------------------------------------------------------|
| `sdk/package.json`                | 4     | `"SatRank SDK 1.0 — sr.fulfill() for AI agents on Bitcoin Lightning"` |
| `sdk/README.md`                   | 3     | `Client SDK for the SatRank API. Trust scores for AI agents on Bitcoin Lightning.` |
| `python-sdk/pyproject.toml`       | 8     | `"SatRank SDK for AI agents — discover, score, and pay Lightning-native HTTP services"` |

Aucun autre match dans `sdk/` et `python-sdk/` en dehors de README et métadonnées.

**Classification :** MINOR (texte marketing/description, pas d'API change).

### 4.2 README TypeScript désaligné (BREAKING docs)

`sdk/README.md` décrit une classe `SatRankClient` avec ~20 méthodes (`getScore`, `getTopAgents`, `decide`, `report`, `transact`, `watchNostr`, `deposit`, …) qui **n'existe plus dans `sdk/src/`**. La classe exportée est `SatRank` avec 3 méthodes (`fulfill`, `listCategories`, `resolveIntent`). Le README date de la surface SDK 0.x ; la réécriture Phase 6 (narrow 1.0) n'a pas touché la doc.

Impact consommateur :
- `import { SatRankClient } from '@satrank/sdk'` échouerait à la compilation → l'import n'est pas dans `index.ts`.
- Tous les exemples du README sont morts.

**Classification :** BREAKING au niveau documentation (code déjà aligné). Réécriture complète du README obligatoire en S2.

### 4.3 Union `recommendation` incomplète (MINOR — type drift additif)

Serveur (`src/types/index.ts:606` + `src/openapi.ts:558`) :
```ts
export type Recommendation = 'proceed' | 'proceed_with_caution' | 'consider_alternative' | 'avoid';
```

SDK TS (`sdk/src/types.ts:43`) :
```ts
recommendation: 'proceed' | 'proceed_with_caution' | 'avoid';  // 'consider_alternative' manquant
```

SDK Python (`python-sdk/satrank/types.py:88`) : mêmes 3 valeurs, `consider_alternative` absent.

Émis serveur via `src/utils/recommendation.ts:44` quand `advisoryLevel === 'orange'`. Endpoint concerné : `POST /api/intent` (bloc `advisory.recommendation` par candidat).

Impact : un pattern-matching TS exhaustif sur `candidate.advisory.recommendation` rate `consider_alternative` silencieusement. En Python, pas d'erreur runtime (TypedDict permissif) mais type-check `mypy --strict` passera quand même à cause du `Literal` permissif.

**Classification :** MINOR (ajout d'une valeur à une union — additive côté wire, mais consomme-breaking sur pattern-matching exhaustif TS). Correction obligatoire en S2/S3 pour refléter le contrat serveur.

### 4.4 Énums backend (aucun impact SDK)

Changements Phase 12C planifiés (pas encore sur `main` au moment de cet audit) :
- `AgentSource` : `'observer_protocol'` → `'attestation'` (rename)
- `BucketSource` : retrait de `'observer'` (sunset Observer Protocol)

**Recherche dans SDKs** : `grep -r "observer_protocol\|observer" sdk/ python-sdk/` → **0 matches**. Ni les types wire ni les docstrings ne référencent ces enums. Le SDK consomme uniquement des champs stables (`endpoint_url`, `bayesian.verdict`, `advisory.recommendation`, …).

**Classification :** NO-OP côté SDK. À mentionner dans CHANGELOG pour transparence, mais aucune édition de code.

### 4.5 Code mort interne (PATCH — cleanup)

`sdk/src/client/apiClient.ts:62` : méthode `getAgentVerdict()` implémentée, jamais appelée par `SatRank`. À supprimer en S2 (aligner le client sur la surface publique narrow).

**Classification :** PATCH interne, pas de drift fonctionnel.

---

## 5. Classification globale + proposition de version

| Drift                          | Sévérité            | Action                          |
|--------------------------------|---------------------|---------------------------------|
| Narratif "AI agents"           | MINOR               | Rewrite descriptions            |
| README TS désaligné            | BREAKING (docs)     | Réécriture complète README      |
| Union `recommendation`         | MINOR (type additif)| Ajouter `'consider_alternative'` TS + Python |
| Énums backend (12C)            | NO-OP               | Mention CHANGELOG               |
| `getAgentVerdict` mort         | PATCH interne       | Supprimer méthode ApiClient     |

### Proposition de bump

Les deux SDKs sont en **RC (1.0.0-rc.1 / 1.0.0rc1)**. Un RC n'a pas de garantie API — un consommateur qui a épinglé `1.0.0-rc.1` accepte des changements. La Phase 6.1 est le bon moment pour **promouvoir en GA 1.0.0** car :

1. La surface narrow `fulfill()/listCategories()/resolveIntent()` est stable depuis Phase 6 (merge 90ba9c0, 2026-04-19).
2. Les tests SDK sont verts (`sdk/tests/` + `python-sdk/tests/`).
3. Le seul ajout de contrat wire (`consider_alternative`) est additif — un consommateur rc.1 qui ne le match pas explicitement ne casse pas (la valeur arrive comme string au runtime).
4. Le README est mensonger sur la surface publique actuelle — un GA propre corrige le tort.

**Cibles :**
- TypeScript : `1.0.0-rc.1` → **`1.0.0`** (GA)
- Python : `1.0.0rc1` → **`1.0.0`** (GA, aligné)

---

## 6. Estimation d'effort S2→S6

| Étape | Contenu                                              | Estim.    |
|-------|------------------------------------------------------|-----------|
| S2    | TS : union `recommendation`, narrative, README rewrite, cleanup `getAgentVerdict`, bump 1.0.0, `npm run build` + `npm test` | 2h |
| S3    | Python : union `recommendation` (typing.Literal), pyproject narrative, pytest, bump 1.0.0 | 1h |
| S4    | Intégration vs `https://satrank.dev/api/health` + `/api/intent/categories` + `/api/agents/top` (2 SDKs) | 1h |
| S5    | `npm pack` + `python -m build`, CHANGELOGs, RELEASE-NOTES-DRAFT | 1.5h |
| S6    | Report final, commit, push, draft PR #15 avec checklist de publication | 1h |

**Total estimé :** 6.5h. Dans la borne basse du brief user (7-11h). Aucune étape ne dépasse 90 min isolément → pas de report envisageable.

---

## 7. Règles cardinales rappelées (self-check)

- ❌ **PUBLISH GATE absolu** : `npm publish`, `twine upload`, `gh release create`, `git tag v*` → interdits. S5 produit les artefacts dans `sdk/` et `python-sdk/dist/` uniquement.
- ❌ **LND non-négociable** : aucun `openchannel`, `closechannel`, ni ops LN.
- ✅ Si `/api/health` renvoie 500 en S4 → stop immédiat, log, pas de tentative fix prod.
- ✅ Sur ambiguïté : préférer supprimer que conserver (code mort → delete).
- ✅ Branche `phase-6.1-sdk` → pousser avec draft PR #15 pour review Romain.
