# Phase 13C — Repopulate service_endpoints + operators : BLOQUÉ

**Date :** 2026-04-22
**Branche :** `phase-13c-repopulate`
**Auteur :** autonomous agent
**Statut :** **BLOQUÉ — décision produit requise**

---

## Résumé exécutif

Les deux mécanismes de repeuplage sont bloqués, chacun pour une raison distincte. **Aucun repeuplage n'a été écrit en prod** (cardinal rules respectées : LND/macaroons/Nostr/schema intacts).

| Cible                | État post-scan | Mécanisme attendu           | Bloqueur                                                              |
|----------------------|----------------|-----------------------------|-----------------------------------------------------------------------|
| `service_endpoints`  | 0 rows         | `RegistryCrawler` (402index)| **BUG SSRF** en prod — `fetchSafeExternal` échoue sur toutes les URLs |
| `operators`          | 0 rows         | `inferOperatorsFromExistingData.ts` | **Données absentes** — les 24561 transactions ont `operator_id IS NULL` (enrichment v31 non migré en 12B) |
| `operator_identities`| 0 rows         | (auto, via verif Nostr/DNS/LN) | Neutre — attend verifs réelles                                      |
| `token_balance`      | 0 rows         | (auto, via paiements L402)  | Neutre — repeuple via nouveaux paiements                              |

**Verdict :** Phase 13C comme scopée (« ré-exécuter les scripts qui existent ») ne peut pas aboutir dans l'état actuel. Deux décisions produit à prendre (voir §Phase 14 recos).

---

## Setup

- Branche créée depuis `main` : `phase-13c-repopulate`
- Scripts repopulate identifiés :
  - `src/scripts/inferOperatorsFromExistingData.ts` — CLI standalone (`--dry-run` supporté), compilé en `dist/scripts/inferOperatorsFromExistingData.js`
  - `src/crawler/registryCrawler.ts` — classe `RegistryCrawler`, **pas de CLI standalone** ; instanciée dans `src/crawler/run.ts` au boot (initial fire) + cron 24h
- Pas de modification de code source. Toutes les exécutions ont été faites via `docker exec` sur les containers existants.

---

## S3 — Baseline prod (2026-04-22, ~17:00 UTC)

```
service_endpoints=0
operators=0
operator_identities=0
operator_owns_endpoint=0
agents=12300
transactions=24561
token_balance=0
```

- `/api/health` : status=error (scoringStale=true, scoringAgeSec≈8900s), dbStatus=ok, **lndStatus=ok** ✅, schemaVersion=41
- `/api/intent/categories` : `{"categories":[]}` (confirme service_endpoints vide)
- `/api/operators?limit=3` : `{"data":[],"meta":{...totalPerStatus:0}}` (confirme operators vide)
- LND intact (cardinal rule respectée, aucune commande LND exécutée)

---

## S4 — inferOperators : échec par absence de données source

Exécution dry-run :

```bash
docker exec satrank-api node dist/scripts/inferOperatorsFromExistingData.js --dry-run
```

Output :

```
inferOperators: no proto-operators found in transactions
{
  "protoOperatorsScanned": 0,
  "operatorsCreated": 0,
  ...
}
```

### Diagnostic

Le script fait : `SELECT ... FROM transactions WHERE operator_id IS NOT NULL GROUP BY operator_id`.

Vérification directe sur Postgres prod :

```sql
SELECT COUNT(*) total, COUNT(operator_id) with_op_id FROM transactions;
-- total=24561 | with_op_id=0
```

**Les 24561 transactions ont toutes `operator_id IS NULL`.** L'enrichment v31 (`operator_id = sha256hex(node_pubkey)`, `endpoint_hash`, `source`, `window_bucket`) a été **perdu pendant la migration Phase 12B** — les colonnes existent dans le schéma PG v41 mais aucun backfill n'a alimenté les valeurs.

Vérification des tables *source* qu'un backfill (`backfillTransactionsV31.ts`) utiliserait :

```
service_probes=0
attestations=0
```

**Elles sont également vides.** Donc même `backfillTransactionsV31` ne pourrait rien enrichir.

### Pourquoi c'est un blocker

Le script `inferOperatorsFromExistingData` est conçu pour un état post-v31 où les transactions portent déjà l'`operator_id`. Le brief Phase 13C s'attendait à « ~12291 operators créés (un par agent) », mais le script ne parcourt PAS la table `agents` — il reconstruit les opérateurs à partir de l'historique des transactions.

Trois options produit, **à arbitrer par Romain** :

- **Option A** — Créer un nouveau script qui itère `agents` directement (1 operator pending par agent, `verification_score=0`). Respecte l'intent Phase 7 mais requiert du nouveau code.
- **Option B** — Restaurer les valeurs `operator_id`/`endpoint_hash`/`source`/`window_bucket` des transactions depuis un dump SQLite antérieur à Phase 12B (si conservé). Plus coûteux, demande un nouveau script ETL.
- **Option C** — Laisser opérateurs à 0 et attendre que les nouvelles transactions L402 (avec `operator_id` rempli via crawler/decide) repeuplent naturellement. C'est le chemin le plus sûr mais le plus lent.

---

## S5 — Registry crawler : bug SSRF en production

### Ce que les logs disaient

Container `satrank-crawler` (up 16h, healthy) : le `setInterval` 24h tourne, mais **aucune ligne "Registry crawl progress" ni "Registry crawl complete" depuis le boot**. Seul log registry : `"Registry crawler timer started"` (setInterval confirmé, IIFE d'initial fire lancé).

### Ce que le test manuel a montré

Exécution inline du `RegistryCrawler.run()` via `docker exec satrank-crawler node -e '...'` (même repos, même pool, même decoder LND) :

```
decoder_ready= true
starting run...
{"offset":100,"discovered":0,"updated":0,"msg":"Registry crawl progress"}
...
{"offset":1108,"discovered":0,"updated":0,"msg":"Registry crawl progress"}
RESULT: {"discovered":0,"updated":0,"errors":0}
```

1108 services scannés depuis `https://402index.io/api/v1/services?protocol=L402` — **0 discovered**. Aucune erreur loggée côté crawler.

### Diagnostic : `fetchSafeExternal` cassé

Isolation du bug en testant `discoverNodeFromUrl` sur une URL L402 valide (confirmée par GET direct : status 402 + `www-authenticate` avec `invoice="lnbc..."` parseable par LND `decodepayreq`) :

```js
const { fetchSafeExternal } = require('/app/dist/utils/ssrf.js');
await fetchSafeExternal('https://faucet.mutinynet.com/api/l402', {...});
// → TypeError: fetch failed
//   cause: Invalid IP address: undefined (ERR_INVALID_IP_ADDRESS)
```

Testé sur 3 URLs (`api.github.com`, `lnrouter.app`, `faucet.mutinynet.com`) : **toutes échouent** avec la même erreur.

Cause racine (voir `/app/dist/utils/ssrf.js` autour de `safeLookup`) : le hook `lookup` passé à `undici.Agent` appelle `cb(null, pick.address, pick.family)` — signature `(err, address, family)` style `dns.lookup(all:false)` — alors qu'undici (v6+) attend un callback style `(err, addresses[])` avec un tableau d'objets `{address, family}`. Résultat : undici reçoit `undefined` comme IP et rejette.

### Surface impactée

`fetchSafeExternal` est utilisé par 6 modules :

```
src/crawler/registryCrawler.ts
src/crawler/serviceHealthCrawler.ts
src/controllers/probeController.ts
src/services/decideService.ts
src/services/operatorVerificationService.ts
src/utils/ssrf.ts (self-ref)
```

**Toutes ces voies sont aveugles en production** depuis le déploiement de la version actuelle (post-Phase 13A durcissement).

### Workaround possible (NON appliqué)

Réimplémenter `discoverNodeFromUrl` inline avec `fetch()` natif + `isSafeUrl()` (check statique loopback/private/userinfo conservé). Non appliqué car :
1. Ça contourne un contrôle de sécurité cassé plutôt que de le réparer
2. Le brief interdit la modification de code scripts
3. Le bon fix est de réparer `safeLookup` et redéployer — out of scope Phase 13C

---

## S6 — Validation fonctionnelle (post-scan)

État inchangé (aucune écriture en prod) :

```
/api/intent/categories → {"categories":[]}
/api/operators?limit=3 → {"data":[],"meta":{"total":0,...}}
/api/health → lndStatus=ok, dbStatus=ok, schemaVersion=41
```

Flow SDK depuis `/tmp/sdk-test-13c` non tenté — inutile tant que service_endpoints/operators sont vides (reproduit exactement la blocker Phase 13B).

---

## S7 — Scheduler check

- Host crontab : aucun cron registry (seulement LND backup + scoring-validation)
- Container `satrank-crawler` : registry crawler wiré dans `src/crawler/run.ts` lignes 823-849 — initial fire au boot + `setInterval` 24h (`CRAWL_INTERVAL_REGISTRY_MS`)
- Conclusion : le scheduling existe **mais ne produit aucune donnée** tant que le bug SSRF n'est pas corrigé

---

## Recommandations Phase 14

### Priorité 1 — Fix SSRF (P0, bloquant 6 modules)

Corriger `safeLookup` dans `src/utils/ssrf.ts` pour renvoyer un tableau au format attendu par undici `Agent.connect.lookup` :

```ts
// Actuel (cassé)
cb(null, pick.address, pick.family);

// Fix (à valider contre undici v6+)
cb(null, list); // ou cb(null, [{address: pick.address, family: pick.family}])
```

Tests à ajouter : unit test sur `safeLookup` qui mocke `dns.lookup`, + test d'intégration sur `fetchSafeExternal` contre une URL publique.

Une fois fixé + redéployé, l'initial fire du registry crawler au prochain boot repeuplera `service_endpoints` automatiquement.

### Priorité 2 — Décider du mode de repopulate operators

Trois options listées en S4 — arbitrage produit requis. Recommandation personnelle : **Option C** (attendre le repeuplage naturel), car :
- Le SDK Phase 13B montre que les consommateurs actuels ciblent `/api/intent/categories` et `/api/operators` — les deux suivront automatiquement une fois `service_endpoints` rempli (P1) puis les premiers paiements L402 effectués
- L'Option A réintroduit du code (un nouveau script) pour un état transitoire
- L'Option B demande un backup SQLite pré-12B dont on ne sait pas s'il a été conservé

### Priorité 3 — Monitoring registry silencieux

Le registry crawler a tourné 16h sans une seule ligne d'erreur alors qu'il ne produisait rien. Proposer un healthcheck métrique : si `service_endpoints` count n'augmente pas sur 7j consécutifs ET qu'il y a plus de X URLs publiées par 402index, lever une alerte. (Hors scope 13C, note pour l'owner crawler.)

---

## Cardinal rules — vérification

| Règle                              | Statut |
|------------------------------------|--------|
| LND intouchable (zéro lncli/bitcoin-cli) | ✅ |
| Macaroons/wallet.db/channel.db/seed intacts | ✅ |
| Clé Nostr intouchable              | ✅ |
| Pas de modification de schema      | ✅ — schemaVersion reste 41 |
| Pas de DELETE sur tables existantes| ✅ — zéro écriture prod |
| `/api/health` en 200                | ✅ |

---

## Artefacts

- Baseline prod : `docs/phase-13c/baseline.txt`
- Output dry-run inferOperators : `docs/phase-13c/infer-dryrun.txt`
- Output inline registry test : `docs/phase-13c/registry-inline.txt`
- Output reproducteur SSRF : `docs/phase-13c/ssrf-repro.txt`

---

## Ce qui n'a PAS été fait (explicitement)

- Aucune écriture en prod (PG ou FS)
- Aucun redémarrage de container
- Aucun redéploiement
- Aucun fix SSRF (hors scope, nécessite décision + revue sécurité)
- Aucun nouveau script committé dans `src/` (brief interdit)

Draft PR ouverte pour trace et décision user.
