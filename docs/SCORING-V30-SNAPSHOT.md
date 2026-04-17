# Scoring v30 Snapshot — exact production formula

**Date du snapshot** : 2026-04-17
**Schema** : v30
**Git HEAD (main)** : `2a6aa78` (sim #7 polish)
**Portée** : reproduire à l'identique le calcul de score depuis un agent frais, en se basant sur le code actuel — pas sur la documentation existante. Le code fait foi ; les écarts avec les autres docs sont listés en §12.

Toutes les références de ligne pointent vers `src/`.

---

## 1. Architecture globale

Le score est calculé par `ScoringService.computeScore(agentHash)` (`scoringService.ts:109`).

Deux chemins d'exécution disjoints, sélectionnés par `agent.source === 'lightning_graph'` :

| Chemin | Source d'agent | Sub-signaux de Reputation | Composantes utilisées |
|---|---|---|---|
| **Lightning graph** | `source='lightning_graph'` (nœud LN découvert par le crawler LND graph) | Centrality, PeerTrust, RoutingQuality, CapacityTrend, FeeStability | Volume (50/50 channels + capacité BTC), Reputation (5 sub-signaux), Seniority, Regularity (multi-axes probe), Diversity (peers uniques) |
| **Observer** | tout le reste (`observer_protocol`, `manual`, `self_registered`, `402index`, `nostr`, …) | Attestations pondérées + Report Signal | Volume (tx vérifiées), Reputation (attestations), Seniority, Regularity (CV des intervalles tx), Diversity (counterparties uniques) |

Le chemin est fixe par agent : un même hash ne bascule pas d'un chemin à l'autre sans changement de `agents.source`.

---

## 2. Poids composites (`src/config/scoring.ts`)

Ligne 7-23 :

```
WEIGHT_VOLUME      = 0.25
WEIGHT_REPUTATION  = 0.30
WEIGHT_SENIORITY   = 0.15
WEIGHT_REGULARITY  = 0.15
WEIGHT_DIVERSITY   = 0.15
```

Somme = 1.00.

### Renormalisation "no-attestation rep" (Observer uniquement)

`scoringService.ts:146-167` : si chemin Observer ET `components.reputation === 0`, on exclut Reputation et on renormalise les 4 autres poids sur `0.70` :

```
w.volume     = 0.25 / 0.70 ≈ 0.3571
w.seniority  = 0.15 / 0.70 ≈ 0.2143
w.regularity = 0.15 / 0.70 ≈ 0.2143
w.diversity  = 0.15 / 0.70 ≈ 0.2143
```

Ce chemin ne s'applique **pas** aux nœuds LN (leur Reputation a toujours au moins les fallbacks neutres 50 sur RoutingQuality / CapacityTrend / FeeStability, donc Reputation > 0 garanti).

Note : depuis l'audit Sim #10, quand il n'y a pas d'attestations **et** Report Signal ne peut pas s'appliquer, Reputation vaut 50 + rs (pas 0) — cf. §5. La branche "no-attestation rep" du composite ne se déclenche donc que quand `computeReputation` renvoie explicitement 0 (cas résiduel : tous les attesters ont un poids ≥ 0 mais total sum = 0 et rs = -50 → on clamp à 0).

---

## 3. Formule composite (pipeline float parallèle)

`scoringService.ts:151-167` :

```
totalFloat = Σ (component_i × weight_i)
total      = Math.round(totalFloat)
```

`total` (int 0-100) est la valeur publique (contrat API). `totalFine` (float à 2 décimales) sert au tie-break leaderboard et à la persistance (colonne `score REAL`).

Les modifieurs multiplicatifs s'appliquent **après** le weighted-sum, sur les deux pipelines en parallèle (int et float), avec les mêmes coefficients.

---

## 4. Composantes — chemin Observer

### 4.1 Volume (`computeVolume`, scoringService.ts:643-647`)

```
volume = min(100, round(ln(verifiedTxCount + 1) / ln(VOLUME_LOG_BASE) × 100))
VOLUME_LOG_BASE = 1001
```

`verifiedTxCount = txRepo.countVerifiedByAgent(agentHash)`.
Si 0 tx vérifiées → volume = 0.

### 4.2 Reputation (`computeReputationWithBreakdown`, scoringService.ts:657-775`)

Pipeline :

1. Charger jusqu'à `MAX_ATTESTATIONS_PER_AGENT = 1000` attestations du subject (plus récentes d'abord).
2. Exclure les catégories de reports (`successful_transaction`, `failed_transaction`, `unresponsive`) — elles flow vers Report Signal séparément.
3. **Branche "0 attestations générales"** : `score = clamp(50 + rs, 0, 100)` où `rs = computeReportSignal()` ∈ [-10, +10]. Breakdown `mode='attestations'`, `count=0`.
4. Sinon, calcul weighted sum :

   Pour chaque attestation :
   - `weight = 0.5^(age / ATTESTATION_HALF_LIFE)` où `ATTESTATION_HALF_LIFE = 30j = 2_592_000s`.
   - Si `attesterAgeDays < MIN_ATTESTER_AGE_DAYS (7)` → `weight *= YOUNG_ATTESTER_WEIGHT (0.05)`.
   - Sinon : `weight *= (attesterScore / 100) || UNKNOWN_ATTESTER_WEIGHT (0.1)`. `attesterScore` vient du snapshot le plus récent, ou de `agent.avg_score` en fallback.
   - Anti-gaming mutuel (`A↔B`) : `weight *= MUTUAL_ATTESTATION_PENALTY (0.05)` + `effectiveScore = min(effectiveScore, SUSPECT_ATTESTATION_SCORE_CAP = 40)`.
   - Anti-gaming cluster 3-hop (`A→B→C→A`) : mêmes pénalités (`CIRCULAR_CLUSTER_PENALTY = 0.1`, cap 40).
   - Anti-gaming cycle 4-hop (BFS) : mêmes pénalités (0.1 + cap 40), appliquées seulement si pas déjà caught plus haut.

5. `attestationScore = round(weightedSum / totalWeight)`.
6. `finalScore = clamp(attestationScore + rs, 0, 100)`.
7. Si `totalWeight === 0` (tous les attesters neutralisés) : même branche que "0 attestations" (50 + rs).

#### Report Signal (`computeReportSignal`, scoringService.ts:781-793`)

```
stats = attestationRepo.reportSignalStats(agentHash)
  # retourne { total, weightedSuccesses, weightedFailures } sur toutes les reports
  # avec poids vérifié × 2 intégré

if stats.total < REPORT_SIGNAL_MIN_REPORTS (5) → return 0
if weightedSuccesses + weightedFailures == 0     → return 0

successRatio = weightedSuccesses / (weightedSuccesses + weightedFailures)
adjustment   = (successRatio - 0.5) × 2 × REPORT_SIGNAL_CAP (10)
rs           = round(clamp(adjustment, -10, +10))
```

Donc `rs ∈ [-10, +10]` ; seuil d'activation strict à 5 reports.

### 4.3 Seniority (`computeSeniority`, scoringService.ts:795-800`)

```
days  = (now - first_seen) / 86400
score = round(100 × (1 - exp(-days / SENIORITY_HALF_LIFE_DAYS)))
SENIORITY_HALF_LIFE_DAYS = 730
```

⚠ **Discrepancy naming** (cf. §12) : la constante s'appelle `_HALF_LIFE_DAYS` mais la formule est une **approche exponentielle à constante de temps**, pas une demi-vie. À 730j, score = `100 × (1 - e^-1) ≈ 63.2` (une vraie demi-vie donnerait 50).

**Note méthodologique (critique pour communication publique)** : le paramètre `SENIORITY_HALF_LIFE_DAYS` agit comme **constante de temps**. À 730j le score atteint 63.2, pas 50. La **demi-vie réelle** (score = 50) est atteinte à `730 × ln(2) ≈ 506 jours`. Toute documentation externe, livre blanc, ou annonce sur la méthodologie doit citer ces deux chiffres (constante de temps 730j → 63.2 ; demi-vie effective 506j → 50), jamais "demi-vie = 730j".

### 4.4 Regularity (`computeRegularity`, scoringService.ts:802-824`)

Mesure la régularité des intervalles entre transactions :

```
timestamps = txRepo.getTimestampsByAgent(agentHash)  # tri ASC défensif
if len(timestamps) < 3 → return 0

intervals = diff(timestamps)
mean = avg(intervals)
if mean < 1 → return 100  # quasi-simultanés
variance = avg((i - mean)²)
cv = stddev / mean
score = min(100, round(100 × exp(-cv)))
```

### 4.5 Diversity (`computeDiversity`, scoringService.ts:826-831`)

```
count = txRepo.countUniqueCounterparties(agentHash)
if count == 0 → return 0
score = min(100, round(ln(count + 1) / ln(DIVERSITY_LOG_BASE) × 100))
DIVERSITY_LOG_BASE = 51
```

---

## 5. Composantes — chemin Lightning graph

### 5.1 Volume (`computeLightningVolume`, scoringService.ts:325-348`)

Blend 50/50 de deux dimensions (évite le gaming par micro-channels) :

```
LN_VOLUME_CH_REF  = 500     # channels de référence
LN_VOLUME_BTC_REF = 50      # BTC de référence (ACINQ ~38 BTC → 93)
SATS              = 100_000_000

channelScore = min(100, ln(channels + 1) / ln(LN_VOLUME_CH_REF + 1) × 100)
btc          = capacity_sats / SATS
capacityScore = btc > 0 ? min(100, ln(btc + 1) / ln(LN_VOLUME_BTC_REF + 1) × 100) : 0

volume = round(channelScore × 0.5 + capacityScore × 0.5)
```

Si `channels === 0` → volume = 0 (court-circuit ligne 326).

### 5.2 Reputation (`computeLightningReputationBreakdown`, scoringService.ts:434-555`)

Cinq sub-signaux, avec renormalisation dynamique quand des données sont structurellement absentes.

**Poids nominaux** :

```
centrality     = 0.20
peerTrust      = 0.30
routingQuality = 0.20
capacityTrend  = 0.15
feeStability   = 0.15
```

**Sub-signal 1 — Centrality** (0-100)

```
if agent.pagerank_score != null && > 0:
    centrality = round(pagerank_score)  # source='pagerank'
elif hubness_rank > 0 || betweenness_rank > 0:
    centrality = 0
    if hubness_rank > 0:    centrality += 50 × exp(-hubness_rank / 100)
    if betweenness_rank > 0: centrality += 50 × exp(-betweenness_rank / 100)
    centrality = min(100, round(centrality))   # source='lnplus_ranks'
else:
    centrality = 0  # source='none'  →  slot marqué INDISPONIBLE pour renormalisation
```

**Sub-signal 2 — PeerTrust** (0-100)

```
if capacity_sats > 0 AND channels > 0:
    btcPerChannel = capacity_sats / SATS_PER_BTC / channels
    peerTrust = min(100, round(log10(btcPerChannel × 100 + 1) / log10(201) × 100))
    available = true
else:
    peerTrust = 0
    available = false  →  slot INDISPONIBLE pour renormalisation
```

**Sub-signal 3 — CapacityTrend** (`computeCapacityTrend`, scoringService.ts:564-579`) — toujours disponible (fallback neutre 50)

```
if no channelSnapshotRepo: return 50
latest = repo.findLatest(agentHash)
if no latest: return 50
older = repo.findAt(agentHash, now - 7×86400)
if no older || older.capacity_sats == 0: return 50

delta = (latest.capacity_sats - older.capacity_sats) / older.capacity_sats
trend = 100 / (1 + exp(-6 × delta))   # sigmoide centrée 0, pente 6
return round(trend)
# delta=0 → 50, delta=+0.20 → ~77, delta=-0.20 → ~23, delta=+0.50 → ~95
```

**Sub-signal 4 — RoutingQuality** (`computeRoutingQuality`, scoringService.ts:595-617`) — toujours disponible (fallback neutre 50)

```
WINDOW_SEC = 7 × 86400
hopStats = probeRepo.getHopStats(agentHash, WINDOW_SEC)
latStats = probeRepo.getLatencyStats(agentHash, WINDOW_SEC)
if hopStats.count < 3 OR latStats.count < 3: return 50

hopScore     = max(4, round(100 - (hopStats.mean - 1) × 12))    # 1 hop=100, floor 4
latencyScore = max(0, round(100 - latStats.mean / 3))           # 0ms=100, 300ms=0
return round(hopScore × 0.6 + latencyScore × 0.4)
```

**Sub-signal 5 — FeeStability** (`computeFeeStability`, scoringService.ts:625-641`) — toujours disponible (fallback neutre 50)

```
if no feeSnapshotRepo: return 50
agent = agentRepo.findByHash(agentHash)
if no agent.public_key: return 50
{ changes, channels } = feeSnapshotRepo.countFeeChanges(public_key, now - 7×86400)
if channels == 0: return 50
rate = changes / channels
return round(100 / (1 + exp(1.5 × (rate - 2))))
# 0 changes → 100, 1/ch → ~73, 3/ch → ~27, 5+/ch → ~5
```

**Renormalisation dynamique** (scoringService.ts:507-532`)

```
availSum = (centralityAvailable ? 0.20 : 0)
         + (peerTrustAvailable  ? 0.30 : 0)
         + 0.20 + 0.15 + 0.15    # les 3 derniers sont toujours disponibles

weights = {
  centrality     : centralityAvailable ? 0.20 / availSum : 0,
  peerTrust      : peerTrustAvailable  ? 0.30 / availSum : 0,
  routingQuality : 0.20 / availSum,
  capacityTrend  : 0.15 / availSum,
  feeStability   : 0.15 / availSum,
}

score = min(100, round(
  centrality × weights.centrality +
  peerTrust  × weights.peerTrust  +
  routingQuality × weights.routingQuality +
  capacityTrend  × weights.capacityTrend +
  feeStability   × weights.feeStability
))
```

### 5.3 Seniority — identique à §4.3

### 5.4 Regularity (`computeLightningRegularity`, scoringService.ts:350-393`)

Multi-axes (probe-based) si ≥ 3 probes ; sinon fallback gossip-recency.

```
if probeRepo AND totalProbes ≥ 3:
    uptime             = probeRepo.computeUptime(agent, 7×86400) ?? 0      # [0,1]
    latencyStats       = probeRepo.getLatencyStats(agent, 7×86400)
    hopStats           = probeRepo.getHopStats(agent, 7×86400)

    latencyConsistency = 0.5   # neutre si sample < 3
    if latencyStats.count ≥ 3 AND latencyStats.mean > 0:
        cv = latencyStats.stddev / latencyStats.mean
        latencyConsistency = exp(-cv)

    hopStability = 0.5         # neutre si sample < 3
    if hopStats.count ≥ 3:
        hopStability = 1 - min(1, hopStats.stddev / 3)

    score = uptime × 70 + latencyConsistency × 20 + hopStability × 10
    return min(100, round(score))

# fallback
daysSinceUpdate = (now - lastSeen) / 86400
if daysSinceUpdate ≤ 0: return 100
return min(100, round(100 × exp(-daysSinceUpdate / 90)))
```

### 5.5 Diversity (`computeLightningDiversity`, scoringService.ts:395-419`)

```
if unique_peers != null && > 0:
    return min(100, round(ln(unique_peers + 1) / ln(501) × 100))
    # 1→11, 10→38, 50→63, 200→85, 500→100

# fallback capacité
if !capacity_sats || ≤ 0: return 0
btc   = capacity_sats / SATS_PER_BTC
score = (log10(btc × LN_DIVERSITY_BTC_MULTIPLIER + 1) / log10(LN_DIVERSITY_LOG_BASE)) × 100
LN_DIVERSITY_BTC_MULTIPLIER = 10
LN_DIVERSITY_LOG_BASE       = 1001
return min(100, round(score))
```

---

## 6. Modifieurs multiplicatifs (post-composite)

Appliqués dans l'ordre suivant sur `total` (int) et `totalFloat` (float) en parallèle :

### 6.1 Manual-source penalty (`scoringService.ts:176-181`)

Actif uniquement si `agent.source === 'manual'` ET `verifiedTxCount < MANUAL_SOURCE_PENALTY_THRESHOLD (150)`.

```
ratio             = verifiedTxCount / 150
penaltyMultiplier = MANUAL_SOURCE_MIN_MULTIPLIER + (1 - MANUAL_SOURCE_MIN_MULTIPLIER) × ratio
                  = 0.5 + 0.5 × (tx / 150)
total       = round(total × penaltyMultiplier)
```

Ramp linéaire de ×0.5 (0 tx) à ×1.0 (≥ 150 tx).

### 6.2 Verified-tx bonus (`scoringService.ts:184-191`)

```
verifiedForBonus = lightning_graph ? txRepo.countVerifiedByAgent() : verifiedTxCount
if verifiedForBonus > 0:
    verifiedMult = min(1.10, 1.0 + verifiedForBonus × 0.003)
    total        = min(100, round(total × verifiedMult))
```

Plafond à ×1.10 (atteint à ~34 tx vérifiées). Multiplicateur mort-né à `1 × 0.003 = 1.003` pour 1 tx.

### 6.3 LN+ positive ratings — **SUPPRIMÉ** (audit 2026-04-16)

Les constantes `LNPLUS_RANK_MULTIPLIER`, `LNPLUS_RATINGS_WEIGHT`, `LNPLUS_BONUS_CAP`, `NEGATIVE_RATINGS_PENALTY` existent toujours dans `config/scoring.ts` (lignes 92-102) pour préserver `scoringConfig.test.ts`, mais **ne sont plus appliquées** au score. Commentaire ligne 193-199 explicite.

Les ratings négatifs LN+ continuent d'alimenter le flag `negative_reputation` dans `src/utils/flags.ts:22` (`if agent.negative_ratings > agent.positive_ratings`).

### 6.4 Probe-based penalty (`scoringService.ts:227-270`)

Déclenché uniquement si `baseProbe = probeRepo.findLatestAtTier(agent, 1000)` ET `(now - baseProbe.probed_at) < PROBE_FRESHNESS_TTL (86400s = 24h)`.

**Régime 1 — base tier UNREACHABLE** (`baseProbe.reachable === 0`) :

```
gossipAgeSec = now - agent.last_seen
THIRTY_DAYS  = 30 × 86400
SEVEN_DAYS   = 7 × 86400
channels     = agent.total_transactions || 1  # semi-surcharge observer/LN
disabledRatio = disabled_channels > 0 ? disabled_channels / channels : 0

if disabledRatio ≥ 0.8:             probeMult = 0.65    # "dead" — 80%+ canaux disabled
elif gossipAgeSec > THIRTY_DAYS:     probeMult = 0.70    # "dead" — gossip > 30j
elif gossipAgeSec > SEVEN_DAYS OR disabledRatio ≥ 0.3:  probeMult = 0.80  # "zombie"
else:                                probeMult = 0.90    # "liquidity"
total = max(0, round(total × probeMult))
```

**Régime 2 — base tier REACHABLE** (multi-tier liquidity signal) :

```
SEVEN_DAYS_SEC = 7 × 86400
TIER_WEIGHTS = { 1000: 0.4, 10_000: 0.3, 100_000: 0.2 }   # 1M EXCLU (cf. FINDING #14)

rates = probeRepo.computeTierSuccessRates(agent, SEVEN_DAYS_SEC)
weightedSum = 0 ; weightTotal = 0
for (tier, weight) in TIER_WEIGHTS:
    stats = rates.get(tier)
    if stats && stats.total > 0:
        weightedSum += (stats.success / stats.total) × weight
        weightTotal += weight

if weightTotal > 0:
    signal    = weightedSum / weightTotal
    probeMult = max(0.65, signal)
    if probeMult < 1.0:
        total = max(0, round(total × probeMult))
```

Le 1M-sat tier reste **probé** (pour `maxRoutableAmount`) mais **exclu** du signal (sim #10 finding #14 : échouer un 1M est la norme, pas un signal de défiance).

### 6.5 Popularity bonus — **SUPPRIMÉ**

Commentaire ligne 272-274 : `query_count` est gameable (auto-query). Les constantes `POPULARITY_BONUS_CAP`/`POPULARITY_LOG_MULTIPLIER` (lignes 149-152 de config) restent pour compat des tests mais ne sont pas appliquées.

---

## 7. Clamp final & persistence (`scoringService.ts:278-315`)

```
totalFine = round(clamp(totalFloat, 0, 100) × 100) / 100   # 2 décimales, borné [0, 100]
total     = round(totalFine)                                # int final
```

**Snapshot write conditions** (ligne 283-308) :

- `SNAPSHOT_HEARTBEAT_SEC = 86_400` — au moins 1 snapshot/agent/jour.
- Écrit un nouveau snapshot si : `|last.score - totalFine| ≥ 0.01` OU `last.components != componentsJson` OU `(now - last.computed_at) ≥ SNAPSHOT_HEARTBEAT_SEC` OU pas de snapshot précédent.
- Met à jour `agents.avg_score = totalFine` dans la même transaction.

**Cache read** (`getScore`, scoringService.ts:80-103`) :

```
SCORE_CACHE_TTL = 300   # 5 minutes
if snapshot existe ET (now - snapshot.computed_at) < SCORE_CACHE_TTL:
    return snapshot (composants repaarsés)
else:
    computeScore()
```

---

## 8. Confidence level (`deriveConfidence`, scoringService.ts:852-859`)

```
dataPoints = total_transactions + total_attestations_received
if dataPoints < CONFIDENCE_VERY_LOW (5)    → 'very_low'
if dataPoints < CONFIDENCE_LOW (20)        → 'low'
if dataPoints < CONFIDENCE_MEDIUM (100)    → 'medium'
if dataPoints < CONFIDENCE_HIGH (500)      → 'high'
sinon                                      → 'very_high'
```

Map vers nombre (`CONFIDENCE_MAP`, verdictService.ts:22-28`) : 0.10 / 0.25 / 0.50 / 0.75 / 0.90.

---

## 9. Verdict SAFE/UNKNOWN/RISKY (`verdictService.ts:133-155`)

Trois règles évaluées dans l'ordre :

```
hasCriticalFlags = flags.includes('fraud_reported') OR flags.includes('negative_reputation')

hasRiskEvidence = hasCriticalFlags
               OR flags.includes('unreachable')
               OR (delta7d != null && delta7d < -15)
               OR (scoreResult.total < 30 AND confidence ≥ CONFIDENCE_MAP.low = 0.25)

if hasRiskEvidence:
    verdict = 'RISKY'
elif (total ≥ VERDICT_SAFE_THRESHOLD (47) AND !hasCriticalFlags AND confidence ≥ 0.50):
    verdict = 'SAFE'
else:
    verdict = 'UNKNOWN'
```

Cascade stricte : RISKY domine, puis SAFE, sinon UNKNOWN.

### Unreachable flag (verdictService.ts:93-103`)

```
probe = probeRepo.findLatestAtTier(hash, 1000)
if probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL:
    gossipFresh = (now - agent.last_seen) < 86400
    if !gossipFresh OR total < VERDICT_SAFE_THRESHOLD:
        flags.push('unreachable')
```

Si un pathfinding live confirme ensuite la route, le flag est retiré (ligne 128-131).

### Base flags (`src/utils/flags.ts`)

```
if ageDays < 30:              'new_agent'
if total_transactions < 10:   'low_volume'
if delta7d < -10:             'rapid_decline'
if delta7d > 15:              'rapid_rise'
if negative_ratings > positive_ratings:  'negative_reputation'
if query_count > HIGH_DEMAND_THRESHOLD (50): 'high_demand'
if lnplus_rank == 0 && positive_ratings == 0: 'no_reputation_data'
if daysSinceGossip > ZOMBIE_GOSSIP_DAYS (14):  'zombie_gossip'
elif daysSinceGossip > STALE_GOSSIP_DAYS (7):  'stale_gossip'
```

Note : `negative_reputation` est levé par les ratings LN+ qui, bien que plus appliqués au score, restent l'input du flag.

---

## 10. `/api/decide` — composition successRate (`decideService.ts:140-246`)

**Signaux** :

```
pTrust     = sigmoid(scoreResult.total, midpoint=50, steepness=0.1)
pRoutable  = verdictResult.pathfinding.reachable ? 1.0 : 0.0   # 0.5 si pas de pathfinding
pAvailable = probeRepo.computeUptime(agent, 7×86400) ?? 0.5    # uptime 7j
pEmpirical = hasEmpirical ? weightedSuccessRate : pTrust       # cf. gate
pPath      = computePathQuality(pathfinding, amountSats)       # 0-1, cf. §10.1
```

**Gate empirical vs proxy** (ligne 228) :

```
EMPIRICAL_THRESHOLD = 10
{ rate, dataPoints, uniqueReporters } = attestationRepo.weightedSuccessRate(target)
hasEmpirical = (dataPoints ≥ 10) AND (uniqueReporters ≥ 5)
basis        = hasEmpirical ? 'empirical' : 'proxy'
```

**Composite successRate** :

```
if hasEmpirical:
    successRate = pEmpirical × 0.40 + pPath × 0.25 + pAvailable × 0.15
                + pTrust × 0.10 + pRoutable × 0.10
else:
    successRate = pTrust × 0.30 + pPath × 0.30 + pAvailable × 0.20 + pRoutable × 0.20
successRate = clamp(successRate, 0, 1)
```

**GO decision** (ligne 261) :

```
hasCritical = flags.includes('fraud_reported') OR flags.includes('negative_reputation')
serviceDown = serviceHealth?.status === 'down'
go          = (successRate ≥ 0.5) AND !hasCritical AND !serviceDown
```

### 10.1 `computePathQuality` (decideService.ts:44-67`)

```
if no pathfinding:         return 0.5
if !pathfinding.reachable: return 0.0

hops         = pathfinding.hops ?? 1
alternatives = pathfinding.alternatives ?? 1
feeMsat      = pathfinding.estimatedFeeMsat ?? 0

hopPenalty      = max(0.12, 1 - (hops - 1) × 0.08)
altBonus        = min(1, 0.8 + alternatives × 0.1)
feeBudgetMsat   = (amountSats ?? 1000) × 0.01 × 1000   # FEE_BUDGET_RATIO = 1%
feeScore        = feeBudgetMsat > 0 ? (1 - min(1, feeMsat / feeBudgetMsat)) : 1.0

return hopPenalty × 0.5 + altBonus × 0.3 + feeScore × 0.2
```

### 10.2 Re-probe on-demand (decideService.ts:154-204`)

```
REPROBE_STALE_SEC      = 1800   # 30 min (override via env DECIDE_REPROBE_STALE_SEC)
REPROBE_TIMEOUT_MS     = 5000
REPROBE_RATE_LIMIT_SEC = 300    # max 1 reprobe/target/5min

Trigger: (probeAgeSec > REPROBE_STALE_SEC OR amountSats > currentMaxRoutable) AND reprobeAllowed
Tiers testés: [1k, 10k, 100k, 1M] — filtrés à `tier ≤ max(amountSats, 1000) × 2` (+ tier[0] toujours)
Stop sur premier échec (pas d'escalade au-delà)
```

---

## 11. `/api/services/best` — sélection de providers (`serviceController.ts:109-238`)

Pool trié par **uptime** (pas par check_count, audit H5).

Filtre appliqué (ligne 149-155) :

```
pool = candidates.filter(s =>
  s.score ≥ VERDICT_SAFE_THRESHOLD (47) AND
  s.uptimeRatio > 0 AND
  s.price > 0 AND
  s.uptimeRatio ≥ minUptime AND
  s.httpHealth !== 'down'
)
```

Préférence healthy|unknown ; fallback degraded seulement si healthy pool vide.

Trois picks :

```
bestQuality = max(score × uptime)                           # price ignoré
bestValue   = max(score × uptime / sqrt(price))             # sqrt softens price
cheapest    = min(price)
```

Warnings (ligne 189-202) :

```
LOW_UPTIME_THRESHOLD = 0.20   → warning 'LOW_UPTIME'
httpHealth === 'degraded'     → warning 'DEGRADED_HTTP'
STALE_HEALTH_AGE_SEC = 300    → warning 'STALE_HEALTH'
```

---

## 12. Discrepancies avec les autres docs

| # | Doc source | Affirmation | Code actuel | Verdict |
|---|---|---|---|---|
| D1 | `config/scoring.ts:120` docstring | `SENIORITY_HALF_LIFE_DAYS = 730` — "half-life … 730 = 2 years" | Formule `100 × (1 - exp(-days / 730))` est une **constante de temps** (à 730j → 63.2, pas 50). Une vraie demi-vie donnerait 100 × (1 - 0.5^(days/730)). | Naming incorrect, comportement effectif documenté ici. |
| D2 | `SCORING-AUDIT.md` (2026-04-16) | "LN+ community ratings contribute almost nothing … candidate for deprecation" | Effectivement déprécié dans `scoringService.ts:193-199` et `config/scoring.ts:85-90` — le code ne les utilise plus, seul le flag `negative_reputation` les consomme. | Audit pré-deprecation ; la déprécation est effective en prod. |
| D3 | `SCORING-AUDIT.md` §Verdict-range | "verdict engine requires `score < 30 AND confidence ≥ low` for RISKY" | Correct, mais incomplet — le RISKY se déclenche aussi sur `hasCriticalFlags`, `unreachable`, `delta7d < -15` (cf. §9). | Audit partiel ; snapshot §9 fait foi. |
| D4 | `CLAUDE.md` "5 sous-signaux pondérés (somme=100)" | PeerTrust 30, Centrality 20, RoutingQuality 20, CapacityTrend 15, FeeStability 15 | Cohérent — poids nominaux identiques (0.30/0.20/0.20/0.15/0.15). Omission CLAUDE.md : la **renormalisation dynamique** quand centrality/peerTrust sont indisponibles (cf. §5.2 ici). | Complément, pas contradiction. |
| D5 | `CLAUDE.md` "modifiers multiplicatifs: verified-tx ×1.0-1.10, probe penalty ×0.65-0.90" | Correct. Omission : bandes de graduation 0.65/0.70/0.80/0.90 selon `disabledRatio` × `gossipAge` (régime 1), et signal continu borné en régime 2. | Complément. |
| D6 | `config/scoring.ts:156-163` "SAFE = top ~50% of theoretical maximum" | Seuil 47 calibré sur le fait que les meilleurs nœuds réels plafonnent à 93-94. | Cohérent. |
| D7 | `public/methodology.html` | Non inspecté dans ce snapshot — à auditer séparément lors d'une phase de communication publique. | — | TODO post-Phase-0 si publication. |
| D8 | `REPORT-INCENTIVE-DESIGN.md` | Tier 2 `report_bonus_ledger` gated par `REPORT_BONUS_ENABLED=false` — pas d'impact scoring direct. | Flag OFF en prod, code présent. | Cohérent, hors scope scoring. |

---

## 13. Constantes — référence rapide

Toutes proviennent de `src/config/scoring.ts` sauf mention.

```
# Poids
WEIGHT_VOLUME      = 0.25
WEIGHT_REPUTATION  = 0.30
WEIGHT_SENIORITY   = 0.15
WEIGHT_REGULARITY  = 0.15
WEIGHT_DIVERSITY   = 0.15

# Attestations
ATTESTATION_HALF_LIFE        = 30 × 86400   # 2_592_000 s  (vraie demi-vie)
MIN_ATTESTER_AGE_DAYS        = 7
UNKNOWN_ATTESTER_WEIGHT      = 0.1
YOUNG_ATTESTER_WEIGHT        = 0.05
MAX_ATTESTATIONS_PER_AGENT   = 1000

# Anti-gaming
MUTUAL_ATTESTATION_PENALTY    = 0.05
SUSPECT_ATTESTATION_SCORE_CAP = 40
CIRCULAR_CLUSTER_PENALTY      = 0.1
MANUAL_SOURCE_PENALTY_THRESHOLD = 150
MANUAL_SOURCE_MIN_MULTIPLIER    = 0.5

# Bonus tx vérifiées
VERIFIED_TX_BONUS_CAP    = 15    # hérité — plafond effectif vient du clamp min(1.10)
VERIFIED_TX_BONUS_PER_TX = 0.5   # hérité

# Lightning volume (in-file constants dans scoringService)
LN_VOLUME_CH_REF  = 500
LN_VOLUME_BTC_REF = 50
SATS_PER_BTC      = 100_000_000

# LN diversity fallback
LN_DIVERSITY_LOG_BASE      = 1001
LN_DIVERSITY_BTC_MULTIPLIER = 10

# LN+ (déprécié, code-dead mais constantes présentes)
LNPLUS_RANK_MULTIPLIER      = 5
LNPLUS_RATINGS_WEIGHT       = 50
NEGATIVE_RATINGS_PENALTY    = 20
LNPLUS_BONUS_CAP            = 8

# Observer
VOLUME_LOG_BASE               = 1001
DIVERSITY_LOG_BASE            = 51
SENIORITY_HALF_LIFE_DAYS      = 730    # (constante de temps — cf. D1)

# Confidence
CONFIDENCE_VERY_LOW = 5
CONFIDENCE_LOW      = 20
CONFIDENCE_MEDIUM   = 100
CONFIDENCE_HIGH     = 500

# Cache & snapshots
SCORE_CACHE_TTL         = 300       # 5 min
SNAPSHOT_HEARTBEAT_SEC  = 86_400    # 1/jour min (in-file)

# Popularity (déprécié)
POPULARITY_BONUS_CAP     = 10
POPULARITY_LOG_MULTIPLIER = 2

# Verdict
VERDICT_SAFE_THRESHOLD      = 47
VERDICT_UNKNOWN_THRESHOLD   = 30   # serviceController / watchlistController
CONFIDENCE_MAP = { very_low: 0.10, low: 0.25, medium: 0.50, high: 0.75, very_high: 0.90 }

# Probe
PROBE_FRESHNESS_TTL         = 86_400    # 24h
PROBE_UNREACHABLE_PENALTY   = 10        # hérité, non appliqué (remplacé par régimes 1/2)
TIER_WEIGHTS (régime 2)     = { 1000: 0.4, 10_000: 0.3, 100_000: 0.2 }

# Report signal
REPORT_SIGNAL_MIN_REPORTS = 5
REPORT_SIGNAL_CAP         = 10
PREIMAGE_WEIGHT_BONUS     = 2.0   # reportService.ts
BASE_WEIGHT_FLOOR         = 0.3   # reportService.ts
BASE_WEIGHT_MAX           = 1.0   # reportService.ts
REPORTER_SCORE_DIVISOR    = 80    # reportService.ts

# Decide
EMPIRICAL_THRESHOLD       = 10    # decideService.ts
uniqueReporters min       = 5     # decideService.ts:228
FEE_BUDGET_RATIO          = 0.01  # decideService.ts:32
DEFAULT_AMOUNT_SATS       = 1000  # decideService.ts
REPROBE_STALE_SEC         = 1800  # decideService.ts (env override)
REPROBE_TIMEOUT_MS        = 5000
REPROBE_RATE_LIMIT_SEC    = 300

# Services best
LOW_UPTIME_THRESHOLD      = 0.20  # serviceController.ts
STALE_HEALTH_AGE_SEC      = 300   # serviceController.ts

# Methodology change cutoff
METHODOLOGY_CHANGE_AT_UNIX = 1_776_240_000   # 2026-04-16T00:00:00Z
```

Fin du snapshot. Tout `modifier*`, `weight*`, `THRESHOLD*`, `CAP*` présent dans le code et non listé ici est soit un alias, soit une constante non appliquée (déprécation), soit une valeur d'observation — aucune logique de scoring active n'utilise une constante non documentée ci-dessus.
