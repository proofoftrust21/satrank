# Phase 2 — Anonymous report via `preimage_pool` (design)

**Date** : 2026-04-18
**Branche** : `phase-2-anonymous-report` (basée sur `main` post-Phase-1 merge `15bde13`)
**Schema cible** : v32
**Scope** : spec technique de la voie d'alimentation `preimage_pool` + du chemin `/api/report` anonyme permissionless.

---

## 1. Objectif

Permettre à un agent de reporter sur un service L402 qu'il vient de payer **sans API-key ni NIP-98**. La preuve qu'il a effectivement payé remplace l'identité :
- payer un invoice L402 révèle la `preimage`,
- le serveur peut vérifier `sha256(preimage) == payment_hash`,
- si ce `payment_hash` est présent dans `preimage_pool`, on accepte le report avec un poids gradué par le tier de la source de l'entrée (`crawler` > `intent` > `report`).

Le chemin NIP-98/API-key legacy reste inchangé (poids 1.0). Les reporters anonymes plafonnent à `0.7`.

---

## 2. Schéma v32 — `preimage_pool`

```sql
CREATE TABLE preimage_pool (
  payment_hash         TEXT PRIMARY KEY,
  bolt11_raw           TEXT,
  first_seen           INTEGER NOT NULL,
  confidence_tier      TEXT NOT NULL CHECK(confidence_tier IN ('high', 'medium', 'low')),
  source               TEXT NOT NULL CHECK(source IN ('crawler', 'intent', 'report')),
  consumed_at          INTEGER,
  consumer_report_id   TEXT
);
CREATE INDEX idx_preimage_pool_confidence ON preimage_pool(confidence_tier);
CREATE INDEX idx_preimage_pool_consumed   ON preimage_pool(consumed_at);
```

Invariants :
- `payment_hash` est PRIMARY KEY → `INSERT OR IGNORE` garantit l'idempotence sans jamais écraser une ligne existante (on ne downgrade jamais un tier supérieur).
- `consumed_at IS NULL` exprime la disponibilité one-shot. L'atomicité vient de `UPDATE ... SET consumed_at=? WHERE payment_hash=? AND consumed_at IS NULL` (SQLite sérialise les writes).
- `confidence_tier` strictement 3 valeurs. Mapping tier → poids appliqué au moment du report :
  - `high` → 0.7 (réservé à une future voie pré-signée opérateur)
  - `medium` → 0.5 (crawler trust + intent déclaré)
  - `low` → 0.3 (self-declaration au moment du report, preuve minimale)
- `source` (3 valeurs) ≠ `transactions.source` (4 valeurs `probe`/`observer`/`report`/`intent` — Phase 1 v31). Ces deux colonnes vivent sur des tables distinctes et n'ont pas à être synchronisées.

---

## 3. Les trois voies d'alimentation

### 3.1 Voie 1 — `registryCrawler`

Quand le crawler 402index extrait un BOLT11 d'un header `WWW-Authenticate`, il insère `(payment_hash, bolt11_raw, tier='medium', source='crawler')` dans `preimage_pool` via `insertIfAbsent`.

Justification `tier='medium'` : l'endpoint est répertorié publiquement sur 402index, mais nous n'avons pas vérifié qu'un paiement est plausible (e.g. invoice pas expirée).

Idempotent : un second run ne modifie pas les lignes existantes. Cf. `src/crawler/registryCrawler.ts`.

### 3.2 Voie 2 — `/api/decide` avec `bolt11Raw`

L'agent peut pré-déclarer l'invoice qu'il s'apprête à payer en appelant `POST /api/decide` avec un champ `bolt11Raw` optionnel. Validation zod regex + `parseBolt11` côté controller → `insertIfAbsent(tier='medium', source='intent')`.

Justification `tier='medium'` : l'agent annonce son intention mais n'a pas encore payé. Même poids que crawler pour simplifier le modèle.

Si l'agent ne paie jamais, la ligne reste non consommée sans dommage (tableau à écritures append-only).

### 3.3 Voie 3 — `/api/report` avec `bolt11Raw` self-declared

Si l'agent vient de payer un endpoint non crawlé (hors 402index), il peut fournir le `bolt11Raw` directement dans le body de `/api/report` **ET** la preimage. Le controller :
1. Parse le `bolt11Raw` → extrait `payment_hash_parsed`.
2. Vérifie `payment_hash_parsed == sha256(preimage)` (sinon `BOLT11_MISMATCH` 400, pool inchangé).
3. `insertIfAbsent(tier='low', source='report')`.
4. Continue le flux normal (lookup + consume + submit).

Justification `tier='low'` : le reporter se self-déclare ; aucun tiers n'a validé l'existence de l'endpoint. Preuve minimale mais vérifiable cryptographiquement.

---

## 4. Chemin anonyme `/api/report`

### 4.1 Détection

Le middleware `createReportDispatchAuth` :
- lit `X-L402-Preimage` (prioritaire) ou `body.preimage`,
- vérifie l'absence de `body.reporter`,
- si les deux conditions sont vraies → `req.isAnonymousReport = true` + `req.anonymousPreimage = <64 hex>` + `next()` **sans** invoquer l'auth legacy,
- sinon → délègue à `reportAuth` (API-key/L402).

### 4.2 Pipeline controller

```
validate anonymousReportSchema (zod)
  → payment_hash = sha256(preimage)          // dérivé serveur, jamais trusté du client
  → si bolt11Raw fourni :
      parseBolt11 → vérif match → insertIfAbsent(tier='low', source='report')
  → entry = findByPaymentHash(payment_hash)
      si absent → 400 PREIMAGE_UNKNOWN
  → consumeAtomic(payment_hash, reportId, now)
      si false → 409 DUPLICATE_REPORT
  → submitAnonymous({ reportId, target, paymentHash, tier, outcome, … })
  → 200 { reportId, verified, weight, timestamp,
          reporter_identity: "preimage_pool:<hash>",
          confidence_tier, reporter_weight_applied }
```

### 4.3 `ReportService.submitAnonymous`

- Upsert agent synthétique : `public_key_hash = sha256('preimage_pool:' + paymentHash)`, `source = 'manual'`, `alias = 'anon:<paymentHash[:8]>'`. L'agent satisfait la FK `attester_hash` et `sender_hash` vers `agents(public_key_hash)`.
- Transaction : `tx_id = 'preimage_pool:' + paymentHash`, `source='report'`, `status='verified'`, `preimage=null` (S2 — jamais stocker la preimage brute), `verified=1`. Dual-write forcé à `'active'` parce que la voie 3 est née en v32 et n'a pas à participer au rollout Phase 1.
- Attestation : weight = `tierToReporterWeight(tier)`, category = OUTCOME_CATEGORY[outcome], `evidence_hash = payment_hash`.
- Tout dans une transaction SQLite : si l'un échoue, la pool entry reste consommée mais sans effet de bord (le caller retry sera rejeté par `consumeAtomic`; ce cas d'erreur est rare — FK target manquante, principalement).

### 4.4 Rate limit

Au niveau route, `20/min/IP` pour `/api/report` (bumpé de `5`). Le rate limit par reporter (20/min) du legacy reste actif pour le chemin authentifié. La garantie **one-shot** des anonymes vient exclusivement de `consumed_at` (SQL atomic), pas d'un limiter applicatif.

---

## 5. Tests

17 tests Phase 2 dans `src/tests/anonymousReport/` :

| Fichier | Tests | Couverture |
| --- | --- | --- |
| `bolt11Parser.test.ts` | 5 | parseBolt11 mainnet/testnet, InvalidBolt11Error |
| `preimagePoolRepository.test.ts` | 8 | insertIfAbsent idempotent, consumeAtomic one-shot, race 5 attempts → 1 winner, countByTier, mapping tier→weight |
| `voies12-pool-feed.test.ts` | 5 | voie 1 crawler insert medium + idempotent, voie 2 decide insert intent + absent no-op + malformed 400 |
| `voie3-anonymous-report.test.ts` | 8 | 200 medium, BOLT11_MISMATCH, PREIMAGE_UNKNOWN, DUPLICATE_REPORT, body.preimage fallback, mapping tier/weight, agent synthétique, tx source/status/preimage |
| `integration-sim11.test.ts` | 2 | replay end-to-end, concurrence 2 requêtes → 1 winner + 1 loser |

---

## 6. Distinction rappelée

- `preimage_pool.source` ∈ {`crawler`, `intent`, `report`} — d'où vient la ligne dans le pool.
- `transactions.source` ∈ {`probe`, `observer`, `report`, `intent`} (Phase 1 v31) — comment la tx a été générée.

Une tx issue d'un report anonyme a toujours `transactions.source='report'`, peu importe le `preimage_pool.source` de l'entrée consommée. Les deux colonnes sont orthogonales et n'ont pas à être synchronisées.

---

## 7. Sécurité

- La preimage brute n'est **jamais** stockée (S2). Seul `payment_hash` vit dans `preimage_pool.payment_hash`, `transactions.payment_hash`, `attestations.evidence_hash`.
- `sha256(preimage)` est recalculé côté serveur à chaque requête — jamais trusté du client.
- `bolt11Raw` self-declared est vérifié pour matcher `sha256(preimage)` avant insertion dans le pool (voie 3). Sinon `BOLT11_MISMATCH` 400.
- Pas de rate-limit par `(identity, target)` — `consumed_at` sérialise les tentatives de double-spend sur la même preimage.
- Le reporter anonyme est un agent synthétique de source `manual` avec `alias='anon:<hash8>'` — facile à filtrer dans les queries de scoring si besoin (e.g. exclure anonymes du PageRank).

---

## 8. Ouvertures

- Tier `high` est provisionné (CHECK constraint + mapping 0.7) mais aucune voie n'écrit `high` aujourd'hui. Future voie candidate : le nœud LND de l'oracle lui-même pré-signe une entrée lors d'un probe validé, avec garantie cryptographique forte.
- `consumer_report_id` stocke l'UUID du report qui a consommé l'entrée — utile pour l'audit forensique (corrélation pool ↔ attestation). Pas de cleanup automatique des entrées consommées pour l'instant.
- Le synthetic agent grossit la table `agents` d'une ligne par preimage consommée. À terme, prévoir une purge périodique des anonymes inactifs après N jours.
