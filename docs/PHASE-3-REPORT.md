# Phase 3 — Livrable : Scoring bayésien streaming (Beta-Binomial)

**Date** : 2026-04-19
**Branche** : `phase-3-bayesian-scoring` (à merger dans `main`)
**Schema DB** : v35 (ajout `*_streaming_posteriors` + `*_daily_buckets`)
**Référence design** : `docs/PHASE-3-BAYESIAN-DESIGN.md`

---

## 1. Résumé

Phase 3 remplace le scoring composite v30 (score 0-100 agrégé sur 5 composantes à poids fixes) par un posterior Beta-Binomial par cible, par source, décroissant exponentiellement à τ = 7 jours. Le verdict publié (`SAFE / RISKY / UNKNOWN / INSUFFICIENT`) est dérivé du couple (p_success, IC95, n_obs) sans agrégation linéaire de composantes hétérogènes.

La chaîne C1-C14 du refactor Phase 3 livre :
- **Schéma streaming** (5 niveaux : endpoint / service / operator / node / route) — une row par (id, source) avec `(α, β, last_update_ts, total_ingestions)`.
- **Décroissance à la lecture** — l'état stocké converge vers le prior flat `Beta(1.5, 1.5)` à la limite Δt → ∞.
- **Séparation des sources** — `probe` (1.0) / `report` (0.3-1.0 selon tier) / `paid` (2.0). Observer en bucket-only (exclu du verdict par CHECK SQL).
- **Daily buckets display** (30 jours de rétention) — alimentent `recent_activity.{24h, 7d, 30d}` et le `risk_profile` (Option B : tendance success_rate récent vs antérieur).
- **Retention cron** (`npm run bayesian:prune`) — purge buckets > 30 j et streaming rows dormantes > 90 j.
- **Script de rebuild** (`npm run bayesian:rebuild`) — réplay depuis `transactions` vers streaming + buckets, avec `--truncate`, `--dry-run`, `--from-ts`.
- **Backfill probe** (`npm run bayesian:backfill-probe`) — migre `probe_results` → `transactions` + ingestion streaming dans une transaction atomique.
- **Benchmark hot path** (`npm run bayesian:benchmark`) — 1000 `ingestStreaming` < 5 s (mesure locale : 0.19 ms/update, 5234/s).

**Tests** : 922 passing (81 fichiers). Zéro lint TypeScript. Le chemin chaud tient son budget 5 ms/update avec ~10 tables touchées par observation.

---

## 2. Chaîne C1-C14

| # | SHA | Sujet |
| --- | --- | --- |
| C1  | `e444454` | migration v35 — `*_streaming_posteriors` + `*_daily_buckets` (additive) |
| C2  | `5195267` | bayesianConfig — `TAU_DAYS=7`, `BUCKET_RETENTION_DAYS=30`, thresholds `risk_profile` |
| C3  | `8c375fe` | `StreamingPosteriorRepository` x5 + décroissance exp(-Δt/τ) |
| C4  | `fc48950` | `DailyBucketsRepository` x5 — compteurs display-only |
| C5  | `8f0d758` | `BayesianScoringService.ingestStreaming` + `computeRiskProfile` (Option B) |
| C6  | `409401a` | `probeCrawler` → `ingestStreaming` (transaction-safe) |
| C7  | `9e3d3bb` | `reportService` → `ingestStreaming` (weight par tier, identifié + anonyme) |
| C8  | `e061448` | `observerCrawler` → `ingestStreaming` (buckets only — observer exclu du streaming) |
| C9  | `292ee6b` | API shape streaming publique + fix out-of-order backfill |
| C10 | `292ee6b` | (même commit que C9) backfill probe → streaming |
| C11 | `827ef9b` | `rebuildStreamingPosteriors` script |
| C12 | `dda3688` | cron retention Bayesian (buckets + streaming stale) |
| C13 | `e4cbc69` | benchmark `ingestStreaming` hot path |
| C14 | _this_    | rapport de phase + plan de sweep destructif différé |

---

## 3. Critère d'acceptation

`src/tests/phase3EndToEndAcceptance.test.ts` — un endpoint avec 22 probes (14 réussis, 7 échoués, 1 en cours) + 5 reports sur 3 jours calendaires doit passer de `INSUFFICIENT` à un verdict `UNKNOWN` ou mieux. Résultat local :

```
p_success ≈ 0.89
n_obs ≈ 11.6
verdict = UNKNOWN   (≥ UNKNOWN_MIN_N_OBS = 10)
prior_source = flat
recent_activity.last_7d = 22
```

Le critère `n_obs ≥ 10` est atteint via la somme pondérée inter-sources (probe ≈ 7.3 + report ≈ 4.3). La bascule à `SAFE` exige encore la convergence (`≥ 2 sources avec p ≥ 0.80`) — c'est le contrat anti-gaming mono-source.

---

## 4. Design streaming — note clé

### Décroissance avec attracteur prior

La formule retenue garde `Beta(α₀, β₀) = Beta(1.5, 1.5)` comme attracteur :

```
α(t) = (α_stored − α₀) · exp(−Δt/τ) + α₀
β(t) = (β_stored − β₀) · exp(−Δt/τ) + β₀
```

À Δt = 0 on retrouve exactement `(α_stored, β_stored)` — aucune perte d'information si une autre observation arrive immédiatement. À Δt → ∞ on retombe sur le prior flat, pas sur `(0, 0)`. La grandeur qui alimente le verdict est `n_obs_effective = (α + β) − (α₀ + β₀)` — "l'excès d'évidence" au-dessus du prior.

### Out-of-order writes (fix Phase 3 C9+C10)

L'ingestion rebuild arrive volontiers en ordre chronologique inverse (probes des 7 derniers jours, du plus récent au plus ancien). Sans garde, `decayPosterior(Δt < 0)` clampait Δt à 0 et `last_update_ts` régressait → perte d'information cumulative. La correction est dans `streamingPosteriorRepository.ts` :

```
alignTs = max(existing.last_update_ts, nowSec)
si nowSec ≥ existing.last_update_ts :
    décroître depuis existing vers nowSec, puis ajouter Δ
sinon :
    ajouter Δ · exp(−(existing.last_update_ts − nowSec)/τ) — pondération retardée
écrire avec last_update_ts = alignTs (forward-only)
```

Validation mathématique : 22 probes sur 22 jours → `α ≈ 1.5 + Σ exp(−i/7) ≈ 8.68`, `β ≈ 1.61`, `nObsEffective ≈ 7.29`. Confirmé empiriquement.

---

## 5. Ce qui reste en cohabitation

**État actuel** : le chemin d'écriture garde `ingestTransactionOutcome` (écrit dans les 5 tables `*_aggregates`) en parallèle de `ingestStreaming`. Le chemin de lecture verdict (`bayesianVerdictService.buildVerdict`) lit **uniquement** depuis `*_streaming_posteriors` + `*_daily_buckets`, **sauf** pour `resolveHierarchicalPrior` qui interroge encore `operator_aggregates` et `service_aggregates` pour la cascade du prior hérité.

Pourquoi la cohabitation est acceptée sur cette phase :
- **Irréversibilité d'un DROP** — une migration `DROP TABLE *_aggregates` est destructive. Le risque d'une régression silencieuse (ex. un test passe, un chemin de prod non couvert tombe en flat prior en silence) est réel tant que le chemin streaming n'a pas soaké en prod ≥ 7 jours.
- **Le prior hiérarchique est un fallback** — sa dérivation depuis operator/service streaming doit être réimplémentée avec `readAllSourcesDecayed` et un seuil sur `nObsEffective` (30) plutôt que sur `n_obs` raw. Changement local mais sémantiquement nouveau (raw count ≠ effective excess) — mérite son propre commit + tests dédiés.

Ce n'est pas une cohabitation d'endpoint public (cf. principe produit "jamais d'endpoint parallèle") — c'est une cohabitation d'infrastructure interne pendant la montée en charge du successeur.

---

## 6. Sweep destructif — plan C15

À lancer après ≥ 7 jours de prod sur le chemin streaming, avec `bayesian_rebuild:prod --truncate` joué la veille pour garantir que les streaming tables sont canoniques :

1. **Migrer `resolveHierarchicalPrior` vers streaming**
   - Signature : `resolveHierarchicalPrior(ctx) → ResolvedPrior` (supprimer `window`).
   - Lire `operatorStreamingRepo.readAllSourcesDecayed(operatorId, now)` puis sommer `(α − α₀, β − β₀)` sur les 3 sources.
   - Seuil : `nObsEffective ≥ MIN_N_OBS_FOR_PRIOR_INHERITANCE` (à recalibrer — l'effective est décroissant, le raw ne l'était pas).
   - Ajuster les tests dans `bayesianScoringService.prior.test.ts`.

2. **Supprimer les callers de `ingestTransactionOutcome`**
   - `probeCrawler.ts:247`, `reportService.ts:220` + `:411`, `backfillProbeResultsToTransactions.ts:222`.
   - Garder uniquement `ingestStreaming`.

3. **Nettoyer `bayesianScoringService.ts`**
   - Supprimer : `ingestTransactionOutcome`, `selectWindow`, `selectEndpointWindow`, `applyTemporalDecay`, `windowSeconds`, `windowTau`, `aggregateToPosterior`.
   - Retirer les 5 aggregates repos du constructeur (reste 10 params : 5 streaming + 5 buckets).
   - Nettoyer les imports inutilisés (`BAYESIAN_WINDOWS`, `MIN_N_OBS_FOR_WINDOW`, `WINDOW_SECONDS`, `DECAY_TAU_FRACTION`).

4. **Supprimer les fichiers dédiés aggregates**
   - `src/repositories/aggregatesRepository.ts`
   - `src/tests/aggregatesRepository.test.ts`
   - `src/tests/bayesianScoringService.ingest.test.ts`
   - Migrer `bayesianScoringService.prior.test.ts` vers streaming.

5. **Mettre à jour les 15+ sites de construction** de `BayesianScoringService` : `app.ts`, `crawler/run.ts` (×3), `mcp/server.ts`, scripts (×4), tests (×7).

6. **Migration v36 — DROP TABLE**
   - `DROP TABLE endpoint_aggregates`, `service_aggregates`, `operator_aggregates`, `node_aggregates`, `route_aggregates`.
   - Laisser les index associés tomber avec (CASCADE implicite sur SQLite).

7. **Vérifications**
   - `npm run lint` ✓
   - `npx vitest run` ✓ (sera moins de 922 tests après les suppressions)
   - Smoke prod : compare `buildVerdict` output sur top-20 endpoints avant/après sweep. Tolérance sur `prior_source` : `operator` → peut devenir `flat` si operator streaming < seuil.

Budget estimé : 3-4 h de travail focalisé + revue.

---

## 7. Commandes utiles

```bash
# Rebuild from scratch après backfill massif
npm run bayesian:rebuild -- --truncate

# Dry-run pour audit
npm run bayesian:rebuild -- --dry-run --from-ts=$(date -d '7 days ago' +%s)

# Purge quotidienne (à installer dans cron)
npm run bayesian:prune:prod

# Benchmark hot path — seuil 5 s pour 1000 updates
npm run bayesian:benchmark

# Validation Kendall τ legacy vs bayesian — seuil ≥ 0.90
npm run bayesian:kendall
```

---

## 8. Ce que Phase 3 **n'adresse pas** (hors scope)

- **Pondération économique du verdict par les montants des transactions** — tout tx compte pour 1 observation, quel que soit le bucket de montant. Rationalisé : Phase 3 est un refactor d'infra (streaming vs aggregates), pas un changement de sémantique observationnelle.
- **Décroissance par source différenciée** — tous les posteriors utilisent τ = 7 j. Un signal `paid` plus rare/cher pourrait mériter un τ plus long, mais cela complique le modèle sans demande produit claire.
- **Cross-node prior sharing** — on n'exploite pas la proximité de réseau (channels partagés) pour accélérer la convergence d'un node peu observé. Sujet Phase 4+.

---

**Fin du livrable Phase 3.** Le score bayésien streaming est déployable en cohabitation contrôlée ; le sweep destructif est documenté et reporté en C15.
