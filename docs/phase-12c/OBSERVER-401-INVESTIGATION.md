# Phase 12C — Observer Protocol 401 investigation

- **Date :** 2026-04-22
- **Scope :** investigation seule, pas de fix (per kickoff plan).
- **Severity :** MEDIUM (produit) / HIGH (observabilité)
- **Status :** **OPEN** — analyse terminée, décision fix reportée au checkpoint 1.

---

## Symptôme

Le container `satrank-crawler` émet en continu :

```
"HTTP 401: Unauthorized" sur https://api.observerprotocol.org/observer/transactions
"Failed after 4 attempts: HTTP 401: Unauthorized"
"Errors during Observer Protocol crawl"
```

Chaque cycle (~5 min) : 4 tentatives (1 + 3 retry avec backoff exponentiel
1/2/4/8 s), 4× `level=50` (ERROR) + 1× `level=40` (WARN). Depuis le cut-over
Phase 12B le 2026-04-21 17:50 UTC, observé en continu (container redémarré à
ce moment-là, pas de logs antérieurs conservés).

## Impact

### Ingestion

Les 12 291 agents actuels ont tous `source='lightning_graph'` — **zéro**
provient d'`observer_protocol`. Les 8 182 transactions héritées ont
`source=NULL` (colonne ajoutée plus tard, legacy pre-migration).

```sql
SELECT source, COUNT(*) FROM agents GROUP BY source;
--  lightning_graph | 12291

SELECT source, COUNT(*) FROM transactions GROUP BY source;
--  (null) | 8182
```

Conséquence : le crawler Observer **n'ingère plus aucune donnée** ; l'oracle
fonctionne exclusivement sur `lightning_graph` (LND describegraph) + probes
+ attestations + graphe de confiance LN+.

### Logs / observabilité

Chaque cycle rescore ajoute 5 lignes ERROR/WARN au flux de logs crawler.
Sur 24 h cela représente ~1 440 lignes de bruit, masquant potentiellement
d'autres erreurs. Ça fausse aussi toute alerte basée sur `level>=error`.

## Root cause

Trois défauts se combinent :

### 1. Le client n'envoie aucune authentification

`src/crawler/observerClient.ts:52-56` — seuls `Accept` et `User-Agent` sont
posés, pas de `Authorization`, pas de `X-API-Key`, pas de token.

```ts
const response = await fetch(url, {
  method: 'GET',
  headers: { 'Accept': 'application/json', 'User-Agent': 'SatRank-Crawler/0.1' },
  signal: controller.signal,
});
```

Le code existe tel quel depuis le release initial `3e4af7c` (2026-01-01).
Aucun commit n'a jamais ajouté de mécanisme d'authentification — donc le
client a toujours tapé l'API en mode anonyme.

### 2. L'endpoint Observer a été protégé

Probe directe depuis local (2026-04-22) :

```
GET https://api.observerprotocol.org/api/v1/health              → 200
GET https://api.observerprotocol.org/observer/transactions      → 401
```

Seul `/observer/transactions` exige désormais une authentification. Le
health check reste public — c'est pour ça que `/api/health` côté SatRank
n'a jamais signalé Observer comme down : le crawler ne probe que `health`
pour le heartbeat, pas `transactions`. Dégradation silencieuse.

### 3. L'env var `OBSERVER_API_URL` est orpheline

Prod a en `.env.production` :

```
OBSERVER_API_URL=https://api.observer.casa
```

Mais :
- `grep -r OBSERVER_API_URL src/` → **0 matches**. Le code ne lit jamais
  cette variable. Le client utilise le constant hardcoded
  `DEFAULT_BASE_URL = 'https://api.observerprotocol.org'`
  (`observerClient.ts:6`).
- `dist/` (build Docker prod) ne contient pas non plus la chaîne →
  confirmation que l'override est inopérant.
- `curl https://api.observer.casa` → **NXDOMAIN** (la zone DNS n'existe
  pas). Ce n'est pas une URL alternative qui marcherait ; c'est un
  fantôme — probablement une piste abandonnée lors d'un rename Observer.

En résumé : quelqu'un a tenté de basculer vers `observer.casa` (probablement
après un rebrand/déplacement de l'API Observer Protocol) en posant la
variable d'env, mais (a) le code n'a jamais été câblé pour la consommer,
(b) le host cible n'existe plus/pas dans le DNS public, et (c)
`observerprotocol.org` a entre-temps mis l'endpoint derrière auth. Les
trois défauts se cumulent en un 401 systématique.

## Scope hors migration

Cette panne **n'est pas causée par Phase 12B**. Preuves :

1. Le code client (`observerClient.ts`) n'a pas changé dans `a5c173b`
   (merge Phase 12B).
2. L'env var `OBSERVER_API_URL=api.observer.casa` datait déjà d'avant
   le cut-over (l'ancienne VM l'avait aussi — même `.env`).
3. `api.observerprotocol.org` retourne 401 indépendamment de l'origine
   (testé depuis local, IP résidentielle française, pas depuis la VM
   prod).

La migration Postgres n'a fait que rendre la panne visible, en
redémarrant le container et en rechargeant le log pipeline.

## Options de fix (DÉCISION reportée)

| # | Option | Effort | Risque | Bénéfice |
|---|--------|--------|--------|----------|
| 1 | Obtenir une clé API Observer + ajouter `OBSERVER_API_KEY` env + header `Authorization: Bearer` dans le client | 2-4 h + délai d'obtention | Faible | Rétablit la source de données Observer (volume inconnu) |
| 2 | Désactiver totalement `ObserverCrawler` dans le cron pipeline + supprimer code mort | 1 h | Zéro (déjà non-fonctionnel) | Logs propres, moins de code à maintenir |
| 3 | Silencer le 401 (retry désactivé sur 4xx + log une fois/heure max) | 30 min | Faible | Réduit bruit sans décider sur le fond |
| 4 | Câbler enfin `OBSERVER_API_URL` dans le client (lire env, fallback sur default) — préalable à option 1 | 30 min | Zéro | Permet de basculer d'URL sans redeploy code |

Option **recommandée à chaud** : **2** (désactiver) si Observer Protocol
est abandonné côté upstream (rebrand vers `observer.casa` jamais
déployé = signal fort), sinon **1** (récupérer la clé) si l'API reste
source de valeur.

Option 3 peut être un **stopgap** en 30 min pour arrêter la pollution
des logs dès aujourd'hui, puis 1 ou 2 plus tard selon la décision
produit.

## Décision

**À faire au checkpoint 1 avec Romain.** Ce document n'implémente rien.

## Annexes

### Container start & log window

```
docker inspect satrank-crawler --format '{{.State.StartedAt}}'
→ 2026-04-21T17:50:26.464384232Z

First log :  time=1776793826914 (2026-04-21 17:50:26 UTC)
Last  log :  time=1776808837399 (2026-04-21 22:00:37 UTC — snapshot)
```

Les logs antérieurs (ancienne VM pré-cut-over) ne sont pas conservés ;
impossible de dater précisément le moment où Observer a mis le 401 en
place. Mais les métriques `agents.source` confirment que l'ingestion
Observer est à zéro sur toute la période mesurable.

### Repro local

```bash
$ curl -sS -o /dev/null -w "%{http_code}\n" \
    https://api.observerprotocol.org/observer/transactions
401

$ curl -sS -o /dev/null -w "%{http_code}\n" \
    https://api.observerprotocol.org/api/v1/health
200

$ curl -sS https://api.observer.casa/api/v1/health
curl: (6) Could not resolve host: api.observer.casa
```

### Code pointers

- `src/crawler/observerClient.ts:6` — `DEFAULT_BASE_URL` hardcoded.
- `src/crawler/observerClient.ts:52-56` — fetch sans Authorization.
- `src/crawler/observerClient.ts:33` — path `/observer/transactions` (celui qui 401).
- `src/config.ts` — `OBSERVER_API_URL` **absent** du schema zod (ignoré silencieusement).
