# Binary → Graduated conversion audit — Phase 0

**Date** : 2026-04-17
**Schema** : v30
**Git HEAD** : `2a6aa78`
**Scope** : inventorier tous les filtres / gates / règles à réponse binaire dans le code actuel, proposer une forme graduée par point, estimer l'impact trafic. Sert de brief d'entrée pour la Phase 4 (warnings gradués) et éclaire la Phase 5 (ordonnancement `/intent`).

Méthodologie : recherche de seuils entiers (`≥`, `<`, `===`, `.includes(…)`) dans les services/contrôleurs qui influencent l'issue observable par un agent (verdict, GO/NO-GO, présence dans un pool de candidats, flag exposé). Les seuils purement internes au scoring (formules continues comme sigmoïdes ou log) ne sont PAS dans ce document — eux sont déjà gradués par construction.

**Légende impact trafic** :
- `Faible` : < 5 % des requêtes potentiellement affectées
- `Moyen`  : 5–20 %
- `Fort`   : > 20 %
- `Inconnu` : pas de télémétrie pour estimer ; à instrumenter en Phase 1

---

## 1. Règles requises par Romain

### 1.1 Seuil SAFE 47

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/verdictService.ts:147` (branche SAFE) ; `src/config/scoring.ts:163` (constante) |
| Règle actuelle | `if (scoreResult.total ≥ 47 && !hasCriticalFlags && confidence ≥ 0.50) verdict = 'SAFE'` |
| Forme graduée proposée | Retourner `advisory_level ∈ {green, yellow, orange, red}` dérivé d'une sigmoïde centrée 47 + facteur confidence + facteur flags, puis `verdict: 'SAFE'\|'RISKY'` devient une projection legacy (green/yellow → SAFE, orange/red → RISKY). Score 44-46 → yellow (warnings mais non-bloquant), 47-55 → green avec `margin_above_threshold`. |
| Impact trafic | **Fort**. Sim #11 a montré 4 refus sur endpoints avec score 40-46 qui étaient en réalité fonctionnels. Estimation : ~15-25 % des requêtes `/decide` tombent actuellement en UNKNOWN uniquement à cause d'un score 40-46. |

### 1.2 P_empirical gate (`decideService.ts:228`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/decideService.ts:17` (constante `EMPIRICAL_THRESHOLD = 10`), `:228` (gate) |
| Règle actuelle | `hasEmpirical = dataPoints ≥ 10 AND uniqueReporters ≥ 5` — sinon `pEmpirical = pTrust` (fallback proxy). Basculement binaire entre deux formules composites distinctes (`basis: 'empirical'` vs `'proxy'`). |
| Forme graduée proposée | Mélange continu : `weight_empirical = sigmoid((dataPoints − 10) / 5) × sigmoid((uniqueReporters − 5) / 2)` ∈ [0, 1]. `successRate = weight_empirical × empirical_formula + (1 − weight_empirical) × proxy_formula`. La transition est lissée au lieu d'être brutale entre 9 et 10 datapoints. |
| Impact trafic | **Moyen**. Pour un agent avec `dataPoints = 9, uniqueReporters = 4`, passer à 10/5 fait sauter `basis` de proxy à empirical et décale potentiellement `successRate` de ±0.15. À 10k reports/mois × 94 services, les endpoints à la frontière oscillent visiblement. |

### 1.3 Candidates = 0 dans `/api/services/best` (`serviceController.ts:149-166`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/controllers/serviceController.ts:149-155` (filtre), `:162-167` (réponse vide) |
| Règle actuelle | `pool = candidates.filter(s → score ≥ 47 AND uptimeRatio > 0 AND price > 0 AND uptimeRatio ≥ minUptime AND httpHealth !== 'down')`. Si `pool.length === 0` → `{ bestQuality: null, bestValue: null, cheapest: null, meta.candidates: 0 }`. |
| Forme graduée proposée | Deux niveaux : (a) **filtre strict** (score ≥ 47 + healthy) comme aujourd'hui ; (b) **fallback tiered** quand strict renvoie 0 : élargir à score ≥ 30 AND httpHealth ≠ down, retourner les 3 picks avec `strictness: 'relaxed'` et `warnings: ['BELOW_SAFE_THRESHOLD']` par entrée. L'agent décide s'il procède ou pas. |
| Impact trafic | **Fort**. Sim #11 : sur 22 catégories × `/api/services/best`, plusieurs répondent `candidates: 0` pour des catégories dont les endpoints existent mais tous en UNKNOWN. La réponse vide force l'agent à fall-back sur `/api/services` qui n'est pas rankée. |

### 1.4 `hasRiskEvidence` — 4 conditions OR dans `verdictService.ts:140-143`

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/verdictService.ts:140-143` |
| Règle actuelle | `hasRiskEvidence = hasCriticalFlags OR flags.includes('unreachable') OR (delta7d != null && delta7d < -15) OR (total < 30 AND confidence ≥ 0.25)`. Un seul `true` déclenche RISKY. |
| Forme graduée proposée | Score de risque continu `risk_score = 0.4 × hasCriticalFlags + 0.25 × unreachableFactor + 0.2 × declineFactor + 0.15 × lowScoreFactor` où chaque facteur est lui-même ∈ [0, 1] (continu). `advisory_level` dérivé des paliers de `risk_score` (ex : > 0.6 → red, 0.35-0.6 → orange, 0.15-0.35 → yellow, < 0.15 → green). |
| Impact trafic | **Moyen**. Le chemin OR actuel transforme une faiblesse modérée (delta -16 sur 7j) en RISKY absolu. Estimation : 8-12 % des verdicts RISKY actuels correspondent à un seul signal marginal. |

---

## 2. Autres règles binaires détectées

### 2.1 `computeReportSignal` — cutoff 5 reports (`scoringService.ts:783`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/scoringService.ts:783`, constante `src/config/scoring.ts:179` (`REPORT_SIGNAL_MIN_REPORTS = 5`) |
| Règle actuelle | `if (stats.total < 5) return 0`. En-dessous de 5 reports, le signal est totalement ignoré ; à 5, il s'active pleinement. |
| Forme graduée proposée | Damping linéaire : `damp = min(1, (total - 1) / 9)` et `rs_damped = rs × damp`. Active dès le 2e report avec un poids réduit ; plein poids à 10. Anti-manipulation préservé (1 seul report = signal nul). |
| Impact trafic | **Faible**. Affecte principalement les endpoints à faible volume de reports (long-tail). Zéro impact sur les nœuds à fort volume. |

### 2.2 Probe unreachable flag (`verdictService.ts:98-103`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/verdictService.ts:98-103` |
| Règle actuelle | `if probe.reachable === 0 AND probeAge < 24h AND (!gossipFresh OR total < 47) → flags.push('unreachable')`. Binaire : flag présent ou absent. |
| Forme graduée proposée | Remplacer par un score `reachability ∈ [0, 1]` issu de `computeUptime(target, 24h)` × `computeUptime(target, 7j)^0.5` — continu. Flag `unreachable` levé seulement si `reachability < 0.1` ; warning `INTERMITTENT` si `0.1 ≤ reachability < 0.5`. |
| Impact trafic | **Moyen**. Un nœud avec 1 probe raté sur les dernières 24h mais un bon uptime 7j est actuellement marqué `unreachable` → RISKY. |

### 2.3 Service health — `'down'` binaire (`decideService.ts:260-261`, `classifyHttp`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/decideService.ts:89-96` (classifier), `:260-261` (gate GO) |
| Règle actuelle | `classifyHttp(status)` → ∈ {healthy, degraded, down}. `serviceDown = status === 'down'` → GO = false immédiat. |
| Forme graduée proposée | Score `http_health_score ∈ [0, 1]` : 2xx/3xx/402 = 1.0, 4xx = 0.5, 5xx = 0.2, timeout/0 = 0.0. `go` utilise ce score comme facteur : `successRate_adjusted = successRate × http_health_score`. Préserve la possibilité d'un GO avec un service dégradé si le reste est excellent. |
| Impact trafic | **Moyen**. Sim #11 finding #5 (endpoint 402 healthy mais 404 après paiement) — le binaire down vs healthy rate ce cas. Gradué + finding #5 (stats endpoint) donne une vue honnête. |

### 2.4 GO cutoff `successRate ≥ 0.5` (`decideService.ts:261`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/decideService.ts:261` |
| Règle actuelle | `go = successRate ≥ 0.5 AND !hasCritical AND !serviceDown`. Seuil dur à 50 %. |
| Forme graduée proposée | Garder le boolean `go` pour SDK 0.2.x, mais exposer `confidence_interval_95` sur `successRate` (issue Phase 3 bayésienne). Ajouter `recommendation ∈ {'proceed', 'proceed_with_caution', 'consider_alternative', 'avoid'}` calibré sur [CI_low, CI_high] — un endpoint avec `successRate = 0.48` mais `CI_low = 0.40, CI_high = 0.95` mérite `proceed_with_caution`, pas un NO-GO net. |
| Impact trafic | **Fort**. Seuil 0.5 est appliqué à 100 % des appels `/decide`. Un déplacement ou un assouplissement graduel change le go-rate global. |

### 2.5 Verdict ternaire score `/api/services` et `/watchlist` (`serviceController.ts:51`, `watchlistController.ts:88-89`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/controllers/serviceController.ts:51`, `src/controllers/watchlistController.ts:88-89` |
| Règle actuelle | `score ≥ 47 ? 'SAFE' : score ≥ 30 ? 'UNKNOWN' : 'RISKY'`. Ternaire dur. |
| Forme graduée proposée | Même `advisory_level` que 1.1 (4 niveaux). Conserve le champ `verdict` (legacy), ajoute `advisory_level`. Cohérence avec l'ajustement 3 de la Phase 3 (exposition parallèle). |
| Impact trafic | **Fort**. Tous les consommateurs du catalogue public voient le verdict changer sur 25-30 % des entrées si le mapping est affiné. |

### 2.6 Reporter weight floor/ceiling (`reportService.ts:74-76`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/reportService.ts:74-76` |
| Règle actuelle | `baseWeight = max(0.3, min(1.0, reporterScore / 80))`. Clamp dur aux deux bouts. |
| Forme graduée proposée | Conserver le clamp (anti-gaming) mais exposer le poids calculé dans la réponse `/api/report` + `/decide.scoreBreakdown` pour que les agents puissent peser leurs propres recommandations de reporters. Pas de changement de formule — le clamp est intentionnel. |
| Impact trafic | **Faible** (cosmétique — pas de changement de comportement). |

### 2.7 Probe régime 1 — bandes d'état (`scoringService.ts:240-243`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/scoringService.ts:240-243` |
| Règle actuelle | 4 paliers discrets selon `disabledRatio` × `gossipAgeSec` : 0.65 / 0.70 / 0.80 / 0.90. Basculement brutal entre bandes. |
| Forme graduée proposée | Formule continue : `probeMult = 0.65 + 0.25 × (1 − severityScore)` où `severityScore = 0.5 × sigmoid(gossipAge, 30j, 10j) + 0.5 × sigmoid(disabledRatio, 0.5, 0.15)`. Transition lisse entre dead/zombie/liquidity. |
| Impact trafic | **Moyen**. Affecte uniquement les nœuds avec probe tier-1k UNREACHABLE (~ 8-12 % des nœuds scorés). |

### 2.8 Warning `LOW_UPTIME` à 0.20 (`serviceController.ts:189`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/controllers/serviceController.ts:189, 197` |
| Règle actuelle | `if (uptimeRatio < 0.20) warnings.push('LOW_UPTIME')`. Seuil dur 20 %. |
| Forme graduée proposée | 3 bandes : `UPTIME_CRITICAL` (< 0.5), `UPTIME_LOW` (0.5-0.8), pas de warning (≥ 0.8). Cohérent avec les bandes d'advisory_level. |
| Impact trafic | **Faible**. Concerne uniquement les warnings cosmétiques dans `/services/best`. |

### 2.9 Stale health 5 min (`serviceController.ts:193`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/controllers/serviceController.ts:193, 201-202` |
| Règle actuelle | `STALE_HEALTH_AGE_SEC = 300` → `stale = ageSec > 300` → `warning: 'STALE_HEALTH'`. Binaire. |
| Forme graduée proposée | Nouveau champ `health_freshness ∈ [0, 1]` = `exp(-ageSec / 600)` (demi-vie 10 min). Warning `STALE_HEALTH` seulement si < 0.1 (équivaut à > ~23 min). Préserve la fraîcheur comme signal continu. |
| Impact trafic | **Faible**. Cosmétique. |

### 2.10 Base flags — tous binaires (`flags.ts:18-29`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/utils/flags.ts:18-29` |
| Règle actuelle | 9 flags tous à seuil dur : `new_agent` (<30j), `low_volume` (<10 tx), `rapid_decline` (delta7d <-10), `rapid_rise` (>15), `negative_reputation` (neg>pos), `high_demand` (>50 queries), `no_reputation_data`, `stale_gossip` (>7j), `zombie_gossip` (>14j). |
| Forme graduée proposée | Garder les flags booléens (breaking change sinon) ; ajouter `flag_confidence: Record<flag, number ∈ [0,1]>` indiquant la force du signal. Ex : `new_agent` actif à 29j → confidence 0.03, à 1j → 1.0. L'agent peut ignorer les flags faibles. |
| Impact trafic | **Faible à moyen**. Additif (aucun flag retiré), peut être consommé ou ignoré. |

### 2.11 Risk profiles — 6 matchers (`riskService.ts:15-63`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/riskService.ts:15-63` |
| Règle actuelle | 6 profiles évalués séquentiellement, premier match gagne. Chaque match combine 2-3 seuils durs (`ageDays < 60 AND delta7d > 20`, etc.). |
| Forme graduée proposée | Retourner un **vecteur de scores** `{ profile_name: match_strength ∈ [0, 1] }` au lieu du premier-match-wins. Le profile "établi" peut être à 0.8 ET "growing" à 0.3 simultanément — reflète plus fidèlement la réalité. Le champ `name` legacy = argmax. |
| Impact trafic | **Moyen**. Affecte les consommateurs UI/dashboard qui s'appuient sur le profil unique. SDK 0.2.x lit encore `name` ; les clients modernes peuvent s'appuyer sur le vecteur. |

---

## 3. Synthèse par impact

| Impact | Count | Points |
|---|---|---|
| **Fort** | 4 | 1.1 (SAFE 47), 1.3 (candidates=0), 2.4 (GO cutoff 0.5), 2.5 (verdict ternaire `/services`) |
| **Moyen** | 6 | 1.2 (empirical gate), 1.4 (hasRiskEvidence), 2.2 (unreachable flag), 2.3 (service down), 2.7 (probe bandes), 2.11 (risk profiles) |
| **Faible** | 5 | 2.1 (report signal < 5), 2.6 (reporter weight clamp, cosmétique), 2.8 (LOW_UPTIME), 2.9 (STALE_HEALTH), 2.10 (flags confidence) |

Total : **15 points convertibles** + **1 contrôle opérationnel référencé pour complétude** (Annexe A, cf. §A.1).

---

## 4. Priorisation pour Phase 4

Ordre d'implémentation suggéré, basé sur impact trafic × complexité d'implémentation :

1. **P1 (Phase 4 cœur)** : 1.1 + 2.5 — dérivation `advisory_level` 4-niveaux partagée entre `/verdict`, `/decide`, `/services`, `/watchlist`. Une source de vérité.
2. **P2** : 1.4 — refactor `hasRiskEvidence` en `risk_score` continu. Alimente `advisory_level` P1.
3. **P3** : 1.3 — fallback tiered pour `/api/services/best` quand pool strict vide. Débloque le finding sim #11.
4. **P4** : 2.4 — `recommendation` tiered dans `/decide`. Nécessite la couche bayésienne (Phase 3) pour `CI`.
5. **P5** : 1.2 + 2.1 — lissage des gates empirical/report_signal. Améliore la stabilité aux bords.
6. **P6** : 2.2, 2.3, 2.7, 2.8, 2.9, 2.10, 2.11 — warnings gradués et champs additionnels. Non-bloquant pour les consommateurs.

**Couverture** : P1 à P4 couvrent les 4 points à impact Fort (1.1, 1.3, 2.4, 2.5) plus 1 prérequis Moyen (1.4 en P2). P5 et P6 couvrent 9 points à impact Moyen/Faible. Le point 2.6 (reporter weight, exposition cosmétique additive) reste hors prioritisation faute d'impact comportemental.

---

## 5. Ce qui N'EST PAS dans cet audit

- **Seuils de sécurité/rate-limit** (Annexe A §A.1) : contrôle opérationnel, restent durs, c'est intentionnel.
- **Formules internes continues** (sigmoïdes, log, exponentielles) : déjà graduées par construction, pas de conversion nécessaire.
- **Seuils cryptographiques** (sha256 match, timing-safe compare) : binaires par nature.
- **Migrations SQL** / changements de schéma : hors scope Phase 0.
- **Tests** : l'introduction de gradation nécessitera d'ajouter des cas limites aux tests existants, mais cette liste ne modifie aucun test.

---

## Annexe A — Contrôles opérationnels référencés pour complétude

Ces règles sont détectées par la méthodologie d'audit (seuils durs dans les services) mais **ne sont pas** des candidats à conversion graduée : ce sont des contrôles de sécurité / anti-abus, volontairement binaires. Listés ici uniquement pour traçabilité.

### A.1 Rate limits (`reportService.ts:105-110`)

| Champ | Valeur |
|---|---|
| Fichier:ligne | `src/services/reportService.ts:105-110` |
| Règle actuelle | 20 reports/min/reporter + 1 report/(reporter,target)/heure. Rejet dur. |
| Statut | **Hors scope conversion graduée** — contrôle opérationnel (anti-abus), pas une règle de scoring. Le binaire est volontaire. |
| Impact trafic | — (non applicable) |

---

Fin de l'audit. 15 points convertibles identifiés + 1 contrôle opérationnel en Annexe A, priorisation P1-P6 posée.
