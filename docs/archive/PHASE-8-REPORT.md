# Phase 8 — Nostr multi-kind publishing

**Branche** : `phase-8-nostr-multi-kind`
**Date** : 2026-04-20
**Contexte** : Phase 7 close (merge `8ffa1f8`, abstraction operators + identity verification + prior hiérarchique). Phase 8 étend la distribution Nostr au-delà du kind 30382 (NIP-85 single-source) hérité : publication multi-kind 30382 (node) / 30383 (endpoint) / 30384 (service) avec delta-filter, cache replay-resistant, et flashes éphémères kind 20900 sur transitions de verdict.

---

## TL;DR

- **Nouveau** : scheduler cron 5 min qui scanne les streaming posteriors modifiés, délègue à un publisher multi-kind, et maintient un cache `nostr_published_events` (1 row par `(entity_type, entity_id)`).
- **Delta filter** : `shouldRepublish()` à 4 critères (verdict change, advisory palier, \|Δp_success\| ≥ 0.05, \|Δn_obs\| ≥ +20%) empêche la republication d'un event qui ne change rien de significatif.
- **Fast-path hash** : même si `shouldRepublish=true`, on compare le `payload_hash` canonique (tags sortés SHA256) au cache — évite un round-trip relais pour des diffs sous le seuil d'arrondi des tags.
- **Flashes éphémères** : kind 20900 (NIP-01 range 20000-29999 broadcast-only) émis sur transition de verdict SAFE/RISKY/UNKNOWN (INSUFFICIENT exclu = bruit d'échantillonnage). Best-effort — un échec flash n'annule pas l'endorsement 30383/30382 déjà ack.
- **NIP-09 deletion** : kind 5 implémenté, flag `NOSTR_NIP09_ENABLED=false` par défaut. Raisonnement : NIP-33 replaceable rend la deletion redondante ; gardé en réserve pour Phase 8bis ou retrait massif (clé compromise).
- **Observability** : 5 nouvelles métriques Prometheus (`events_published_total`, `flashes_total`, `republish_skipped_total`, `relay_errors_total`, `publish_duration_seconds`). Logs pino structurés avec kind/entityId/latencyMs/per-relay acks.
- **Opt-in** : `NOSTR_MULTI_KIND_ENABLED=false` par défaut — coexiste avec le NIP-85 legacy jusqu'à validation prod.
- **Couverture tests** : 1320/1320 (was 1308 avant Phase 8). Lint clean.

---

## Séquence commits

| Commit | SHA | Portée |
|---|---|---|
| C1 | `f5d70da` | Migration v38 : table `nostr_published_events` (entity_type, entity_id, event_id, event_kind, published_at, payload_hash, verdict, advisory_level, p_success, n_obs_effective) avec PK composite + index sur event_kind. |
| C2 | `dcca627` | Event builders : `buildNodeEndorsement` (30382), `buildEndpointEndorsement` (30383), `buildServiceEndorsement` (30384). `payloadHash()` canonique (tags triés + JSON + SHA256), indépendant de `created_at`. |
| C3 | `83fed49` | `NostrMultiKindPublisher` : signe via `nostr-tools` (import ESM dynamique), broadcast parallèle sur tous les relais, agrégation des acks par relai (success/timeout/error). Tests d'injection des bindings. |
| C4 | `e7b1632` | `shouldRepublish()` : décision pure 4 critères. Tests exhaustifs sur chaque branche + cas limites (première publication, verdict crossing, palier advisory). |
| C5 | `22fd334` | `NostrMultiKindScheduler` : cron 5 min, scan endpoints + nodes, intégration cache. Config env vars + block dans `crawler/run.ts` gated par `NOSTR_MULTI_KIND_ENABLED`. `phase8Demo.ts` commité (one-shot demo re-runnable). |
| C6 | `6726b00` | Flashes kind 20900 : `buildVerdictFlash` (pas de d-tag, p-tag seulement pour nodes, `from_verdict='NONE'` au premier publish), `publishVerdictFlash`, `emitFlash` best-effort dans le scheduler, `isVerdictTransition` pure (exclut null et INSUFFICIENT). |
| C7 | `dd94840` | Fast-path `payload_hash` dans scanEndpoints + scanNodes (skippedHashIdentical counter). `findByEventId` (pour NIP-09) + `latestPublishedAtByType` (pour /metrics). `phase8Demo2.ts` : demo end-to-end des 3 scénarios Checkpoint 2. |
| C8 | `be6fa0b` | `NostrDeletionService` (NIP-09 kind 5) : `buildDeletionRequest(eventId, kind, reason?)`, `requestDeletion(entityType, entityId)` + variante `requestDeletionByEventId`, flag OFF par défaut. Cache purgée après publish réussi. |
| C9 | `64d8f01` | 5 métriques Prometheus (`events_published_total{kind,result}`, `flashes_total{type}`, `republish_skipped_total{reason}`, `relay_errors_total{relay,result}`, `publish_duration_seconds{kind}`). Log structuré à chaque publish (kind/eventId/latencyMs/acks). |
| C10 | *(this commit)* | Ce rapport. |

---

## Architecture

### Flow complet par cycle cron (5 min)

```
scheduler.runScan(now)
  ├─ scanEndpoints (endpoint_streaming_posteriors.last_update_ts >= now - window)
  │   └─ pour chaque url_hash modifié :
  │       ├─ buildEndpointSnapshot → verdict + advisory + bayesian
  │       ├─ previous = nostr_published_events.getLastPublished('endpoint', url_hash)
  │       ├─ decision = shouldRepublish(previous, snapshot)
  │       │   ├─ first_publish (previous=null)
  │       │   ├─ verdict_change
  │       │   ├─ advisory_palier_change
  │       │   ├─ p_success_drift (|Δp| ≥ 0.05)
  │       │   └─ n_obs_jump (Δn ≥ +20%)
  │       ├─ si shouldRepublish=false → skippedNoChange++ (counter no_change)
  │       ├─ si payload_hash(new_template) == previous.payload_hash
  │       │   → skippedHashIdentical++ (counter hash_identical)
  │       ├─ publisher.publishEndpointEndorsement(snapshot)
  │       │   └─ sign + broadcast parallèle sur tous relais
  │       ├─ nostr_published_events.recordPublished(...) ← upsert atomique
  │       └─ si isVerdictTransition(previous.verdict, snapshot.verdict)
  │           └─ emitFlash(...) ← kind 20900 best-effort
  └─ scanNodes (idem sur node_streaming_posteriors)
```

### Modèle de données (v38)

```
nostr_published_events
├── entity_type ∈ {node, endpoint, service} ─┐
├── entity_id (sha256 hex ou pubkey 66)    ├─ PK composite
├── event_id (64-char hex signé)
├── event_kind (30382 | 30383 | 30384)
├── published_at (unix)
├── payload_hash (64-char hex, canonique)
├── verdict ∈ {SAFE, RISKY, UNKNOWN, INSUFFICIENT}
├── advisory_level ∈ {green, yellow, orange, red}
├── p_success (REAL)
└── n_obs_effective (REAL)
```

Upsert sur `(entity_type, entity_id)` — 1 row active par entité, conforme au modèle NIP-33 replaceable. `payload_hash` canonique (tags triés lexico + JSON + SHA256, indépendant de `created_at`) = fingerprint stable pour le fast-path.

### Publisher multi-kind

- `NostrMultiKindPublisher` signe via `nostr-tools/pure.finalizeEvent` + `nostr-tools/relay.Relay.connect`.
- Broadcast parallèle (`Promise.all`), timeout configurable (défaut 1000ms par relai). Un relai qui échoue ne bloque pas les autres.
- `publishTemplate()` exposé pour les kinds hors endorsement (20900 flash, 5 deletion).
- `connectedRelayCount` exposé pour `/metrics`.

### Scheduler

- Gated par `NOSTR_MULTI_KIND_ENABLED=false` par défaut — coexiste avec le NIP-85 legacy (kind 30382 single-source via `nostrIndexedPublisher.ts`) jusqu'à la décision de sunset.
- Kind 30384 (service) skippé en C5 : pas encore de table `services` avec `name`/`endpoint_count`/`service_hash` — réactivable dès qu'une Phase 9 livre la shape.
- `listModifiedEntities` filtre `last_update_ts >= (now - scanWindowSec)` avec overlap 3× l'interval cron pour ne pas rater une update à cheval.
- Dedup par `entity_id` : les 3 rows source/entity_id partagent la même publication.

---

## Décisions clés

### Seuils de significativité (shouldRepublish)

| Critère | Seuil | Rationale |
|---|---|---|
| `\|Δp_success\|` | ≥ 0.05 | Sous ce seuil, le changement est noise de décroissance exponentielle (τ=7j). Au-dessus, un utilisateur peut raisonnablement percevoir un shift de confiance. |
| `Δn_obs_effective` | ≥ +20% | Réduit le bruit de small-sample quand on passe de 10 à 15 observations. 20% marque un jump statistiquement significatif de la précision du CI95. |
| `verdict` | any change | Un changement d'étiquette SAFE/RISKY/UNKNOWN est toujours significatif — c'est le premier signal à diffuser. |
| `advisory_level` | palier change | Idem pour green/yellow/orange/red. |
| `previous = null` | `first_publish` | Toujours publier le premier event pour bootstrap du cache. |

Tests : `src/tests/shouldRepublish.test.ts` (16 cas).

### Kind 20900 vs 10900

Confusion initiale dans le prompt. Correction : NIP-01 split explicite :
- **10000–19999** : replaceable, persisté par les relais.
- **20000–29999** : ephemeral, broadcast-only, non persisté.
- **30000–39999** : addressable (NIP-33), 1 row par `(kind, pubkey, d-tag)`.

Un flash de transition doit être éphémère — les clients abonnés en temps réel le reçoivent, les clients qui fetch plus tard ne doivent PAS le revoir (c'est le snapshot 30383 qui fait foi). Donc **20900**, pas 10900.

Le flash porte le payload bayésien complet pour qu'un client qui n'avait pas le 30383 précédent en cache puisse construire son état sans second fetch. Tags :
- `e_type` (node/endpoint/service) : identifie quel kind replaceable le flash accompagne.
- `e_id` : pubkey ou url_hash (pas de `d` tag — un flash n'est pas addressable).
- `from_verdict` / `to_verdict` : explicit la transition. `'NONE'` si previous=null (défensif, mais isVerdictTransition exclut ce cas du scheduler).
- `p`-tag seulement pour les nodes : permet aux clients NIP-01 qui filtrent par pubkey de capturer le flash sans connaître le schema `e_type`.

### NIP-09 flag OFF par défaut

Raisonnement : les kinds 30382/30383/30384 sont NIP-33 replaceable. Les relais gardent automatiquement la version au `created_at` le plus récent → une deletion explicite est redondante dans 99% des cas.

Cas où la feature devient nécessaire :
- Un relai non-NIP-33 observé en pratique (garde toutes les versions).
- Clé compromise → révocation massive du backlog.
- Retrait ciblé suite à un bug de scheduler (mis-publish d'un event avec mauvaises données).

Le code est prêt (`NostrDeletionService.requestDeletion`), la ligne `NOSTR_NIP09_ENABLED=true` suffit à l'activer. Défense-in-depth : refuse de signer une deletion pour un event_id absent de notre cache (empêche un caller avec accès DB de nous faire retirer des events arbitraires).

---

## Exemples d'events publiés

### Kind 30383 — endorsement endpoint

```json
{
  "kind": 30383,
  "pubkey": "<satrank_oracle_pubkey_hex_64>",
  "created_at": 1704067200,
  "tags": [
    ["d", "f3a2b1c8...<url_hash sha256 64>"],
    ["url", "https://api.example.l402/paid"],
    ["verdict", "SAFE"],
    ["p_success", "0.9421"],
    ["ci95_low", "0.8812"],
    ["ci95_high", "0.9731"],
    ["n_obs", "187"],
    ["advisory_level", "green"],
    ["risk_score", "0.058"],
    ["source", "probe"],
    ["time_constant_days", "7"],
    ["last_update", "1704063600"],
    ["operator_id", "op_acme_labs"],
    ["price_sats", "100"],
    ["median_latency_ms", "284"],
    ["category", "weather"],
    ["service_name", "Weather Oracle"]
  ],
  "content": "",
  "sig": "<schnorr_sig_128>"
}
```

### Kind 30382 — endorsement node

```json
{
  "kind": 30382,
  "pubkey": "<satrank_oracle_pubkey_hex_64>",
  "created_at": 1704067200,
  "tags": [
    ["d", "02a0b1c2d3e4...<ln_pubkey 66 hex>"],
    ["p", "02a0b1c2d3e4...<ln_pubkey 66 hex>"],
    ["verdict", "SAFE"],
    ["p_success", "0.9102"],
    ["ci95_low", "0.8501"],
    ["ci95_high", "0.9507"],
    ["n_obs", "412"],
    ["advisory_level", "green"],
    ["risk_score", "0.089"],
    ["source", "probe"],
    ["time_constant_days", "7"],
    ["last_update", "1704063600"]
  ],
  "content": "",
  "sig": "<schnorr_sig_128>"
}
```

### Kind 20900 — flash de transition (ephemeral)

```json
{
  "kind": 20900,
  "pubkey": "<satrank_oracle_pubkey_hex_64>",
  "created_at": 1704067260,
  "tags": [
    ["e_type", "endpoint"],
    ["e_id", "f3a2b1c8...<url_hash>"],
    ["from_verdict", "SAFE"],
    ["to_verdict", "RISKY"],
    ["p_success", "0.4441"],
    ["ci95_low", "0.3890"],
    ["ci95_high", "0.4993"],
    ["n_obs", "287"],
    ["advisory_level", "orange"],
    ["risk_score", "0.556"],
    ["source", "probe"],
    ["time_constant_days", "7"],
    ["last_update", "1704067240"]
  ],
  "content": "",
  "sig": "<schnorr_sig_128>"
}
```

### Kind 5 — deletion request (NIP-09, flag-gated)

```json
{
  "kind": 5,
  "pubkey": "<satrank_oracle_pubkey_hex_64>",
  "created_at": 1704067320,
  "tags": [
    ["e", "<event_id_64_hex_du_target>"],
    ["k", "30383"]
  ],
  "content": "key rotation 2026-04",
  "sig": "<schnorr_sig_128>"
}
```

---

## Guide agent consommateur

### Abonnement WebSocket Nostr

Les agents qui veulent consommer les endorsements SatRank n'ont pas besoin d'interroger l'API : ils se connectent à n'importe quel relai qui port les events, avec un `REQ` filtré sur la pubkey SatRank.

Relais publics SatRank : `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.wine` (liste complète via `/api/health`).

**Exemple minimal avec `nostr-tools` TypeScript :**

```ts
import { Relay } from 'nostr-tools/relay';

const SATRANK_PUBKEY = '<satrank_oracle_pubkey_hex_64>';
const relay = await Relay.connect('wss://relay.damus.io');

// Subscribe à tous les endorsements endpoint + flashes en temps réel.
relay.subscribe([
  {
    authors: [SATRANK_PUBKEY],
    kinds: [30383, 20900],
  },
], {
  onevent(event) {
    if (event.kind === 30383) {
      const verdict = event.tags.find((t) => t[0] === 'verdict')?.[1];
      const url = event.tags.find((t) => t[0] === 'url')?.[1];
      const pSuccess = parseFloat(event.tags.find((t) => t[0] === 'p_success')?.[1] ?? '0');
      console.log(`endpoint ${url}: ${verdict} (p=${pSuccess})`);
    } else if (event.kind === 20900) {
      const eType = event.tags.find((t) => t[0] === 'e_type')?.[1];
      const eId = event.tags.find((t) => t[0] === 'e_id')?.[1];
      const from = event.tags.find((t) => t[0] === 'from_verdict')?.[1];
      const to = event.tags.find((t) => t[0] === 'to_verdict')?.[1];
      console.log(`⚡ flash ${eType} ${eId}: ${from} → ${to}`);
    }
  },
});
```

**Filtres recommandés :**

- Monitoring d'un endpoint précis : `{ authors: [SATRANK_PUBKEY], kinds: [30383, 20900], '#d': [url_hash] }` (le flash sort sur `#e_id` — un client qui veut les deux events pour un endpoint précis filtre les 30383 par `#d` et filtre les 20900 côté client sur `e_id`).
- Watch de tous les nodes d'un operator : `{ authors: [SATRANK_PUBKEY], kinds: [30382], '#operator_id': [op_id] }`.
- Sentinel production : `{ authors: [SATRANK_PUBKEY], kinds: [20900] }` — juste les flashes, alerte sur chaque transition.

**Cache-friendly :**

Les events 30382/30383/30384 sont NIP-33 replaceable — un re-fetch (`since=0`) retourne toujours la version la plus récente. Un agent peut persister localement par `(kind, d-tag)` et n'écouter que les nouveaux events ensuite.

### Décodage rapide

Les tags bayésiens (`p_success`, `ci95_low`, `ci95_high`, `risk_score`) sont stringifiés à 4 décimales (proba) et 3 décimales (risk). `n_obs`, `time_constant_days`, `last_update`, `price_sats`, `median_latency_ms` sont des entiers. `parseFloat` / `parseInt` suffit.

---

## Résultats Checkpoint 2

Démo end-to-end re-runnable : `npx tsx src/scripts/phase8Demo2.ts`. In-memory DB + stub publisher (pas de réseau). Sortie observée :

```
=== Scenario A — entity modified → first publish ===
endpoint: scanned=1 published=1 firstPublish=1 flashesPublished=0
node:     scanned=1 published=1 firstPublish=1 flashesPublished=0
- endorse kind=30383 entity=aaaaaaaaaaaa… {"verdict":"SAFE","p_success":"0.982"}
- endorse kind=30382 entity=02cccccccccc… {"verdict":"SAFE"}
cache row endpoint: verdict=SAFE p=0.982 n=80.0

=== Scenario B — second scan without changes → skip ===
endpoint: scanned=1 published=0 skippedNoChange=1 skippedHashIdentical=0
node:     scanned=1 published=0 skippedNoChange=1 skippedHashIdentical=0
publisher calls this cycle: 0 (expected 0) ✓

=== Scenario C — inject failures to flip SAFE → RISKY → flash ===
endpoint: published=1 flashesPublished=1 flashErrors=0
- endorse kind=30383 entity=aaaaaaaaaaaa… {"verdict":"RISKY","p_success":"0.444"}
- flash   kind=20900 entity=aaaaaaaaaaaa… {"from":"SAFE","to":"RISKY"}
cache row endpoint after flip: verdict=RISKY p=0.444

=== Repository stats ===
countByKind: {"30382":1, "30383":1}
latestPublishedAtByType: {"node":1700000000, "endpoint":1700003660, "service":null}
```

Les 3 acceptance critères sont matérialisés : first publish + cache update, no-op scan, flash sur transition.

---

## Observability

### Métriques Prometheus

| Métrique | Labels | Rôle |
|---|---|---|
| `satrank_nostr_events_published_total` | `kind`, `result` | Publish tentés par kind (30382/30383/30384/20900/5), result ∈ {success, no_ack}. |
| `satrank_nostr_flashes_total` | `type` | Flashes 20900 émis par entity_type (endpoint/node/service). Spike = market event. |
| `satrank_nostr_republish_skipped_total` | `reason` | Skip au scheduler, reason ∈ {no_change, hash_identical}. Ratio skipped/scanned = efficacité du delta filter. |
| `satrank_nostr_relay_errors_total` | `relay`, `result` | Erreurs par relai + result (timeout\|error). Identifie le relai qui drag. |
| `satrank_nostr_multi_kind_publish_duration_seconds` | `kind` | Histogramme latence (signing + broadcast). Détecte ralentissements relais. |

### Logs structurés (pino JSON)

Chaque publish émet une ligne info :

```json
{
  "level": 30,
  "msg": "nostr multi-kind publish complete",
  "kind": 30383,
  "eventId": "a1b2c3d4e5f6",
  "latencyMs": 187,
  "relays": [
    {"relay": "wss://relay.damus.io", "result": "success"},
    {"relay": "wss://nos.lol", "result": "success"},
    {"relay": "wss://relay.primal.net", "result": "timeout"}
  ],
  "anySuccess": true
}
```

Alertes suggérées :
- `rate(satrank_nostr_events_published_total{result="no_ack"}[5m]) > 0.1` → relais défaillants ou clé corrompue.
- `time() - satrank_nostr_last_publish_timestamp > 1800` → scheduler mort (legacy NIP-85 metric, même pattern à appliquer au multi-kind via un nouveau gauge si besoin).
- `rate(satrank_nostr_flashes_total[1h]) > 5` → event de marché majeur, inspecter.

---

## Ce qui n'est PAS dans Phase 8

- **Kind 30384 (service endorsements)** : skippé car pas de table `services` avec `name`/`endpoint_count`. Réactivable Phase 9 quand le service registry livre la shape.
- **Activation NIP-09** : code prêt, flag OFF. Activation décidée au cas par cas.
- **Sunset du NIP-85 legacy** : les deux systèmes coexistent. Cutover multi-kind uniquement après observation prod de 30+ jours stable.
- **Consumer SDK Nostr** : le guide ci-dessus suffit pour l'instant. Un wrapper `@satrank/nostr-client` pourrait être utile Phase 9 si les consumers convergent sur un pattern partagé.

---

## Commandes utiles

```bash
# Re-run la démo Checkpoint 2 (local, pas de réseau)
npx tsx src/scripts/phase8Demo2.ts

# Run la démo Checkpoint 1 (local, simule le scheduler sur data fictive)
npx tsx src/scripts/phase8Demo.ts

# Test suite complète
npm test

# Tests Phase 8 seuls
npx vitest run src/tests/nostrMultiKindScheduler.test.ts \
  src/tests/nostrPublishedEventsRepository.test.ts \
  src/tests/shouldRepublish.test.ts \
  src/tests/nostrEventBuilders.test.ts \
  src/tests/nostrDeletionService.test.ts \
  src/tests/nostrMultiKindMetrics.test.ts
```
