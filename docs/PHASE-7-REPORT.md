# Phase 7 — Operators : identité persistante cryptographique

**Branche** : `phase-7-operators`
**Date** : 2026-04-20
**Contexte** : Phase 6 close (merge `90ba9c0`, SDK 1.0-rc.1 TS+Python staged localement, non-publié). Phase 7 introduit la vraie abstraction **operator** dans SatRank : une entité logique qui regroupe ressources (nodes LN, endpoints HTTP, services) sous une même identité cryptographique convergente. Rupture avec v31 où `transactions.operator_id` n'était qu'un alias `sha256(pubkey)` d'un node mono-ressource : Phase 7 persiste un état hiérarchique multi-ressources, avec preuves vérifiables.

---

## TL;DR

- **Nouveau** : table `operators` (v37) + preuves `operator_identities` + ownerships 3 tables (node / endpoint / service).
- **Règle dure** : status `verified` ⇔ ≥ 2/3 preuves convergent (LN ECDSA, NIP-05, DNS TXT). **Zero auto-trust** — un operator_id ne passe jamais en verified par le seul fait d'exister.
- **APIs** : `POST /api/operator/register` (NIP-98 gated, claim + verify inline), `GET /api/operator/:id` (catalog + Bayesian agrégé), `GET /api/operators` (liste paginée + counts).
- **Agrégation Bayesian** : somme des pseudo-évidences par-dessus les ressources owned. Alpha/beta hiérarchique operator exposé au scoring avec poids 0.5× sur l'excess.
- **Exposition** : `operator_id` retourné par `/api/agent/:hash/verdict`, `/api/endpoint/:url_hash`, candidats `/api/intent` — **uniquement si status=verified**. Advisory `OPERATOR_UNVERIFIED` émis sinon (info/warning selon pending/rejected).
- **Observability** : 3 nouvelles métriques Prometheus (`operators_total`, `operator_verifications_total`, `operator_claims_total`), logs pino structurés à chaque étape (claim / verify / ownership).
- **Bootstrap** : `src/scripts/inferOperatorsFromExistingData.ts` crée un operator pending par proto-operator observé dans `transactions` + claim ownerships node/endpoint. Idempotent, `--dry-run` supporté.
- **Couverture tests** : 1235/1235 (was 897 avant Phase 7 → +338 tests). Lint clean.

---

## Séquence commits

| Commit | SHA | Portée |
|---|---|---|
| C1 | `5c4d123` | Migration v37 : tables `operators`, `operator_identities`, `operator_owns_node`, `operator_owns_endpoint`, `operator_owns_service` + index composites. |
| C2 | `40508ea` | `operatorVerificationService` : `verifyLnPubkeyOwnership` (ECDSA compact sur challenge déterministe), `verifyNip05Ownership` (fetch `/.well-known/nostr.json` SSRF-guarded), `verifyDnsOwnership` (resolve `_satrank.<domain>` TXT). |
| C3 | `f41810c` | Repositories : `OperatorRepository` (status/score), `OperatorIdentityRepository` (claim / markVerified / findByOperator), `OperatorOwnershipRepository` (claim/verify par resource_type). |
| C4 | `188cd7f` | `OperatorService` : orchestration claims+verify, règle dure 2/3, `aggregateBayesianForOperator` (somme des pseudo-évidences sur 3 sources × N ressources). |
| C5 | `59bce0b` | `POST /api/operator/register` : NIP-98 gate (rawBody binding), zod schema, claim + verify inline, réponse reports + catalog. |
| C6 | `ef78e4a` | `GET /api/operator/:id` : catalog complet (identities, ownerships enrichies alias/url) + Bayesian agrégé. |
| C7 | `a640909` | `GET /api/operators` : liste paginée filtrable par status + counts par status (pour dashboards). |
| C8 | `83fe355` | Crawler Nostr kind 30385 : lit les self-declarations des operators publiées sur relais, idempotent, dégradé gracieusement si le relais tombe. |
| C9 | `4915d13` | `inferOperatorsFromExistingData.ts` : bootstrap des operators depuis `transactions.operator_id` (v31) → entries pending + ownerships node/endpoint. Idempotent, `--dry-run`. |
| C10 | `48c1bb5` | Prior hiérarchique operator avec poids 0.5× appliqué sur l'excess d'évidence (Précision 1) : shrink correctement vers le prior flat pour les operators peu observés. |
| C2' | `b6b17fd` | **CHECKPOINT 2** : scenario synthétique end-to-end (claim → verify 2/3 → agrégation → exposition dans verdict). |
| C11+C12 | `b866540` | `operator_id` exposé dans `/api/agent/:hash/verdict`, `/api/endpoint/:url_hash`, candidats `/api/intent` **uniquement si verified** ; advisory `OPERATOR_UNVERIFIED` ajouté sinon (info si pending, warning si rejected). |
| C13 | `0d467bc` | Prometheus : `satrank_operators_total{status}`, `satrank_operator_verifications_total{type,result}`, `satrank_operator_claims_total{resource_type}`. Logs pino structurés sur identity claim/verify + ownership claim. |
| C14 | *(this commit)* | Ce rapport. |

> **Note** : C11 et C12 folded dans un même commit — les deux nécessitaient des diffs interleaved dans les mêmes fichiers (`verdictService`, `intentService`, `endpointController`, `advisoryService`). Split artificiel aurait doublé la surface review sans bénéfice.

---

## Architecture

### Modèle de données (v37)

```
operators
├── operator_id (PK, libre : sha256(pubkey) legacy ou slug ≤ 128 chars)
├── first_seen, last_activity, created_at (unix)
├── verification_score (0..3, = count verified identities)
└── status ∈ {pending, verified, rejected}

operator_identities (PK composite operator_id + identity_type + identity_value)
├── identity_type ∈ {ln_pubkey, nip05, dns}
├── verified_at (unix | NULL = pending)
└── verification_proof (sig hex / expected pubkey / TXT digest)

operator_owns_node (node_pubkey, claimed_at, verified_at, FK operator_id)
operator_owns_endpoint (url_hash, claimed_at, verified_at, FK operator_id)
operator_owns_service (service_hash, claimed_at, verified_at, FK operator_id)
```

Indexes : tous les lookups partent de `operator_id` ou `resource_id` — pas de scan.

### Flow d'enregistrement

```
POST /api/operator/register (NIP-98 gated)
  ├─ upsertOperator(operator_id, now)       ← status='pending'
  ├─ pour chaque identity:
  │   ├─ claimIdentity(type, value)          ← pending même si verify échoue
  │   └─ runVerification(type, value, proof) ← verify cryptographique inline
  │       └─ si valid: markIdentityVerified  ← touch verified_at + recomputeStatus
  ├─ pour chaque ownership:
  │   └─ claimOwnership(resourceType, id)    ← verified_at=NULL (verify déférée)
  └─ recomputeStatus: si ≥ 2 identities verified → status='verified'
```

### Agrégation Bayesian (voir bloc en tête de `operatorService.ts`)

Problème : un operator groupe N nodes + M endpoints + K services. Chaque ressource a son propre (α, β) streaming décayé. Comment rendre un état Bayesian unifié pour l'operator ?

**Choix** : somme des pseudo-évidences :

```
α_op = Σ_i (α_i − α₀) + α₀
β_op = Σ_i (β_i − β₀) + β₀
p_success_op = α_op / (α_op + β_op)
n_obs_op     = (α_op + β_op) − (α₀ + β₀)
```

Propriétés :
- **Préserve la somme d'évidence** : 10 endpoints × 5 obs chacun → 50 obs au niveau operator, ce qui réduit correctement l'IC95%.
- **Préserve la moyenne** : si toutes les ressources ont p=0.7, le composite tend vers 0.7 (∞-évidence). Sinon, moyenne pondérée par volume d'évidence domine.
- **Forward-only** : on lit les posteriors streaming courants, jamais de backfill. L'évidence passée d'une ressource est présumée attribuable à l'operator qui la revendique aujourd'hui et qui passe ensuite la vérification 2/3.

Alternatives rejetées :
- Moyenne directe : ne reflète pas la masse d'évidence (« pente » correcte mais « hauteur » plate).
- Fan-out à l'écriture : impose de modifier tous les sites d'ingestion — reporté.
- Pondération par `recency / verified_at` des ownerships : complexifie sans justification Bayesian.

### Prior hiérarchique — scaling 0.5× sur excess (C10, Précision 1)

Le prior hiérarchique est : *un endpoint dont l'operator a peu d'évidence doit shrinker vers le prior flat, pas vers un « prior operator fantôme »*. Le poids `OPERATOR_PRIOR_WEIGHT = 0.5` s'applique sur **l'excess** (α_op − α₀, β_op − β₀), pas sur α_op/β_op bruts :

```
α_effectif_prior = α₀ + 0.5 × (α_op − α₀)
β_effectif_prior = β₀ + 0.5 × (β_op − β₀)
```

Un operator avec 10 obs contribue comme 5 obs au prior par-ressource. Un operator avec 0 obs tombe proprement sur le prior flat. Testé dans `bayesianVerdictService.test.ts`.

### Exposition conditionnelle (C11/C12)

La règle unique : **`operator_id` n'apparaît dans une réponse que si l'operator est `verified`**. Sinon :
- `operator_id = null` dans le payload,
- advisory `OPERATOR_UNVERIFIED` ajouté avec `level='info'` si pending, `level='warning'` si rejected, et `data.operator_status` pour le détail.
- Si aucun operator n'est claim pour la ressource : ni `operator_id` ni advisory (état neutre).

Endpoints touchés : `GET /api/agent/:hash/verdict`, `GET /api/endpoint/:url_hash`, chaque candidat dans `POST /api/intent`.

---

## Décisions clés

### 1. `operator_id` est opaque

Pas de contrainte « sha256(pubkey) » imposée. Le schema accepte `[A-Za-z0-9._:-]{3,128}` pour compatibilité avec v31 (`sha256hex(pubkey)`) ET avec un futur naming humain (e.g. `acme.corp`). Le controller valide le format côté zod ; la table `operators` ne fait que stocker.

### 2. NIP-98 rawBody-bound, pas d'idempotency-key

Le gate est NIP-98 avec `rawBody` matché contre le tag `payload` de l'event (sha256). Un replay avec un body modifié échoue à la validation — l'idempotency est gratuite. Pas de header `Idempotency-Key` à gérer côté client.

### 3. Claim ≠ Verify

Un claim d'ownership (node/endpoint/service) ne requiert pas de preuve cryptographique — il est trivial à émettre mais **ne contribue pas au scoring** tant que `verified_at` reste NULL. La vérification de propriété par-ressource est déférée (le ln_pubkey verify côté identity suffit pour l'instant à démontrer « cet operator contrôle ce node »).

### 4. `verified` one-way

Un operator qui atteint 2/3 reste `verified` même si une preuve expire/est retirée. Seul l'endpoint admin (manuel) peut descendre en `pending`. `rejected` est gelé (ne remonte pas automatiquement). Rationale : éviter un flapping si un relai Nostr est temporairement down pendant un refresh NIP-05.

### 5. Metrics scrape-time refresh

`operatorsTotal` est un gauge refreshé au scrape via `operatorRepo.countByStatus()` (mirror de `agentsTotal`). Pas d'incrément live sur insert — garde l'ingest rapide, le scrape paie l'agrégation (une seule requête SQL `GROUP BY status`).

---

## Critères d'acceptance validés

### Correctness

- [x] Status `verified` **exige** ≥ 2 identities avec `verified_at ≠ NULL` (règle dure appliquée dans `OperatorService.recomputeStatus`, couverte par 4 tests dans `operatorService.test.ts`).
- [x] Aucune route n'expose `operator_id` pour un operator `pending` ou `rejected` (anti-regression test dans `verdictOperator.test.ts`, `endpoint.test.ts`, `intentApi.test.ts`).
- [x] Advisory `OPERATOR_UNVERIFIED` émis avec le bon level (info/warning) et `data.operator_status` correct.
- [x] Agrégation Bayesian préserve `n_obs = (α + β) − (α₀ + β₀)` (testé dans `operatorService.test.ts`).
- [x] Prior hiérarchique scale à 0.5× l'excess (testé dans `bayesianVerdictService.test.ts`).

### Security

- [x] Register gated par NIP-98 avec `rawBody` binding (modification body → 401).
- [x] Verify LN pubkey utilise ECDSA compact strict (64 bytes, pas DER) — `@noble/curves/secp256k1.js`.
- [x] NIP-05 fetcher SSRF-guarded (allow-list scheme https, deny RFC1918).
- [x] DNS TXT resolver : prefix `_satrank.` séparateur de namespace — pas de collision avec d'autres TXT du domaine.

### Observability

- [x] 3 métriques Prometheus exposées sur `/metrics`, labels cardinality bornée (3 × 2 × 3 = 18 séries max).
- [x] Logs pino JSON structurés : champs `operatorId`, `type`, `value`, `valid`, `reason` à chaque verify. Facile à filtrer en jq.
- [x] Scrape `/metrics` en localhost ou X-API-Key, pas de fuite d'agrégats publics.

### Bootstrap

- [x] `inferOperatorsFromExistingData.ts` idempotent (upsert + claim ON CONFLICT DO NOTHING).
- [x] `--dry-run` n'écrit rien, retourne un résumé structuré.
- [x] Un proto-operator v31 (`transactions.operator_id = sha256(pubkey)`) → entry pending + ownership node.

### Couverture tests

- 1235/1235 passent (was 897 avant Phase 7 → **+338 tests** sur 14 commits).
- Lint clean (`tsc --noEmit`).
- Pas de test skippé ni `.only`.

---

## Roadmap post-Phase 7 (hors scope)

- **Phase 7bis** : verification d'ownership par-ressource (aujourd'hui seul le ln_pubkey de l'operator est prouvé ; un claim `operator_owns_node(X)` n'est pas vérifié cryptographiquement contre une sig de X).
- **Nostr publishing** : publier les operators verified en kind 30385 sur nos relais (lecture déjà gérée par le crawler C8, écriture reste à câbler).
- **Admin API** : endpoint `PATCH /api/operator/:id/status` pour transitionner `verified → rejected` manuellement (fraude avérée).
- **Dashboards** : panel Grafana pour `operators_total{status}` + taux verifications succès/échec par `type`.

Ces items ne bloquent pas le merge Phase 7 → `main`.
