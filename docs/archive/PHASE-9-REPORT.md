# Phase 9 — Deposit tiers + /api/probe

**Branche** : `phase-9-deposit-tiers-probe`
**Date** : 2026-04-20
**Contexte** : Phase 8 close (merge `2af2677`, multi-kind Nostr publishing actif en prod, schema v38). Phase 9 introduit (a) les **paliers de deposit** — 5 niveaux gradués qui gravent le taux au moment du paiement, donnant un rabais jusqu'à 95% à partir de 1 000 000 sats ; (b) un nouveau endpoint **`POST /api/probe`** qui permet à un agent de demander à SatRank de sonder un endpoint L402 tiers end-to-end (fetch → 402 → pay → retry → response) en le facturant 5 credits ; (c) deux migrations SQL (v39 paliers + colonnes gravées, v40 widening du CHECK `transactions.source` pour accueillir `'paid'`).

---

## TL;DR

- **Nouveau** : table `deposit_tiers` (v39) + colonnes gravées `rate_sats_per_request`, `tier_id`, `balance_credits` sur `token_balance` ; CHECK `transactions.source` widened à `{'probe','observer','report','intent','paid'}` (v40).
- **Règle dure** : le taux est **gravé à l'INSERT** depuis `deposit_tiers` et **immuable** — même si la grille de tarifs change demain, les tokens déjà émis conservent leur rate d'origine. Zero rétro-activité.
- **APIs** : `GET /api/deposit/tiers` (schedule public, non authentifié), `POST /api/deposit` (inchangé en surface, grave désormais le tier), `POST /api/probe` (5 credits, L402 gated, rate-limited).
- **Probe flow** : SatRank paye lui-même l'invoice L402 du target via son nœud LN, retourne la telemetry (status, latencyMs, bodyHash, paidSats), écrit une `transactions` row `source='paid'` dans le 6h window bucket courant, et bump les streaming posteriors avec `weight=2.0` (signal fort — SatRank a risqué des sats en propres).
- **Rate limits** : 10/h par token + 100/h global. Ordre `apertureGateAuth → perToken → global → balanceAuth → handler` — un 429 ne consomme jamais de credits.
- **Dual mode permanent** : les tokens Phase 9 (deposit avec rate gravé) et les tokens legacy Aperture auto-créés (rate `NULL`) **cohabitent sans migration**. Chaque branche lit sa propre colonne (`balance_credits` vs `remaining`). Voir §Compatibility.
- **Observability** : 5 nouvelles métriques Prometheus pour `/api/probe`, 2 labels ajoutés à `satrank_rate_limit_hits_total`. Logs pino structurés avec outcome + phase timings.
- **Couverture tests** : 1443/1443 (était 1398 avant Phase 9 → +45 tests). Lint clean.

---

## Séquence commits

| Commit | SHA | Portée |
|---|---|---|
| C1 | `8dc6e81` | Migration v39 : table `deposit_tiers` seedée avec 5 paliers (21→1.0 / 1000→0.5 / 10000→0.2 / 100000→0.1 / 1000000→0.05) + colonnes `rate_sats_per_request`, `tier_id`, `balance_credits` sur `token_balance`. Rollback inclus. |
| C2 | `2a4a159` | `DepositService.createPhase9Token` : lookup du tier depuis `deposit_tiers` par `max(min_deposit_sats ≤ amount)`, INSERT avec rate gravé + `balance_credits = amount / rate`. Le tier est immuable post-INSERT. |
| C3 | `b83719a` | `balanceAuth` : double path atomique — `UPDATE balance_credits` pour tokens Phase 9 (rate IS NOT NULL), fallback `UPDATE remaining` pour legacy. Header `X-SatRank-Balance` normalisé sur les deux axes. |
| C4 | `2e1bfba` | Script `migrateExistingDepositsToTiers.ts` : assigne un tier aux deposits pre-Phase 9 (rate IS NULL, amount > 0) en lookup-ant le tier applicable. `--dry-run` pour audit, idempotent. |
| C5 | `94056eb` | `GET /api/deposit/tiers` : endpoint public (pas d'auth) qui retourne la schedule complète `[{min_deposit_sats, rate_sats_per_request, discount_pct}…]` triée ascendant. Rate limit discovery (10/min/IP). |
| C6 | `17e2a99` | `POST /api/probe` core : fetch → parse L402 challenge → parse BOLT11 → guard `PROBE_MAX_INVOICE_SATS` → `lndClient.payInvoice` → retry avec `Authorization: L402 <mac>:<preimage>` → telemetry. 5 credits (1 via `balanceAuth`, 4 atomiquement dans le controller). Garde `PROBE_UNAVAILABLE` si l'admin macaroon n'est pas monté. |
| C7 | `0fc66d2` | Migration v40 widen `transactions.source` CHECK → ajoute `'paid'`. `ProbeController.ingestObservation` écrit une tx dual-write (`source='paid'`, `status = secondFetch==200 ? 'verified' : 'failed'`) et bump le streaming posterior avec `weight=2.0` via `WEIGHT_PAID_PROBE`. Idempotence par bucket 6h : `txId = sha256("paid:"+endpHash+":"+bucket)`. |
| C8 | `d17c29e` | Middleware `probeRateLimit` : `perToken` (10/h keyé sur `payment_hash`, fallback IP) + `global` (100/h constant). Ordre `apertureGateAuth → perToken → global → balanceAuth` — un 429 ne décrémente pas `balance_credits`. Labels Prometheus `probe_per_token` + `probe_global` sur `satrank_rate_limit_hits_total`. |
| C9 | `5637458` | Prometheus : `satrank_probe_total{outcome}`, `satrank_probe_sats_paid_total`, `satrank_probe_ingestion_total{reason}`, `satrank_probe_duration_seconds`, `satrank_probe_invoice_sats`. Log structuré `event="probe_complete"` avec `outcome` + timings par phase + `paymentHashPrefix`. |
| C10 | *(this commit)* | Ce rapport. |

---

## Architecture

### Deposit tiers (v39)

```
deposit_tiers                  (read-only après seed)
├── tier_id (PK AUTOINC)
├── min_deposit_sats (UNIQUE)
├── rate_sats_per_request (REAL)   ← 1.0, 0.5, 0.2, 0.1, 0.05
├── discount_pct (INTEGER)          ← affichage client
└── created_at

token_balance                  (étendue — nouvelles colonnes nullables)
├── payment_hash (PK)
├── remaining (axe legacy)
├── max_quota
├── rate_sats_per_request (REAL | NULL)     ← GRAVÉ à l'INSERT, immuable
├── tier_id (INTEGER | NULL → deposit_tiers)
└── balance_credits (REAL, default 0)       ← axe Phase 9, unités=requêtes
```

**Calcul** : `balance_credits = amount_sats / rate_sats_per_request`. Un deposit de 10 000 sats avec tier 3 (rate 0.2) = 50 000 credits.

**Immuabilité** : le rate est gravé à l'`INSERT INTO token_balance`. Un adjustement futur des rates dans `deposit_tiers` n'affecte **aucun token existant**. C'est la garantie contractuelle que les agents payent.

### Flow /api/probe

```
POST /api/probe  { url: "https://l402.services/geoip/8.8.8.8" }
Authorization: L402 <macaroon>:<preimage>

  ├─ apertureGateAuth     ← valide le L402 token (shared secret Aperture)
  ├─ probeLimits.perToken ← 10/h/token, keyé sur sha256(preimage)
  ├─ probeLimits.global   ← 100/h, keyé sur 'global'
  ├─ balanceAuth          ← décrémente balance_credits de 1 (uniforme)
  └─ probeController.probe
      ├─ zod body schema
      ├─ canPayInvoices() gate       ← 503 PROBE_UNAVAILABLE si macaroon absent
      ├─ debit 4 credits supplémentaires (total = 5)
      ├─ performProbe(url):
      │   ├─ fetch(url, timeout=PROBE_FETCH_TIMEOUT_MS)
      │   ├─ detect 402 + WWW-Authenticate L402
      │   ├─ parse BOLT11 invoice (bolt11Parser)
      │   ├─ guard amountSats ≤ PROBE_MAX_INVOICE_SATS
      │   ├─ lndClient.payInvoice(invoice, feeLimit=50)
      │   └─ fetch(url, { Authorization: "L402 <mac>:<preimage>" })
      ├─ probeTotal{outcome}.inc       ← success_200 | payment_failed | …
      ├─ probeSatsPaidTotal.inc(invoiceSats)
      ├─ probeDuration.observe(ms/1000)
      ├─ probeInvoiceSats.observe(sats)
      └─ ingestObservation(url, result) ← best-effort, jamais ne lève
          ├─ canonicalizeUrl + lookup service_endpoints
          ├─ txId = sha256("paid:"+endpHash+":"+windowBucket)
          ├─ txRepo.insertWithDualWrite({source:'paid', …})
          ├─ bayesian.ingestStreaming({source:'paid', weight=2.0, …})
          └─ probeIngestionTotal{reason}.inc
```

### Poids Bayesian — pourquoi `weight=2.0`

`source='paid'` → `WEIGHT_PAID_PROBE = 2.0` (vs 1.0 pour `'probe'` et `'report'`, 0.5 pour `'observer'`). Justification : SatRank a **paid sats réels** via son propre nœud pour cette observation. Elle est non-spoofable par un acteur externe (l'attaquant devrait contrôler l'endpoint ET faire payer SatRank, double coût). Le signal est donc deux fois plus fiable qu'une self-reported observation `'probe'` où un agent spam pourrait polluer.

---

## Compatibility and dual mode

**Principe** : Phase 9 introduit un **dual mode permanent** de tokens L402. Il n'y a PAS de migration forcée des tokens legacy — ils continuent de fonctionner indéfiniment sous leur logique d'origine. C'est un design intentionnel, documenté dans `project_phase9_dual_mode.md` de la mémoire projet.

### Les deux univers

| Dimension | **Tokens Phase 9** (deposit avec tier) | **Tokens legacy** (Aperture auto-créés) |
|---|---|---|
| Création | `POST /api/deposit` → paiement → register | Premier L402 challenge de n'importe quel endpoint payant, auto-insert par `balanceAuth` |
| `rate_sats_per_request` | 0.05 à 1.0 (gravé) | `NULL` |
| `tier_id` | 1 à 5 | `NULL` |
| `balance_credits` | > 0 (= amount / rate) | 0 (non utilisé) |
| `remaining` | non utilisé (0) | `21 - usage` |
| `max_quota` | = deposit amount | 21 (historique fixe) |
| Decrement axis | `UPDATE balance_credits - 1` | `UPDATE remaining - 1` |
| Refund axis | `UPDATE balance_credits + 1` | `UPDATE remaining + 1` |
| /api/probe eligible ? | **oui** (si ≥ 5 credits) | **non** (garde `rate IS NOT NULL` sur le debit) |
| Préfixe Authorization | `L402 deposit:<preimage>` | `L402 <macaroon>:<preimage>` |
| Nginx route | directement vers Express (bypass Aperture) | via Aperture proxy |

### Implémentation

`balanceAuth` (src/middleware/balanceAuth.ts) tente le path Phase 9 d'abord, fallback au path legacy :

```typescript
let changes = stmtDecrementCredits.run(paymentHash).changes;  // rate IS NOT NULL
if (changes === 0) changes = stmtDecrementLegacy.run(paymentHash).changes;  // rate IS NULL
```

Chaque statement est atomique en SQLite, et les clauses `WHERE rate_sats_per_request IS {NOT,} NULL` garantissent qu'aucun token n'est décrémenté deux fois. Le header `X-SatRank-Balance` est normalisé : pour un token legacy il reflète `remaining`, pour un Phase 9 il reflète `balance_credits`.

### Ce qui est **hors périmètre** Phase 9

- **Sunset des tokens legacy** : pas prévu. Les tokens Aperture ont un stock fini (21 requêtes) et s'éteignent naturellement à l'usage. Un sunset forcé casserait des intégrations existantes sans bénéfice.
- **Interdire la création de tokens legacy** : pas non plus. Aperture auto-crée un token legacy la première fois qu'un caller sans `L402 deposit:` header frappe `/api/decide`. Retirer ce fallback couperait l'expérience try-before-buy.

### Ce qui est **gated strict** sur Phase 9

- `POST /api/probe` est réservé aux tokens Phase 9 (`rate IS NOT NULL`). Un token legacy reçoit `402 INSUFFICIENT_CREDITS` même s'il a du `remaining`. Raison : la mécanique de 4-credit debit (`PROBE_EXTRA_CREDITS = 4`) n'a de sens que sur l'axe `balance_credits`.

---

## API consumer examples

### 1. Lire la grille de tarifs (public, sans auth)

```bash
curl -s https://satrank.dev/api/deposit/tiers | jq
```

```json
{
  "data": [
    { "min_deposit_sats": 21,      "rate_sats_per_request": 1.0,  "discount_pct": 0 },
    { "min_deposit_sats": 1000,    "rate_sats_per_request": 0.5,  "discount_pct": 50 },
    { "min_deposit_sats": 10000,   "rate_sats_per_request": 0.2,  "discount_pct": 80 },
    { "min_deposit_sats": 100000,  "rate_sats_per_request": 0.1,  "discount_pct": 90 },
    { "min_deposit_sats": 1000000, "rate_sats_per_request": 0.05, "discount_pct": 95 }
  ]
}
```

### 2. Deposit à tier 3 (10 000 sats → 50 000 credits)

```bash
# Step 1 — demander l'invoice
curl -s -X POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d '{"amount": 10000}'
# { "data": { "invoice": "lnbc100…", "paymentHash": "deadbeef…", "expiresAt": 1776700000 } }

# Step 2 — payer l'invoice via votre wallet LN

# Step 3 — register le token
curl -s -X POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d '{"paymentHash": "deadbeef…", "preimage": "<hex>"}'
# { "data": { "balance_credits": 50000, "rate_sats_per_request": 0.2, "tier_id": 3,
#             "authorization_header": "L402 deposit:<preimage>" } }
```

### 3. Probe d'un endpoint L402 tiers

```bash
curl -s -X POST https://satrank.dev/api/probe \
  -H "Authorization: L402 deposit:$PREIMAGE" \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://l402.services/geoip/8.8.8.8"}'
```

Réponse :

```json
{
  "data": {
    "url": "https://l402.services/geoip/8.8.8.8",
    "target": "L402",
    "firstFetch": { "status": 402, "latencyMs": 210 },
    "l402Challenge": {
      "macaroonLen": 240,
      "invoiceSats": 1,
      "invoicePaymentHash": "7ed98bac…"
    },
    "payment": {
      "paymentHash": "7ed98bac…",
      "preimage": "ab12cd…",
      "durationMs": 840
    },
    "secondFetch": {
      "status": 200,
      "latencyMs": 185,
      "bodyBytes": 312,
      "bodyHash": "3f2e…",
      "bodyPreview": "{\"ip\":\"8.8.8.8\",\"country\":\"US\",…"
    },
    "totalLatencyMs": 1240,
    "cost": { "creditsDeducted": 5 }
  }
}
```

Headers pertinents sur la réponse :

- `X-SatRank-Balance: 49995` — 50 000 credits − 5 consommés par ce probe.
- `RateLimit-Limit: 10` + `RateLimit-Remaining: 9` — headers `standardHeaders` du per-token limiter.

### 4. SDK TypeScript

```typescript
import { SatRank } from '@satrank/sdk';

const sr = new SatRank({ token: process.env.SATRANK_TOKEN });
const probe = await sr.probe('https://l402.services/geoip/8.8.8.8');
if (probe.secondFetch?.status === 200) {
  console.log('endpoint paid+served OK, cost:', probe.cost.creditsDeducted);
}
```

*(Note : le SDK 1.0-rc.1 embarqué dans le repo n'a pas encore la méthode `.probe()` — ajout Phase 9bis si les consumers demandent.)*

---

## Observability

### Métriques Prometheus (nouvelles en Phase 9)

| Métrique | Labels | Rôle |
|---|---|---|
| `satrank_probe_total` | `outcome` | Terminal outcomes par probe : `success_200`, `success_non200`, `payment_failed`, `invoice_too_expensive`, `upstream_not_l402`, `upstream_unreachable`, `probe_unavailable`, `insufficient_credits`, `validation_error`, `bolt11_invalid`. |
| `satrank_probe_sats_paid_total` | — | Sats cumulés payés par SatRank sur les L402 externes. Rate 1h = burn rate. |
| `satrank_probe_ingestion_total` | `reason` | Outcome du step Bayesian : `ingested`, `no-deps`, `not-l402`, `no-payment`, `endpoint-not-found`, `endpoint-no-operator`, `operator-agent-missing`, `duplicate`, `tx-write-failed`. |
| `satrank_probe_duration_seconds` | — | Histogramme bout-en-bout (fetch + pay + retry). Buckets 0.25s à 60s. |
| `satrank_probe_invoice_sats` | — | Distribution des prix d'invoices vus. Détecte un operator qui monte ses prix. |
| `satrank_rate_limit_hits_total` | `limiter ∈ {probe_per_token, probe_global, …}` | Nouveaux labels sur un counter existant. |

### Logs structurés (pino JSON)

Chaque probe complet émet une ligne info :

```json
{
  "level": 30,
  "msg": "probe complete",
  "event": "probe_complete",
  "url": "https://l402.services/geoip/8.8.8.8",
  "target": "L402",
  "outcome": "success_200",
  "firstStatus": 402,
  "firstLatencyMs": 210,
  "invoiceSats": 1,
  "paymentHashPrefix": "7ed98bac1f2a",
  "paidOk": true,
  "paymentDurationMs": 840,
  "secondStatus": 200,
  "secondLatencyMs": 185,
  "secondBodyBytes": 312,
  "totalMs": 1240
}
```

### Alertes suggérées

- `rate(satrank_probe_total{outcome="payment_failed"}[5m]) > 0.1` → LND dégradé (pas de route, peer down, liquidity).
- `increase(satrank_probe_sats_paid_total[1h]) > 5000` → spike de dépense anormal (attaque ou bug rate-limit).
- `rate(satrank_rate_limit_hits_total{limiter="probe_global"}[5m]) > 0` → attaque coordonnée multi-tokens.
- `rate(satrank_probe_ingestion_total{reason="tx-write-failed"}[5m]) > 0` → bug critique dans le dual-write.
- Histogram p99 `satrank_probe_duration_seconds > 30` → target hors SLA ou LND saturé.

---

## Plan de déploiement prod

### Pré-requis — bake de l'admin macaroon scopé

`/api/probe` exige un macaroon LND capable de `payInvoice`. Le macaroon admin complet ouvre aussi `openchannel`/`closechannel`/`forceclose` — **trop large**. On bake un macaroon scopé strict.

```bash
# Sur le serveur prod, connecté à lncli :
lncli bakemacaroon \
    --save_to /home/bitcoin/.lnd/data/chain/bitcoin/mainnet/probe-pay.macaroon \
    offchain:read offchain:write

# Permissions & ownership — le fichier doit être lisible par le user UID
# qui tourne satrank-api (sous docker, root → UID 0).
chmod 600 /home/bitcoin/.lnd/data/chain/bitcoin/mainnet/probe-pay.macaroon
```

**Périmètre** : `offchain:read offchain:write` = SendPaymentSync/V2 + DecodePayReq + TrackPayment. **Refuse explicitement** : onchain:\*, address:\*, invoices:\* (garde le read-only existant), peers:\*, macaroon:\*.

### Mount dans le container

Ajouter au `docker-compose.yml` (section `satrank-api`) :

```yaml
services:
  satrank-api:
    volumes:
      # ... (existing)
      - /home/bitcoin/.lnd/data/chain/bitcoin/mainnet/probe-pay.macaroon:/app/data/probe-pay.macaroon:ro
    environment:
      # ... (existing)
      LND_ADMIN_MACAROON_PATH: /app/data/probe-pay.macaroon
```

### Ordre de déploiement

1. **Rebuild image phase-9** depuis le branch (après merge sur main ou direct depuis le branch pour test) :
   ```bash
   cd /opt/satrank
   git fetch origin && git checkout <main-after-merge>
   docker compose build satrank-api
   ```

2. **Sync le docker-compose.yml + .env.production** avec le nouveau volume + `LND_ADMIN_MACAROON_PATH` :
   ```bash
   make deploy    # utilise la liste d'exclusions du Makefile (jamais --delete brut)
   ```

3. **Force-recreate le container** (recompose ne détecte pas toujours les nouveaux volumes) :
   ```bash
   docker compose up -d --force-recreate satrank-api
   ```

4. **Observer les migrations** — v39 + v40 tournent automatiquement au boot :
   ```bash
   docker logs satrank-api 2>&1 | grep -i migration | tail -10
   # Doit afficher : "Migrations executed successfully" + "schemaVersion=40"
   ```

### Sanity checks post-deploy

**Check 1 — /api/deposit/tiers retourne les 5 paliers** :

```bash
curl -s https://satrank.dev/api/deposit/tiers | jq '.data | length'
# Attendu : 5
```

**Check 2 — /api/probe test de la garde PROBE_UNAVAILABLE** (si macaroon pas monté ou path wrong) :

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://satrank.dev/api/probe \
  -H "Authorization: L402 deposit:$PREIMAGE" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://l402.services/geoip/8.8.8.8"}'
# Attendu sans macaroon : 503  (code="PROBE_UNAVAILABLE")
# Attendu avec macaroon : 200 (si crédits)
```

**Check 3 — /api/health confirme schema v40** :

```bash
curl -s https://satrank.dev/api/health | jq '.data | {schemaVersion,expectedSchemaVersion,lndStatus}'
# Attendu : { "schemaVersion": 40, "expectedSchemaVersion": 40, "lndStatus": "ok" }
```

**Check 4 — Probe réel contre l4oEndpoint l402.services/geoip pour 1 sat** (après mount macaroon, avec un deposit token valide) :

```bash
# Deposit 1000 sats → tier 2 → 2000 credits
INVOICE=$(curl -sX POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d '{"amount":1000}' | jq -r .data.invoice)
# [payer INVOICE avec son wallet LN]
TOKEN=$(curl -sX POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d "{\"paymentHash\":\"$HASH\",\"preimage\":\"$PREIMAGE\"}" \
  | jq -r .data.authorization_header)

# Probe (coût : 5 credits + 1 sat LN)
curl -sX POST https://satrank.dev/api/probe \
  -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://l402.services/geoip/8.8.8.8"}' \
  | jq '.data | {target, secondStatus: .secondFetch.status, paidOk: .payment.preimage != "", totalMs: .totalLatencyMs}'
# Attendu : { "target":"L402", "secondStatus":200, "paidOk":true, "totalMs":<3000 }
```

**Check 5 — /metrics confirme les nouveaux compteurs présents** :

```bash
curl -s http://localhost:3000/metrics | grep -E '^satrank_probe_' | head -10
# Attendu : satrank_probe_total{outcome="success_200"} 1
#           satrank_probe_sats_paid_total 1
#           satrank_probe_invoice_sats_bucket{le="1"} 1
#           …
```

### Rollback d'urgence

Si une régression critique :

```bash
docker compose down satrank-api
# Rollback schema v40 → v38 (v39 tiers restent, v40 source='paid' rollbackée)
docker run --rm -v satrank_satrank-data:/app/data satrank:<previous> \
  npm run rollback:prod -- --target 38
# Repartir sur l'image précédente
docker compose up -d satrank-api
```

Les tokens Phase 9 créés pendant la fenêtre restent valides (columns v39 pas touchées), mais `/api/probe` disparaît (route-level 404).

---

## Ce qui n'est PAS dans Phase 9

- **Démo end-to-end Checkpoint 2 sur prod** : différée au Checkpoint Final (prod n'a pas d'admin macaroon avant le deploy). Décision documentée — éviter de déployer `/api/probe` sans rate limits (C8) en prod.
- **SDK .probe()** : le SDK 1.0-rc.1 ne propose pas encore de wrapper client. Ajout trivial si les consumers convergent sur un pattern partagé (Phase 9bis).
- **Sunset des tokens legacy** : hors périmètre (voir §Compatibility).
- **Tarification dynamique par palier** : les 5 paliers sont figés à seed. Changer un rate demande un migration + garantie d'immuabilité des tokens déjà gravés.
- **Multi-probe batch** : un seul URL par requête. Batching prévu Phase 10 si signal.
- **Retry automatique sur `payment_failed`** : un probe = un essai. Le caller peut re-tenter — ça coûte un nouveau 5-credit debit.

---

## Commandes utiles

```bash
# Test suite complète
npm test

# Tests Phase 9 seuls
npx vitest run \
  src/tests/probeController.test.ts \
  src/tests/probeControllerIngest.test.ts \
  src/tests/probeRateLimit.test.ts \
  src/tests/probeMetrics.test.ts \
  src/tests/depositTierService.test.ts \
  src/tests/migrations.test.ts \
  src/tests/modules.test.ts

# Dry-run du script de migration des deposits existants
npx tsx src/scripts/migrateExistingDepositsToTiers.ts --dry-run

# Deploy prod (après bake macaroon + sync compose)
make deploy && ssh root@178.104.108.108 \
  "cd /opt/satrank && docker compose up -d --force-recreate satrank-api"

# Check schema prod
ssh root@178.104.108.108 'curl -s http://127.0.0.1:3000/api/health | jq .data.schemaVersion'
```

---

**Revue demandée** : Romain, avant merge + deploy, relire `§Compatibility and dual mode` et `§Plan de déploiement prod` — en particulier le scope du macaroon `offchain:read offchain:write` et l'ordre de sanity checks. Go/no-go à donner au Checkpoint Final.
