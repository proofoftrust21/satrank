# Phase 3 — Bayesian scoring layer

**Status:** design committed 2026-04-18.
**Branch:** `phase-3-bayesian-scoring` from `main@f1e2a5e`.
**Validation criterion:** Kendall τ ≥ 0.90 entre le ranking bayésien et `computeLegacyComposite()` (interne) sur le top-500 endpoints.

## 1. Motivation

Le score composite v30 (`WEIGHT_VOLUME × 0.25 + WEIGHT_REPUTATION × 0.30 + ...`) retourne un nombre 0-100 qui agrège cinq composantes hétérogènes avec des poids fixes. Trois limites :

1. **Pas d'incertitude exposée** — un agent avec 2 transactions et un agent avec 2000 transactions obtiennent des scores sur la même échelle, sans bande de confiance.
2. **Pas d'actualisation continue** — les composantes sont recalculées périodiquement, rendant l'impact d'une nouvelle transaction invisible jusqu'au prochain batch.
3. **Pas de séparation des sources** — un probe souverain, un rapport agent et un paid probe entrent dans le même agrégat sans traçabilité.

L'approche bayésienne Beta-Binomial résout les trois.

## 2. Modèle

### 2.1 Couple (α, β) par cible

Chaque cible (endpoint HTTP, node LN, service, operator, route) maintient un posterior Beta(α, β) par fenêtre temporelle. Les compteurs `n_success` / `n_failure` sont incrémentés à chaque transaction observable. On dérive :

- `p_success = α / (α + β)`
- `ci95 = [betaPPF(α, β, 0.025), betaPPF(α, β, 0.975)]` (approximation normale pour n ≥ 30)

### 2.2 Prior hiérarchique

Cascade : operator → service → category → flat(α₀=1.5, β₀=1.5).
Si un niveau a `n_obs ≥ MIN_N_OBS_FOR_PRIOR_INHERITANCE`, on adopte son (α, β) comme prior du niveau enfant. Sinon, on remonte.

### 2.3 Fenêtres temporelles

Trois horizons : 24h / 7j / 30j. Auto-sélection : la plus courte avec `n_obs ≥ 20`.
Décroissance exponentielle à la lecture (τ = fenêtre / 3) : une observation à t = τ de maintenant compte pour e⁻¹ ≈ 0.368.

### 2.4 Séparation des sources

Trois posteriors parallèles par cible :
- `probe` (sovereign_probe, poids 1.0)
- `report` (agent_report, poids selon tier : low=0.3, medium=0.5, high=0.7, NIP-98=1.0)
- `paid` (paid_probe, poids 2.0)

L'agrégat combiné est la moyenne pondérée des trois posteriors (par somme des poids).

### 2.5 Convergence

SAFE exige **≥ 2 sources** avec `p_success ≥ 0.80`. Une source seule ne suffit pas.

## 3. Verdict mapping

| Verdict | Condition |
|---|---|
| `SAFE` | p ≥ 0.80 ∧ ci95_low ≥ 0.65 ∧ n_obs ≥ 10 ∧ ≥ 2 sources convergent |
| `RISKY` | p < 0.50 ∨ ci95_high < 0.65 |
| `UNKNOWN` | n_obs < 10 ∨ (ci95_high − ci95_low) > 0.40 (sauf si RISKY) |
| `INSUFFICIENT` | n_obs == 0 |

Priorité : RISKY > UNKNOWN > INSUFFICIENT. SAFE uniquement si convergence.

## 4. Schéma SQL (migration v33)

### 4.1 `score_snapshots` (modification)
DROP : `score REAL`, `components TEXT`
ADD : `posterior_alpha REAL`, `posterior_beta REAL`, `p_success REAL`, `ci95_low REAL`, `ci95_high REAL`, `n_obs INTEGER`, `window TEXT`, `updated_at INTEGER`

### 4.2 Nouvelles tables `*_aggregates`
Cinq tables identiques dans la structure (PK composite `(id_hash, window)`) :
- `endpoint_aggregates` (id = url_hash)
- `node_aggregates` (id = pubkey) — deux posteriors : routing + delivery
- `service_aggregates` (id = service_url)
- `operator_aggregates` (id = operator_id)
- `route_aggregates` (id = caller_hash || target_hash)

Colonnes communes : `n_success INTEGER`, `n_failure INTEGER`, `n_obs INTEGER`, `posterior_alpha REAL`, `posterior_beta REAL`, `updated_at INTEGER`.

## 5. Stratégie de recalcul (choisie en C8)

**Option A retenue** : les aggregates stockent les compteurs raw non-décroissants. La décroissance exponentielle est appliquée à la lecture par `computePosterior()` en ré-agrégeant sur les timestamps dans la fenêtre. Incrémental à l'INSERT, exact à la lecture.

Fallback Option B (flat window, pas de décroissance) documenté dans `PHASE-3-REPORT.md` si A s'avère trop coûteux.

## 6. API response shape

```jsonc
{
  "verdict": "SAFE" | "RISKY" | "UNKNOWN" | "INSUFFICIENT",
  "p_success": 0.87,
  "ci95_low": 0.78,
  "ci95_high": 0.93,
  "n_obs": 142,
  "window": "7d",
  "sources": {
    "probe":  { "p_success": 0.85, "ci95_low": 0.72, "ci95_high": 0.92, "n_obs": 80, "weight_total": 80.0 },
    "report": { "p_success": 0.90, "ci95_low": 0.75, "ci95_high": 0.97, "n_obs": 52, "weight_total": 28.4 },
    "paid":   { "p_success": 0.88, "ci95_low": 0.70, "ci95_high": 0.96, "n_obs": 10, "weight_total": 20.0 }
  },
  "convergence": {
    "converged": true,
    "sources_above_threshold": ["probe", "report", "paid"],
    "threshold": 0.80
  }
}
```

Aucun champ `score` (0-100), aucun champ `legacy_composite_score`. Un client sophistiqué peut réarbitrer via `sources.*`.

## 7. Endpoints migrés (C9)

`/api/agent/:hash/verdict`, `/api/verdicts`, `/api/decide`, `/api/top`, `/api/movers`, `/api/agents/search`, `/api/profile/:id`, `/api/services`, `/api/services/best`.

## 8. NIP-85 kind 30382 (C10)

Tags remplacés : `score` → `verdict`, `p_success`, `ci95_low`, `ci95_high`, `n_obs`, `window`.

## 9. Validation

1. **Unitaires** : 30+ tests (betaBinomial, rankCorrelation, aggregates, scoring, verdict, sources, API).
2. **Diagnostic** : `npm run diag:phase3` → `compareLegacyVsBayesian.ts` — Kendall τ ≥ 0.90 requis.
3. **Benchmark** : 1000 UPDATEs < 5 s.

## 10. Ce qui n'est PAS dans Phase 3

- Cohabitation legacy ↔ bayésien dans l'API publique (supprimé).
- Champ `legacy_composite_score` exposé publiquement (supprimé).
- Seuils configurables par opérateur (futur).
- Calibration dynamique du prior hiérarchique (futur).
