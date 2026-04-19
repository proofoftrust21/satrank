# Phase 4 — Reconciliation audit vs code post-Phase 3

**Date** : 2026-04-19
**Contexte** : `docs/BINARY-TO-GRADUATED-AUDIT.md` a été écrit le 2026-04-17 en schéma v30 sur commit `2a6aa78`, avant Phase 3. Phase 3 (merge `1e202af`, schéma v36) a retiré le score composite des réponses publiques, introduit le moteur bayésien, et réorganisé `verdictService` / `decideService`. Plusieurs points de l'audit ont été invalidés, modifiés, ou préservés. Ce document arbitre point par point.

---

## Légende

- **OBSOLÈTE** : la règle binaire décrite dans l'audit n'existe plus dans le code — Phase 3 l'a supprimée ou remplacée par une construction déjà graduée. Ne PAS convertir selon l'énoncé de l'audit (mais possible enrichissement orthogonal).
- **MODIFIÉ** : la règle binaire existe encore mais sa forme a changé. Conversion nécessaire, mais sur la forme post-Phase 3, pas celle décrite dans l'audit.
- **ACTUEL** : la règle binaire est inchangée depuis le doc. Conversion directe selon l'audit.

---

## 1. Règles requises par Romain

### 1.1 Seuil SAFE 47 — **OBSOLÈTE**

- **Audit** : `src/services/verdictService.ts:147` : `if (total ≥ 47 && !hasCriticalFlags && confidence ≥ 0.50) verdict = 'SAFE'`.
- **État actuel** : `verdictService.ts` ne référence plus `total` ni le seuil 47 pour déterminer le verdict. Ligne 116 : `let verdict: Verdict = bayes.verdict;` — le verdict vient intégralement du `BayesianVerdictService` (p_success + ci95 + n_obs_effective).
- **`VERDICT_SAFE_THRESHOLD = 47`** (`src/config/scoring.ts:163`) n'est utilisé qu'en commentaires historiques (`serviceController.ts:141`, `nostrIndexedPublisher.ts:252`).
- **Action Phase 4** : **NE PAS convertir selon l'énoncé de l'audit**. Le verdict est déjà gradué par Phase 3 (p_success + CI + n_obs). Mais on peut **ajouter** un `advisory_level` orthogonal calibré sur (`p_success`, `ci95_low`, `ci95_high`, `flags`) comme enrichissement complémentaire. Retirer la constante `VERDICT_SAFE_THRESHOLD` au passage (dead code).

### 1.2 P_empirical gate — **OBSOLÈTE**

- **Audit** : `EMPIRICAL_THRESHOLD = 10` dans `decideService.ts:17`, gate à `:228`.
- **État actuel** : décommissionné en Phase 3. `decideService.ts:213-215` documente : *"No empirical/proxy split — the Bayesian layer already weighs reports, probes, and paid observations under a single posterior."* Plus de `EMPIRICAL_THRESHOLD`, plus de `hasEmpirical`, plus de `basis: 'empirical'|'proxy'`.
- **Action Phase 4** : **NE PAS convertir**. Le posterior unique bayésien remplace la logique d'origine.

### 1.3 Candidates = 0 dans `/api/services/best` — **MODIFIÉ**

- **Audit** : filtre `score ≥ 47 AND uptimeRatio > 0 AND price > 0 AND minUptime AND httpHealth ≠ down`, vide → `candidates: 0`.
- **État actuel** (`serviceController.ts:155-162`) : filtre est maintenant `bayesian.verdict === 'SAFE' AND uptimeRatio > 0 AND price > 0 AND ≥ minUptime AND httpHealth ≠ down`. Vide → `candidates: 0` identique.
- **Action Phase 4** : **convertir**, mais le fallback tiered doit relâcher sur `verdict ∈ {SAFE, UNKNOWN}` (+ advisory_level ≤ yellow), **pas sur `score ≥ 30`**. Même logique UX, sémantique adaptée au bayésien.

### 1.4 hasRiskEvidence — **MODIFIÉ**

- **Audit** : 4 conditions OR dans `verdictService.ts:140-143` : `hasCriticalFlags OR flags.includes('unreachable') OR (delta7d < -15) OR (total < 30 AND confidence ≥ 0.25)`.
- **État actuel** (`verdictService.ts:114-119`) : réduit à `hasCriticalFlags = fraud_reported OR negative_reputation` qui escalade un verdict bayésien non-RISKY → RISKY. Les conditions `unreachable`, `delta7d`, `total < 30` ont disparu de cette ligne.
- **Action Phase 4** : **convertir en `risk_score` continu** mais construire les 4 facteurs depuis les signaux actuels :
  - `critical_flags_factor` = présence de fraud_reported / dispute_reported / negative_reputation (pondération principale)
  - `reachability_factor` = 1 − reachability (issu de 2.2 converti)
  - `trend_factor` = decline bayésien sur `bayes.p_success − snapshot.previous_p_success`
  - `uncertainty_factor` = (ci95_high − ci95_low) pondéré par n_obs_effective faible
  - Formule agrégée : `risk_score = 0.4·critical + 0.25·reach + 0.2·trend + 0.15·uncertainty`

---

## 2. Autres règles binaires

### 2.1 `computeReportSignal` cutoff 5 — **ACTUEL**

- **État actuel** : `scoringService.ts:748` : `if (stats.total < REPORT_SIGNAL_MIN_REPORTS) return 0` — cutoff dur inchangé. `REPORT_SIGNAL_MIN_REPORTS = 5` dans `config/scoring.ts:179`.
- **Note** : post-Phase 3 le signal n'alimente plus le verdict public (qui est bayésien) mais reste dans le score composite interne (`avg_score`) utilisé par `riskService` et `survivalService`.
- **Action Phase 4** : **convertir** selon l'audit — damping linéaire `damp = min(1, (total - 1) / 9)`. Impact externe réduit mais cohérent.

### 2.2 Probe unreachable flag — **ACTUEL**

- **État actuel** (`verdictService.ts:77-88`) : `probe.reachable === 0 AND probeAge < TTL AND (!gossipFresh OR bayes.verdict !== 'SAFE') → flags.push('unreachable')`. Test binaire conservé, le garde-fou est maintenant `bayes.verdict === 'SAFE'` au lieu de `total ≥ 47`.
- **Action Phase 4** : **convertir** en `reachability ∈ [0,1]` comme décrit dans l'audit. Flag `unreachable` seulement si `reachability < 0.1`, warning `INTERMITTENT` si `0.1 ≤ reachability < 0.5`.

### 2.3 Service health `'down'` binaire — **ACTUEL**

- **État actuel** (`decideService.ts:82-89` + `:237`) : `classifyHttp(status) → healthy|degraded|down`, puis `serviceDown = status === 'down'` → veto GO.
- **Action Phase 4** : **convertir** en `http_health_score ∈ [0,1]` exposé dans la réponse. Utiliser comme facteur (pas veto absolu) dans `successRate_adjusted`.

### 2.4 GO cutoff `successRate ≥ 0.5` — **ACTUEL**

- **État actuel** (`decideService.ts:238-241`) : `go = verdict === 'SAFE' AND successRate ≥ 0.5 AND !hasCritical AND !serviceDown`. Seuil 0.5 toujours présent.
- **Action Phase 4** : **convertir** en `recommendation ∈ {proceed, proceed_with_caution, consider_alternative, avoid}` calibré sur `ci95_low/ci95_high` du bayésien (Phase 3 fournit déjà ces champs). Boolean `go` conservé pour SDK 0.2.x.

### 2.5 Verdict ternaire `score ≥ 47 ? ... : score ≥ 30 ? ...` — **OBSOLÈTE**

- **État actuel** (`serviceController.ts:30-36` + `watchlistController.ts:88`) : les controllers ne construisent plus de ternaire à partir du score. Le verdict est lu depuis `agentService.toBayesianBlock()` qui expose `bayesian.verdict`.
- **Action Phase 4** : **NE PAS convertir selon l'audit**. Mais **ajouter `advisory_level`** comme enrichissement orthogonal (enrichissement P1 unifié sur les 6 endpoints).

### 2.6 Reporter weight clamp — **PARTIEL**

- **État actuel** (`reportService.ts:127`) : `baseWeight = max(0.3, min(1.0, reporterScore / 80))` inchangé. Le `weight` est déjà exposé ligne 260 dans la réponse `/api/report`.
- **Action Phase 4** : l'audit demande uniquement l'exposition (cosmétique) — déjà partiellement faite. **Ajouter** le `reporter_weight` dans le breakdown bayésien de `/decide` pour cohérence + documenter la formule dans la réponse.

### 2.7 Probe régime — **PARTIEL** (régime 1 seulement)

- **Audit** : 4 paliers discrets 0.65 / 0.70 / 0.80 / 0.90.
- **État actuel** :
  - **Régime 1** (`scoringService.ts:213-225`, base tier unreachable) : **4 paliers discrets conservés** (0.65 / 0.70 / 0.80 / 0.90). Binaire par bande.
  - **Régime 2** (`scoringService.ts:244`, base tier reachable) : `probeMult = max(0.65, signal)` où `signal` est déjà une moyenne pondérée continue des tiers.
- **Action Phase 4** : **convertir le régime 1 uniquement** en formule continue. Régime 2 est déjà gradué.

### 2.8 LOW_UPTIME 0.20 — **ACTUEL**

- **État actuel** (`serviceController.ts:197,205`) : seuil dur conservé.
- **Action Phase 4** : **convertir** selon l'audit (3 bandes UPTIME_CRITICAL/LOW/OK).

### 2.9 Stale health 5 min — **ACTUEL**

- **État actuel** (`serviceController.ts:201,209`) : `STALE_HEALTH_AGE_SEC = 300`, binaire.
- **Action Phase 4** : **convertir** selon l'audit (`health_freshness = exp(-age/600)`).

### 2.10 Base flags binaires — **ACTUEL**

- **État actuel** (`utils/flags.ts:14-35`) : 9 flags, tous binaires. Seuils recalibrés en Phase 3 (ex : `delta7d < -0.10` au lieu de `< -10`, domaine p_success) mais toujours booléens.
- **Action Phase 4** : **convertir** selon l'audit — ajouter `flag_confidence: Record<flag, number ∈ [0,1]>` sans retirer les booléens (non-breaking).

### 2.11 Risk profiles 6 matchers — **ACTUEL**

- **État actuel** (`riskService.ts:30-106`) : 6 profils évalués séquentiellement, premier match gagne. Calibration 2026-04 (delta_rapid_rise=0.26, etc.). `agent.avg_score` lu pour `established_hub`/`small_reliable`.
- **Action Phase 4** : **convertir** selon l'audit — retourner vecteur `{ profile_name: match_strength ∈ [0,1] }` avec `name = argmax` pour compat legacy.

---

## 3. Bilan

| Point | État | Action Phase 4 |
|---|---|---|
| 1.1 SAFE 47 | OBSOLÈTE | Ajouter `advisory_level` orthogonal (P1) ; retirer constante `VERDICT_SAFE_THRESHOLD` |
| 1.2 P_empirical gate | OBSOLÈTE | Aucune |
| 1.3 Candidates = 0 | MODIFIÉ | Fallback tiered sur `verdict ∈ {SAFE, UNKNOWN}` + advisory ≤ yellow (P3) |
| 1.4 hasRiskEvidence | MODIFIÉ | `risk_score` continu depuis 4 facteurs post-Phase 3 (P2) |
| 2.1 Report signal <5 | ACTUEL | Damping `(total-1)/9` (P5) |
| 2.2 Unreachable flag | ACTUEL | `reachability ∈ [0,1]` (P6) |
| 2.3 Service down | ACTUEL | `http_health_score ∈ [0,1]` (P6) |
| 2.4 GO 0.5 | ACTUEL | `recommendation` tiered sur ci95 (P4) |
| 2.5 Verdict ternaire /services | OBSOLÈTE | Exposer `advisory_level` sur les 6 endpoints (P1) |
| 2.6 Reporter weight | PARTIEL | Ajouter exposition dans `/decide` (P6) |
| 2.7 Probe régime 1 | PARTIEL | Formule continue régime 1 uniquement (P6) |
| 2.8 LOW_UPTIME | ACTUEL | 3 bandes (P6) |
| 2.9 Stale health | ACTUEL | `health_freshness = exp(-age/600)` (P6) |
| 2.10 Base flags | ACTUEL | `flag_confidence` additif (P6) |
| 2.11 Risk profiles | ACTUEL | Vecteur de scores (P6) |

**Comptage** :
- 2 points **OBSOLÈTES** purs (1.2 + 2.5) → non convertis par design
- 1 point **OBSOLÈTE mais donnant enrichissement** (1.1 → advisory_level)
- 3 points **MODIFIÉS** (1.3, 1.4, 2.6, 2.7) → conversion adaptée au code actuel
- 9 points **ACTUELS** (2.1, 2.2, 2.3, 2.4, 2.8, 2.9, 2.10, 2.11) → conversion directe

**Total à implémenter** : **13 conversions** sur 15 points d'audit (comptage affiné : 12 si on considère que 1.1 devient une ligne additive, pas une conversion au sens strict). Aligné avec la "12 points convertibles" de la demande utilisateur.

---

## 4. Implications pour le phasage P1-P6

- **P1 (advisory_level partagé)** : couvre 1.1 + 2.5 de l'audit, mais sémantique légèrement différente — c'est un **enrichissement complémentaire** au verdict bayésien existant, pas un remplacement de règles binaires disparues.
- **P2 (risk_score continu)** : remplace 1.4 mais les facteurs sont reconstruits depuis les signaux Phase 3 (pas les conditions originales de l'audit).
- **P3 (fallback tiered)** : filtre strict = `verdict === 'SAFE'` (post-Phase 3), fallback = `verdict ∈ {SAFE, UNKNOWN}` + advisory ≤ yellow.
- **P4 (recommendation tiered)** : utilise `ci95_low/ci95_high` du bayésien (déjà disponible grâce à Phase 3).
- **P5 (lissage empirical/report_signal)** : le lissage empirical disparaît (1.2 obsolète), seul le report_signal (2.1) survit.
- **P6 (warnings gradués)** : 8 points conservés tels quels (2.2, 2.3, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11).

## 5. Hors scope Phase 4 (pas de conversion prévue)

- Constante `EMPIRICAL_THRESHOLD` déjà retirée.
- Constante `VERDICT_SAFE_THRESHOLD` encore présente mais inutilisée → suppression en P1.
- Rate limits (Annexe A §A.1) : contrôles opérationnels, binaires par conception, inchangés.
