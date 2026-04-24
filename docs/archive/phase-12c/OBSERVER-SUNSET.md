# Phase 12C — Observer Protocol sunset

- **Date :** 2026-04-22
- **Décision :** sunset complet, immédiat, irréversible sans partenariat
- **Severity :** N/A (décision produit)
- **Status :** **CLOSED** — implémenté dans le commit unique Phase 12C

---

## Résumé

Sunset signé le **22 avril 2026**. SatRank se désolidarise complètement de
l'intégration Observer Protocol. Réactivation conditionnelle à un
**partenariat explicite écrit** entre SatRank et Observer Protocol — pas
de réactivation par flag, pas par env var, pas par redéploiement silencieux.

## Contexte

Trois trajectoires convergent sur la même décision :

1. **Produit** — Observer Protocol se positionne comme « narrative trust
   layer » (score narratif des agents/projets), SatRank comme oracle de
   routabilité Lightning. Les deux cibles sont orthogonales, mais les deux
   narrations se télescopent sur le même marché « trust layer for
   autonomous agents ». Romain a tranché : **concurrent, pas partenaire**.

2. **Technique** — `api.observerprotocol.org/observer/transactions`
   retourne 401 depuis une date indéterminée (voir
   `OBSERVER-401-INVESTIGATION.md`). L'ingestion est à zéro. Le client
   n'a jamais envoyé d'auth — aucune clé n'a jamais été négociée. L'env
   var `OBSERVER_API_URL=api.observer.casa` pointait vers un host
   NXDOMAIN. Trois défauts empilés : sunset à coût zéro opérationnel.

3. **Schéma** — la valeur `agents.source = 'observer_protocol'` et la
   valeur `streaming_posteriors.source = 'observer'` étaient gardées dans
   le schéma pg16 pour rien. La contrainte CHECK les acceptait, aucune
   ligne ne les portait (purge vérifiée en étape 2).

## Ce que la Phase 12C fait

1. **Code** — suppression complète (pas commentaire) de :
   - `src/crawler/observerClient.ts`
   - `src/crawler/observerCrawler.ts`
   - branche `'observer'` / `'observer_protocol'` dans services,
     repositories, tests, scripts de backfill
   - enum `AgentSource` : `'observer_protocol'` renommé en `'attestation'`
   - enum `BucketSource` : `'observer'` retiré (valeurs restantes : `probe`,
     `report`, `paid`)

2. **Base de données** — purge des lignes `source IN ('observer',
   'observer_protocol')` sur les tables impactées (zéro ligne à purger en
   pratique — voir étape 2).

3. **Config** — retrait de `OBSERVER_BASE_URL`, `OBSERVER_TIMEOUT_MS`,
   `CRAWL_INTERVAL_OBSERVER_MS` du schéma zod `src/config.ts`, de
   `.env.example`, de `DEPLOY.md`. Retrait de l'orphelin `OBSERVER_API_URL`
   de `/root/satrank/.env.production` (backup `.env.production.bak-observer-sunset`).

4. **Narratif** — repositionnement « AI agents » → « autonomous agents
   on Bitcoin Lightning » sur 12 fichiers (openapi, mcp-server.json,
   sdk/package.json, python-sdk/pyproject.toml, marketing copy public/,
   IMPACT-STATEMENT, INTEGRATION).

## Ce que la Phase 12C ne fait pas

- **Pas de réactivation par flag.** Le code est supprimé, pas commenté.
  Git garde l'historique. Une réactivation future nécessiterait un
  reimplem complet ou un revert commit-by-commit.
- **Pas de wrapper de compatibilité.** Les consommateurs qui lisent
  `agents.source='observer_protocol'` en DB recevront zéro ligne
  (valeur purgée) — pas de faux renommage en `attestation` côté
  application.
- **Pas de changement d'API publique.** Les endpoints `/api/*` ne
  référençaient jamais Observer dans leur contrat — aucune breaking
  change côté consommateur.

## Condition de réactivation

Toute réactivation future exige :

1. **Partenariat explicite écrit** entre SatRank (Romain Orsoni) et
   Observer Protocol, signé et versé au repo (`docs/partnerships/`).
2. **Scope précis** — ingestion quelles routes, quel volume, quelle
   fréquence, quels droits d'usage réciproques.
3. **Authentification négociée** — clé API ou équivalent, posée dans
   secrets, pas en clair.
4. **Rebuild from scratch** — pas de revert du commit Phase 12C ; une
   implémentation propre sur la base du schéma actuel.

Par défaut : **pas de réactivation**.

## Pointeurs

- `OBSERVER-401-INVESTIGATION.md` — analyse du 401 qui a déclenché le
  questionnement initial (investigation-only, décision reportée au
  checkpoint).
- `OPS-ISSUES.md` Finding D — trace du sunset en tant qu'item du backlog
  ops.
- Commit Phase 12C unique : `feat(phase-12c): sunset Observer Protocol
  — remove code, purge data, rename enum to 'attestation', reposition
  narrative from "AI agents" to "autonomous agents on Bitcoin
  Lightning"` (branche `phase-12c-ops`).
