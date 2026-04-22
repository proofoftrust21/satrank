# Phase 13D — `service_price_sats` backfill & ingestion hardening

**Date:** 2026-04-22
**Snapshot taken at:** 2026-04-22T21:37:26Z
**Commits:** `d772b12` → `d3cb866` (7 commits on `main`)
**Production host:** `178.104.108.108` (satrank-api + satrank-crawler + ptail)
**Scope:** unblock `sr.fulfill()` on all L402 endpoints indexed by 402index
and neighbors, without touching LND/bitcoind, without paying invoices.

---

## Blocker résolu

Symptôme initial : `172/172` lignes de `service_endpoints` en prod avaient
`service_price_sats=null`. Résultat : `POST /api/intent` avec `budget_sats`
retournait systématiquement `NO_CANDIDATES`, et `sr.fulfill()` dans le SDK
était inutilisable.

Résultat après Phase 13D :

| Métrique | Avant | Après |
|---|---|---|
| Endpoints total | 172 | 172 |
| Endpoints tarifés (`service_price_sats IS NOT NULL`) | 0 | **139** |
| Endpoints sans prix (`NULL`) | 172 | 33 |
| `/api/intent` avec budget retourne NO_CANDIDATES | oui | **non** |
| `sr.fulfill()` fonctionnel | non | **oui** |

Les 33 endpoints résiduels ne sont pas une incomplétude de SatRank —
voir « Providers dégradés actuels » ci-dessous.

---

## Bugs diagnostiqués (4)

1. **Ordering dans `registryCrawler`** — `updatePrice()` s'exécutait avant
   `upsert()`, donc l'`UPDATE` touchait 0 lignes silencieusement. Le fix
   réorganise la séquence : `upsert()` puis `updateMetadata()` puis
   `updatePrice()`. Plus aucune perte silencieuse.
2. **Adapter `strip` dans `app.ts`** — la fonction d'adaptation retournée
   par le bootstrap LND vers `RegistryCrawler` retirait `decodePayReqStrict`
   avant de le passer au crawler, rendant impossible la distinction entre
   erreurs de parse et échecs réseau. Fix : exposition directe du client
   LND complet à `RegistryCrawler` via son 2e argument de constructeur.
3. **Early-continue dans la boucle de backfill** — quand un endpoint déjà
   existant avait `service_price_sats=null`, la branche « existing »
   incrémentait `result.updated` et continuait sans re-probe. Fix : re-probe
   systématique de la prix quand `service_price_sats === null`, même sur
   une ligne déjà en base.
4. **Interface `LndGraphClient` incomplète** — `decodePayReqStrict` était
   typé comme optionnel dans l'interface mais toujours présent dans
   l'implémentation `HttpLndGraphClient`. Fix : typage aligné, plus
   d'usage de `!` à la volée.

---

## Améliorations infra (3)

### 1. Circuit breaker — carve-out BOLT11 parse errors
Avant : chaque erreur HTTP 500 venant de `/v1/payreq/:payreq` (LND REST)
comptait comme un échec `onFailure()` du breaker. 5 invoices malformés
(providers qui servent du bech32 cassé) ouvraient le breaker pour 30s,
bloquant toutes les décodes suivantes, y compris celles valides.

Fix (`src/crawler/lndGraphClient.ts:306-315`) : si `path` commence par
`/v1/payreq/` **ET** le corps matche `/invalid index|checksum failed|failed
converting data|invalid character not part of charset/i`, on saute
`breaker.onFailure()`. L'erreur est toujours remontée à l'appelant —
mais elle ne pénalise plus la santé globale du breaker.

### 2. Per-host rate limiter + 429/Retry-After handling
Avant : pattern global `RATE_LIMIT_MS=500` appliqué après chaque requête,
quelle que soit la destination. Deux défauts :
- Serialisait des requêtes vers des hôtes différents (perdant du débit).
- Laissait 28 requêtes vers le MÊME hôte atterrir en ~14s — ce qui a
  déclenché le rate limit serveur de plebtv le 2026-04-22.

Fix (`src/utils/hostRateLimiter.ts`) : `HostRateLimiter` — `Map<host,
last_call_timestamp>`. L'attente est keyée sur `new URL(url).host`. Slot
réservé avant l'`await` pour correctness concurrentielle (3 appels
concurrents sur le même host résolvent à t=0, t=500, t=1000).

429 handling : `Retry-After` entier-en-secondes. ≤30s : sleep + un retry.
>30s ou absent : skip avec nouveau compteur `skippedRateLimitedLong`.

Appliqué à la fois dans `backfillServicePrices` ET `registryCrawler`,
pour que le cycle cron (24h) ne re-déclenche pas plebtv.

### 3. Provider health logging (D.6.5)
`src/utils/providerHealthTracker.ts` — `Map<host, {consecutive_failures,
last_error_kind, first_seen_in_run, degraded_logged}>`. Compte les échecs
consécutifs par host au sein d'une run. À `consecutive_failures >= 10`,
émet UNE ligne structurée :

```json
{
  "event": "provider_health_degraded",
  "host": "www.plebtv.com",
  "consecutiveFailures": 10,
  "lastErrorKind": "http_5xx_after_retry",
  "firstSeenInRun": 1776893658
}
```

Validé en prod le 2026-04-22 : déclenchement à la 10e URL plebtv, non
ré-émis sur les 18 suivantes. Hôte `lightningfaucet.com` à 5 échecs reste
silencieux (sous le seuil), comme prévu.

Réinitialise le compteur au premier succès ; le flag `degradedLogged` reste
latched dans la run pour éviter le spam sur les providers flakey.

Kinds trackés (4) : `http_5xx_after_retry`, `invoice_malformed`,
`network_error`, `decode_failed`. Sont **exclus** volontairement :
- `skippedRateLimitedLong` — notre décision de deferrer, pas un échec provider.
- `skippedBreakerOpen` — notre composant, pas le provider.
- `skippedSsrf` / `skippedNotL402` / `skippedNoInvoice` — filtres structurels.
- `skippedNetworkMismatch` / `skippedZeroPrice` — sémantique valide.

---

## Classifier explicite (8 compteurs typés)

Ancien code : un seul bucket `skippedDecodeFailed` agrégeait BOLT11
malformés, breaker open, network mismatch, et toute autre erreur LND.
Impossible de distinguer ce qui était récupérable.

Nouveau `BackfillSummary` :

```ts
{
  scanned: number;
  skippedNoInvoice: number;          // WWW-Authenticate sans invoice="..."
  skippedNotL402: number;             // Status != 402
  skippedSsrf: number;                // URL privé bloqué en connexion
  skippedInvoiceMalformed: number;    // LND "invalid index|checksum failed|..."
  skippedNetworkMismatch: number;     // testnet/signet/wrong network
  skippedBreakerOpen: number;         // LND breaker ouvert (notre santé)
  skippedDecodeFailed: number;        // Tout le reste (LND non-classifié)
  skippedZeroPrice: number;           // num_satoshis<=0 (endpoint gratuit)
  skippedNetworkError: number;        // fetch error ou 5xx après retries
  skippedRateLimitedLong: number;     // 429 avec Retry-After > 30s ou absent
  priced: number;
}
```

Run committed post-fix : `scanned=33, skippedInvoiceMalformed=5,
skippedNetworkError=28, priced=0` (les 139 déjà tarifés restent intacts).
Aucune ambiguïté sur où se situent les 33 manquants.

---

## Fragilités connues

### a. Carve-out LND dépend du matching de 4 strings lnd v0.20.1
Le filtre BOLT11-parse-error dans `src/crawler/lndGraphClient.ts:307-308`
identifie les erreurs à exclure du breaker par regex sur le corps de
réponse HTTP 500 de `/v1/payreq/`. Les 4 phrases matchées :
- `invalid index`
- `checksum failed`
- `failed converting data`
- `invalid character not part of charset`

Ces phrases viennent de `zpay32.Decode` dans `lnd` v0.20.1. **À chaque
upgrade LND, re-valider que ces 4 phrases correspondent toujours aux
erreurs de parse d'invoice.** Si les strings changent, le breaker
re-déclencherait sur les 5 invoices malformés de `lightningfaucet.com`,
ouvrant le breaker mi-backfill comme avant. Non bloquant aujourd'hui, à
re-tester lors de tout upgrade LND.

### b. Per-host rate limit 500ms peut nécessiter tuning
La constante `PER_HOST_GAP_MS = 500` dans `registryCrawler` et
`DEFAULT_RATE_LIMIT_MS = 500` dans le backfill sont empiriques. Un
provider strict non encore rencontré (ex. l402-index-style avec policy
1 req/sec ou 1 req/3sec) nécessiterait d'augmenter la valeur, peut-être
par host dans une phase future. Le mécanisme 429+Retry-After couvre le
cas où un provider remonte clairement son SLA, mais certains providers
préfèrent dégrader silencieusement (500 au lieu de 429), d'où la
nécessité du D.6.5.

### c. Seuil 10 du health logging est empirique
`ProviderHealthTracker` utilise `threshold=10` par défaut. Valeur choisie
pour tolérer les providers avec 5-8 flakes dans une run de 100 URLs sans
alerter. Si on découvre des faux positifs (provider qui a régulièrement
10+ flakes pour des raisons légitimes comme URLs invalides historisées),
ajuster. Inversement, sur des hosts qui n'ont que 3-4 URLs dans notre
index, un outage total ne déclencherait jamais le log — acceptable
aujourd'hui (lightningfaucet à 5/5 échecs en est l'exemple).

---

## Providers dégradés actuels

### `www.plebtv.com` — 28 URLs en HTTP 500
Endpoints : `/api/l402/video/<slug>` × 28. Réponse serveur :
- `HTTP/2 500` avec `server: Vercel`
- Body : `{"error":"Internal server error"}`
- Persistant : 3 runs consécutives (à 21:21, 21:27, 21:34 UTC le 2026-04-22) ont toutes retourné 500 sur les 28 URLs.
- Cause probable : bug déployé côté Vercel/Next.js de plebtv — leur route `/api/l402/video/[videoId]` lève côté serveur. Hors de notre contrôle.

### `lightningfaucet.com` — 5 URLs en BOLT11 malformé
Endpoints : `/api/l402/{bid_board,headers,keywords,lnurl_metadata,random_sats}`.
Erreur LND :
- 3 URLs : `failed converting data to bytes: invalid character not part of charset: 98`
- 2 URLs : `invalid index of 1`

Le provider sert un template d'invoice bech32 cassé. Permanent tant
qu'ils n'ont pas corrigé leur générateur. Ne déclenche plus le breaker
grâce au carve-out (D.5.6).

### Mécanisme d'auto-recovery
Le cycle `registryCrawler` (cron 24h) re-probe **tous** les endpoints,
pas seulement les neufs. Avec les fixes de Phase 13D :
- Quand plebtv fixera leur bug Vercel : le prochain cycle capturera les
  invoices BOLT11 et pricing tombera automatiquement.
- Si lightningfaucet fixe leur template : idem.

Aucune intervention manuelle requise tant que les providers restent
dans `402index`.

---

## Ce qui n'est PAS de la dette

Les 33 endpoints non tarifés ne sont pas une incomplétude de SatRank.
Ils sont la photographie exacte de l'état externe à
**2026-04-22T21:37:26Z** :
- 28 plebtv : côté Vercel plebtv, pas côté SatRank.
- 5 lightningfaucet : template bech32 cassé chez le provider, pas côté SatRank.

Notre système a classifié ces 33 cas sans ambiguïté (compteurs typés),
les a loggés (`provider_health_degraded` pour plebtv), et se
ré-synchronisera automatiquement dès que les providers corrigeront.

Rien à faire côté SatRank. Monitoring passif via les logs du cron
crawler.

---

## Checkpoint final

### Block 1 — DB state
```
TOTALS:  { priced: 139, null_price: 33, total: 172 }
NULL_HOSTS: [
  { host: "www.plebtv.com",      count: 28 },
  { host: "lightningfaucet.com", count:  5 }
]
TOP PRICED CATEGORIES:
  energy/intelligence: 48
  data:                40
  video:                8
  ai:                   5
  guides:               5
```

### Block 2 — E2E `/api/intent` (depuis le Mac)
```
POST https://satrank.dev/api/intent
body: { "category":"energy/intelligence", "budget_sats":50, "limit":3 }

candidates[0] = {
  rank: 1,
  endpoint_url: "https://grid.ptsolutions.io/v1/intelligence/demand-supply/ercot",
  price_sats: 25,
  service_name: "Grid Energy Intelligence: Demand & Supply — Texas (ERCOT)",
  ...
}
```
**Pas de `NO_CANDIDATES`. `sr.fulfill()` débloqué.**

### Block 3 — State final
- `/api/health` : `status=ok`, `schemaVersion=41` (expected), `dbStatus=ok`, `lndStatus=ok`.
- `satrank-api` : Up 2 min (healthy, redéployé à 21:35 pour D.6.5).
- `satrank-crawler` : Up 2 min (healthy, redéployé à 21:35 pour D.6.5).
- LND uptime : `ActiveEnterTimestamp=2026-04-18 18:30:28 UTC` — **inchangé depuis D.4**.
- bitcoind uptime : `ActiveEnterTimestamp=2026-04-18 18:30:02 UTC` — **inchangé depuis D.4**.
- Breaker events (1h) : 0.
- `provider_health_degraded` émis pour `www.plebtv.com` lors du run backfill D.6.5 validation (à la 10e URL consécutive en échec 5xx, non ré-émis sur les 18 suivantes).

### Block 4 — Ce document.
