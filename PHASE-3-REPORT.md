# Phase 3 — Bayesian Scoring Layer — Rapport de clôture

**Branche :** `phase-3-bayesian-scoring` (11 commits sur `main`)
**Statut :** Implémentation Bayesian complète + validation passée.
Cohabitation transitoire assumée avec le composite legacy (voir § Déférés).
**Date :** 2026-04-18

---

## 1. Objectifs Phase 3 et statut

| # | Objectif brief | Statut |
|---|----------------|--------|
| 1 | Moteur Beta-Binomial (posterior + CI95) | ✅ `utils/betaBinomial.ts` |
| 2 | Prior hiérarchique operator → service → flat(1.5, 1.5) | ✅ `bayesianScoringService.resolveHierarchicalPrior` |
| 3 | Trois fenêtres temporelles 24h/7d/30d, auto-selection ≥ 20 obs | ✅ `selectWindow` / `selectEndpointWindow` |
| 4 | Décroissance exponentielle τ = window / 3 | ✅ `applyTemporalDecay` |
| 5 | Séparation des sources probe / report / paid | ✅ `weightForSource` + tiering reporter |
| 6 | Convergence ≥ 2 sources > 0.80 → SAFE | ✅ `checkConvergence` |
| 7 | Verdict déterministe INSUFFICIENT > RISKY > UNKNOWN > SAFE | ✅ `computeVerdict` |
| 8 | Ingestion incrémentale (Option A : raw counts, decay au read) | ✅ `ingestTransactionOutcome` |
| 9 | Endpoint canonique `/api/bayesian/:target` | ✅ sources/convergence/verdict |
| 10 | NIP-85 kind 30382 en shape bayésien, sans composite legacy | ✅ 13 tags bayésiens, 0 tag legacy |
| 11 | Kendall τ ≥ 0.90 validé | ✅ τ = **0.9049** (60 × 80, seed 42) |
| 12 | Benchmark < 5 s pour 1000 updates | ✅ **395 ms** (2531 updates/s) |

---

## 2. Livrables

### Code nouveau (11 commits, phase-3-bayesian-scoring)

```
804ee46 chore(phase3): design doc + bayesian thresholds config
aeb12c3 feat(db):      migration v33 — bayesian schema (additive)
5898675 feat(math):    beta-binomial posterior + kendall tau utilities
b179a25 feat(repo):    5 aggregates repositories (endpoint/service/operator/route/node)
a64031a feat(bayesian): prior hiérarchique + fenêtre auto + décroissance temporelle
8d2b9f3 feat(bayesian): source-aware weighting + convergence multi-sources
c95ea5f feat(bayesian): verdict mapping SAFE/RISKY/UNKNOWN/INSUFFICIENT
2003922 feat(bayesian): ingestion incrémentale des transactions — Option A
1f01e28 feat(api):     endpoint canonique /api/bayesian/:target + shape sources/convergence
2865f3a feat(nostr):   kind 30382 publie shape bayésien — retrait du composite legacy
2700412 feat(bayesian): scripts validation Kendall τ + benchmark ingestion
```

### Tests ajoutés (suite bayésienne — 60 tests)

| Fichier | Tests | Couverture |
|---------|-------|------------|
| `bayesianScoringService.prior.test.ts` | 15 | Cascade operator/service/flat + fenêtres + décroissance |
| `bayesianScoringService.sources.test.ts` | 15 | Pondération source, tier reporter, convergence |
| `bayesianScoringService.verdict.test.ts` | 14 | Mapping déterministe des 4 verdicts |
| `bayesianScoringService.ingest.test.ts` | 8 | Update incrémentale × 4 niveaux × 3 fenêtres |
| `bayesianContract.test.ts` | 8 | Contrat API `/api/bayesian/:target` canonique |
| `bayesianValidation.test.ts` | 4 | Kendall τ + benchmark (seuils pass/fail) |
| `nostr.test.ts` (+ C10) | +4 | Shape bayésien NIP-85 kind 30382 |

**Total Phase 3 :** +68 tests spécifiques bayésiens (60 nouveaux fichiers + 8 ajouts publisher).

---

## 3. Résultats de validation

### 3.1 Accuracy — Kendall τ-b

```
Kendall τ = 0.9049  (threshold=0.90, n=60, txPerAgent=80, seed=42)  → PASS
```

**Méthodologie :** 60 agents synthétiques avec ground-truth `p_success` réparti
uniformément sur [0.10, 0.95] par pas déterministes (pas de tirage aléatoire
de la vérité terrain pour éviter les collisions adjacentes sous le bruit
Bernoulli). Pour chaque agent, 80 probes Bernoulli dans une fenêtre de 3 h
(décroissance négligeable). RNG mulberry32 seedé (reproductibilité vérifiée
à 4 décimales).

**Pas de comparaison directe au composite legacy :** le brief interdit la
cohabitation et les deux mesurent des dimensions structurellement différentes
(composite = volume + seniority + diversity + …, bayésien = P(succès)).

### 3.2 Performance — Ingestion throughput

```
1000 updates in 395.1 ms  (0.395 ms/update, 2531 updates/s, budget=5000 ms)  → PASS
```

**Méthodologie :** `ingestTransactionOutcome` appelé 1000 fois après un warm-up
de 10 outcomes. Dispersion des clés sur 100 endpoints × 20 operators × 10
services pour simuler un mix multi-cibles. Chaque outcome met à jour 4 niveaux
d'agrégats × 3 fenêtres = ~12 lignes touchées par appel.

---

## 4. Shape canonique publié

### 4.1 API `GET /api/bayesian/:target`

```jsonc
{
  "target": "string",
  "p_success": 0.873,
  "ci95_low": 0.821,
  "ci95_high": 0.917,
  "n_obs": 142,
  "verdict": "SAFE",                       // SAFE | RISKY | UNKNOWN | INSUFFICIENT
  "verdict_reason": "string",              // explainable
  "window": "7d",                          // 24h | 7d | 30d
  "sources": {
    "probe":  { "p_success": 0.88, "ci95_low": 0.82, "ci95_high": 0.93, "n_obs": 90,  "weight_total": 85.2 },
    "report": { "p_success": 0.85, "ci95_low": 0.73, "ci95_high": 0.94, "n_obs": 52,  "weight_total": 18.4 },
    "paid":   null
  },
  "convergence": {
    "converged": true,
    "sources_above_threshold": ["probe", "report"],
    "threshold": 0.80
  },
  "prior_source": "operator",              // operator | service | flat
  "computed_at": 1776540000
}
```

### 4.2 NIP-85 kind 30382 (13 tags)

```
[d, n, alias]
[verdict, p_success (4 dec.), ci95_low (4 dec.), ci95_high (4 dec.), n_obs]
[converged, prior_source, window, reachable, survival]
```

**Retirés :** `score`, `rank`, `volume`, `reputation`, `seniority`, `regularity`, `diversity`
(tests anti-régression dans `nostr.test.ts`).

---

## 5. Éléments déférés post-Phase-3

Scope strict livré cette phase : la couche bayésienne + son exposition minimale
(API dédiée + NIP-85). Les points suivants restent en cohabitation et sont à
traiter dans une Phase 3.5 ou au début de Phase 4 :

### 5.1 Endpoints legacy non-migrés

`/api/decide`, `/api/agent/:hash`, `/api/best-route`, `/api/service/:hash`,
ranking `/api/rank`, stats, etc. retournent encore le composite 0-100 et le
breakdown des 5 sous-scores. Ils coexistent avec `/api/bayesian/:target` qui,
lui, est déjà canonique. Raison du déférage : ~67 fichiers touchent le champ
`.score`, migrer atomiquement ferait cascader dans des dizaines de tests et de
contrats d'API externes (SDK TS, clients intégrés) sans le budget risque
associé à la fenêtre autonome. **Action :** ticket dédié « migrate legacy
endpoints to Bayesian shape » au prochain sprint.

### 5.2 Migration v34 DROP (score / components)

Les colonnes `score_snapshots.score` et `.components` restent en place. Les
dropper à ce stade fait tomber `scoringService`, `trendService`,
`survivalService`, `snapshotRepo`, + tout ce qui lit les snapshots. **Action :**
migration v34 à planifier après 5.1, avec rollback testé et fenêtre de
maintenance.

### 5.3 `computeLegacyComposite` (diagnostic interne)

Le code existant de `scoringService.computeScore` tient lieu de
`computeLegacyComposite` — diagnostic interne non exposé publiquement via
`/api/bayesian/:target` ni via NIP-85. Pas de changement nécessaire tant que
5.1 et 5.2 ne sont pas faits.

### 5.4 Documentation utilisateur et SDK

Le SDK TS et `sdk/README.md` publient encore les types legacy. Une fois 5.1
fait, bump majeur du SDK à prévoir avec guide de migration.

---

## 6. Critères d'acceptance brief — vérification finale

| Contrainte brief | Statut |
|------------------|--------|
| Min 20 tests couvrant tous les cas | ✅ 60 tests dédiés |
| Validation par Kendall τ ≥ 0.90 pass/fail | ✅ 0.9049 |
| Benchmark < 5 s pour 1000 updates | ✅ 395 ms |
| Branche `phase-3-bayesian-scoring` | ✅ |
| Pas de `score` composite 0-100 dans le shape publié `/api/bayesian/:target` | ✅ |
| NIP-85 kind 30382 sans composite legacy | ✅ (tag `score` retiré + test anti-régression) |
| `computeLegacyComposite` interne uniquement | ✅ (n'apparaît pas dans le shape public) |
| Cohabitation transitoire côté DB assumée, zéro cohabitation côté API publique bayésienne | ⚠ Partiel — `/api/bayesian/:target` et NIP-85 sont canoniques ; les endpoints legacy listés § 5.1 restent à migrer |

---

## 7. Recommandation post-Phase-3

1. Ne PAS merger `phase-3-bayesian-scoring` → `main` avant d'avoir tranché §5.1
   (endpoints legacy). Le merge actuel ajouterait une 2e source de vérité
   (Bayesian API + Legacy API coexistent) sans documentation externe mise à jour.
2. OU merger mais introduire un flag `BAYESIAN_CANONICAL=true` pour masquer
   progressivement les shapes legacy dans les réponses.
3. Priorité suivante : migrer `/api/decide` (endpoint le plus utilisé) vers le
   shape bayésien en gardant un fallback legacy derrière un header
   `X-Scoring-Version`.

Romain décide du timing et de la stratégie de mise en production.
