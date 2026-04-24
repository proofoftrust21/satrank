# Phase 3 — Livrable : Scoring bayésien streaming (Beta-Binomial)

**Date** : 2026-04-19
**Branche** : `phase-3-bayesian-scoring` (à merger dans `main`)
**Schema DB** : v36 (streaming-only — aggregates droppées)
**Référence design** : `docs/PHASE-3-BAYESIAN-DESIGN.md`

---

## 1. Résumé

Phase 3 remplace le scoring composite v30 (score 0-100 agrégé sur 5 composantes à poids fixes) par un posterior Beta-Binomial par cible, par source, décroissant exponentiellement à τ = 7 jours. Le verdict publié (`SAFE / RISKY / UNKNOWN / INSUFFICIENT`) est dérivé du couple (p_success, IC95, n_obs) sans agrégation linéaire de composantes hétérogènes.

La chaîne C1-C17 livre un refactor atomique **sans cohabitation** : les 5 tables `*_aggregates` sont DROPées en v36, le scoring lit et écrit uniquement dans `*_streaming_posteriors` + `*_daily_buckets`.

- **Schéma streaming** (5 niveaux : endpoint / service / operator / node / route) — une row par (id, source) avec `(α, β, last_update_ts, total_ingestions)`.
- **Décroissance à la lecture** — l'état stocké converge vers le prior flat `Beta(1.5, 1.5)` à la limite Δt → ∞.
- **Séparation des sources** — `probe` (1.0) / `report` (0.3-1.0 selon tier, NIP-98=1.0) / `paid` (2.0). Observer en bucket-only (exclu du verdict par CHECK SQL).
- **Daily buckets display** (30 jours de rétention) — alimentent `recent_activity.{24h, 7d, 30d}` et le `risk_profile` (Option B : tendance success_rate récent vs antérieur).
- **Prior hiérarchique streaming** (C15) — cascade 4 niveaux (`operator → service → category → flat`) calculée sur `streaming_posteriors` avec seuil `PRIOR_MIN_EFFECTIVE_OBS = 30` sur l'excès d'évidence `(α+β) − (α₀+β₀)`.
- **Retention cron** (`npm run bayesian:prune`) — purge buckets > 30 j et streaming rows dormantes > 90 j.
- **Script de rebuild** (`npm run bayesian:rebuild`) — réplay depuis `transactions` vers streaming + buckets, avec `--truncate`, `--dry-run`, `--from-ts`.
- **Backfill probe** (`npm run bayesian:backfill-probe`) — migre `probe_results` → `transactions` + ingestion streaming dans une transaction atomique.
- **Benchmark hot path** (`npm run bayesian:benchmark`) — 1000 `ingestStreaming` < 5 s (mesure locale : 0.20 ms/update, 4937/s).

**Tests** : 879 passing (79 fichiers). Zéro lint TypeScript. `BayesianScoringService` constructeur passe de 15 à 10 repos (5 streaming + 5 buckets), sans dépendance aggregates.

**Validation** :
- Kendall τ legacy vs bayesian : **0.9038** (seuil ≥ 0.90).
- Benchmark : **202.5 ms pour 1000 updates** (budget 5 000 ms).

---

## 2. Chaîne C1-C17

| # | Sujet |
| --- | --- |
| C1  | migration v35 — `*_streaming_posteriors` + `*_daily_buckets` (additive) |
| C2  | bayesianConfig — `TAU_DAYS=7`, `BUCKET_RETENTION_DAYS=30`, thresholds `risk_profile` |
| C3  | `StreamingPosteriorRepository` x5 + décroissance exp(-Δt/τ) |
| C4  | `DailyBucketsRepository` x5 — compteurs display-only |
| C5  | `BayesianScoringService.ingestStreaming` + `computeRiskProfile` (Option B) |
| C6  | `probeCrawler` → `ingestStreaming` (transaction-safe) |
| C7  | `reportService` → `ingestStreaming` (weight par tier, identifié + anonyme) |
| C8  | `observerCrawler` → `ingestStreaming` (buckets only — observer exclu du streaming) |
| C9  | API shape streaming publique + fix out-of-order backfill |
| C10 | backfill probe → streaming |
| C11 | `rebuildStreamingPosteriors` script |
| C12 | cron retention Bayesian (buckets + streaming stale) |
| C13 | benchmark `ingestStreaming` hot path |
| C14 | rapport de phase + cadrage refactor streaming |
| C15 | `resolveHierarchicalPrior` 100 % streaming — cascade 4 niveaux (operator → service → category → flat), constante `PRIOR_MIN_EFFECTIVE_OBS = 30` |
| C16 | Suppression `ingestTransactionOutcome` + tous les callers aggregates (probeCrawler, reportService, backfill) — grep 0 hit |
| C17 | Migration v36 `DROP TABLE *_aggregates` ×5 + suppression `aggregatesRepository.ts` + constructeur `BayesianScoringService` ramené à 10 params (5 streaming + 5 buckets) — 15+ sites de construction rebasés |

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

### Prior hiérarchique streaming (C15)

`resolveHierarchicalPrior` cascade 4 niveaux sur `streaming_posteriors` (sommation inter-sources `(α − α₀, β − β₀)` puis décroissance) :

1. **operator** — `operatorStreamingRepo.readAllSourcesDecayed(operatorId, now)` sommé sur probe+report+paid. Seuil `nObsEffective ≥ 30` ; sinon descendre.
2. **service** — même logique sur `serviceStreamingRepo`.
3. **category** — agrégation des endpoints-frères de la même catégorie de service (somme inter-endpoints).
4. **flat** — fallback `Beta(1.5, 1.5)`.

Le seuil 30 correspond à l'effective excess (pas au raw count) — cohérent avec l'espace des posteriors streaming où `n_obs_effective` est la métrique sémantique utilisée partout ailleurs (verdict, convergence, risk_profile).

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

## 5. Migration v36 — DROP aggregates

Le point de cohabitation documenté en C14 est levé en C17. La migration v36 :

```sql
DROP TABLE endpoint_aggregates;
DROP TABLE service_aggregates;
DROP TABLE operator_aggregates;
DROP TABLE node_aggregates;
DROP TABLE route_aggregates;
```

Les index associés tombent avec (CASCADE implicite sur SQLite). La rollback v36 recrée les tables vides au schéma v33 (pour pouvoir revenir à une image antérieure si besoin d'audit), mais le chemin de production ne réhydrate plus jamais ces tables.

**Callers supprimés** :
- `bayesianScoringService.ingestTransactionOutcome` (le dual-write path).
- `bayesianScoringService.checkConvergence` (utilisé seulement par le dual-write).
- Import `aggregatesRepository` dans 17 fichiers (app.ts, crawler/run.ts, mcp/server.ts, 4 scripts, 10 tests).

**Effet de bord sur la lecture** : le verdict lit depuis `streaming_posteriors`, jamais depuis aggregates → aucun changement observable côté API.

---

## 6. Commandes utiles

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

## 7. Ce que Phase 3 **n'adresse pas** (hors scope)

- **Pondération économique du verdict par les montants des transactions** — tout tx compte pour 1 observation, quel que soit le bucket de montant. Rationalisé : Phase 3 est un refactor d'infra (streaming vs aggregates), pas un changement de sémantique observationnelle.
- **Décroissance par source différenciée** — tous les posteriors utilisent τ = 7 j. Un signal `paid` plus rare/cher pourrait mériter un τ plus long, mais cela complique le modèle sans demande produit claire.
- **Cross-node prior sharing** — on n'exploite pas la proximité de réseau (channels partagés) pour accélérer la convergence d'un node peu observé. Sujet Phase 4+.

---

**Fin du livrable Phase 3.** Le score bayésien streaming est livré sans cohabitation — le code de lecture et d'écriture est 100 % streaming, la table aggregates a été droppée en v36.
