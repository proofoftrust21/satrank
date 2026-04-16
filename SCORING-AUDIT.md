# SatRank Scoring Mathematical Audit

_Date: 2026-04-16. Scoring version: v26+ (post Option D probe fix)._
_Dataset: 11,429 scored non-stale agents on production (13,964 total; 2,535 unscored)._

## TL;DR

- **Distribution is heavily right-skewed with a large bimodal spike at score 10-14** (38% of scored agents). This is structural — LN gossip leaves earn a minimum score from seniority/regularity alone.
- **The scoring is robust to weight changes**: every alternative weight vector tested preserves ≥93% of the top-100 and Kendall τ ≥ 0.96.
- **The score predicts routability well** (r = 0.83 vs probe success rate), but **~80% of that predictive power comes from Regularity alone**, which is computed *from* probe data — a self-referential shortcut. The non-regularity part of the score correlates at r = 0.65, which is the honest number.
- **No false positives at the top**: zero agents score ≥47 while failing >50% of probes.
- **"False negatives" (score < 30, probes succeed)** are 645 agents — 93% of them are single-channel leaves. The scoring is correctly flagging single-point-of-failure nodes as risky despite them being technically routable. Feature, not bug.
- **LN+ community ratings contribute almost nothing** (r = 0.25 with Reputation) and cover only 14% of agents. Candidate for deprecation.
- **Current weights are within 1–2 points of optimal** on every defensible metric. No compelling case for a re-balance, but Reputation (30%) could be cut to 25% in favor of Regularity (15→20%) to bring weight closer to observed variance contribution. Gain would be marginal (~0.03 r).

---

## 1. Distribution

### Histogram (bins of 5, N = 11,429 scored agents)

```
   5- 9 |    30 |
  10-14 |  4369 | ██████████████████████████████████████████████████
  15-19 |  1294 | ██████████████
  20-24 |   456 | █████
  25-29 |   783 | ████████
  30-34 |  1281 | ██████████████
  35-39 |   998 | ███████████
  40-44 |   802 | █████████
  45-49 |   503 | █████
  50-54 |   410 | ████
  55-59 |   187 | ██
  60-64 |   136 | █
  65-69 |    66 |
  70-74 |    45 |
  75-79 |    46 |
  80-84 |    23 |
```

| Stat | Value |
|------|-------|
| mean | 25.88 |
| median | 20 |
| stdev | 15.05 |
| p10 / p25 / p50 | 11 / 13 / 20 |
| p75 / p90 / p95 / p99 | 36 / 47 / 53 / 69 |
| min / max | 8 / 83 |

**Shape**: bimodal right-skewed. The 4,369-node spike at 10-14 corresponds to LN-graph leaves with capacity ≈ 0.001 BTC, ≤2 channels, ≤1 unique peer — i.e. nodes that exist in the gossip but have essentially no connectivity. They get a minimum floor from seniority + regularity. A second mode appears around 30-40 (~active but non-hub nodes).

### Verdict-range breakdown (score threshold only — actual verdict also gates on confidence)

| Range | % |
|-------|---|
| RISKY range (< 30) | 60.7% (N = 6,932) |
| UNKNOWN range (30-46) | 28.9% (N = 3,305) |
| SAFE range (≥ 47) | 10.4% (N = 1,192) |

The 60.7% in the RISKY range is driven by those 4,369 leaves. Most of them end up `UNKNOWN` in practice because their confidence is `very_low` (no volume, no attestations) — the verdict engine requires `score < 30 AND confidence ≥ low` for RISKY. So in practice the population splits closer to 10-15% SAFE / 40-50% UNKNOWN / 35-45% RISKY on the verdict endpoint.

---

## 2. Component correlation with final score

All correlations are Pearson's r over 11,429 scored non-stale agents.

| Component | Weight | mean | stdev | r(score) | r² |
|-----------|--------|------|-------|----------|------|
| Volume | 25% | 12.26 | 11.81 | 0.704 | 0.50 |
| Reputation | 30% | 43.91 | 10.73 | 0.831 | 0.69 |
| Seniority | 15% | 16.20 | 21.21 | 0.667 | 0.44 |
| Regularity | 15% | 47.88 | 32.29 | 0.858 | 0.74 |
| Diversity | 15% | 15.23 | 16.14 | 0.874 | 0.76 |

### Observation 1: Reputation has the flattest distribution (stdev 10.7)
Everyone gets ~44 ± 11. It compresses the signal. This is fine: PageRank + peer trust converge toward a median-ish value for the majority. It keeps Reputation from over-separating the population.

### Observation 2: Seniority has the weakest correlation (0.67)
Despite 15% weight. Because seniority is a monotonic function of time and many young-but-active nodes have high other components.

### Observation 3: Diversity has the tightest fit to score (r = 0.874)
Diversity being well-correlated with the total makes sense — multi-channel nodes tend to score high overall.

---

## 3. Variance decomposition

The variance of the final score is dominated by a component in proportion to `w² × var(component)`:

| Component | var | w²·var | % of total variance |
|-----------|-----|--------|---------------------|
| Volume | 139.5 | 8.72 | 14.9% |
| Reputation | 115.1 | 10.36 | 17.7% |
| Seniority | 449.8 | 10.12 | 17.3% |
| **Regularity** | **1042.8** | **23.46** | **40.1%** |
| Diversity | 260.6 | 5.86 | 10.0% |

**Regularity drives 40% of the variance despite only 15% weight** because its stdev (32.3) is 2-3× larger than any other component. A well-operated reliable node earns 80-100 regularity; a flaky one earns <20. The spread is enormous.

This is exactly what a "reliability oracle" should do — reliability IS the biggest score-mover. But be aware that Regularity is computed from probe data, which makes any downstream "score predicts probes" correlation partially self-referential (see §6).

---

## 4. Weight-removal sensitivity (top-100 stability)

Rebuild the score with one component removed, renormalize remaining weights to sum to 1, recompute top-100.

| Removed component | Top-100 overlap | Kendall τ (N=1500 sample) |
|-------------------|-----------------|---------------------------|
| Volume | 89.0% | 0.955 |
| Reputation | 92.0% | 0.927 |
| Seniority | **78.0%** | 0.925 |
| Regularity | 97.0% | 0.907 |
| Diversity | 87.0% | 0.955 |

**Seniority removal shuffles the top-100 the most** (−22 points of overlap). Interpretation: within the high-scoring cohort, seniority differentiates the most — long-lived nodes dominate. Remove it and younger hubs displace older smaller nodes.

**Regularity removal barely changes the top-100** (−3 points). Because top-100 agents are essentially ALL near-perfect on regularity (uptime ≈100%) — it doesn't differentiate among them.

---

## 5. Correlation with real-world quality proxies

### 5a. Probe success rate (7-day window)

| Proxy | N | r | r² |
|-------|---|---|-----|
| Overall probe success rate | 11,390 | **0.864** | 0.746 |
| Tier-1k success rate | 11,390 | 0.864 | 0.746 |

At face value: the score explains ~75% of the variance in probe success. Strong predictive power.

### 5b. **Self-reference caveat** (important)

Regularity is computed from `uptime 70% + latency consistency 20% + hop stability 10%` — all probe-derived. Which means the score is partially **predicting its own input**.

Decomposing:

| Score variant | r vs probe rate |
|---------------|-----------------|
| **Regularity alone** | **0.997** |
| Full score (with regularity) | 0.834 |
| Score **excluding** regularity (renormalized) | 0.649 |

The honest predictive power of the **non-regularity** half of the score for routability is **r = 0.65** — still a meaningful signal (Volume / Reputation / Seniority / Diversity carry ~42% of the variance on their own), but considerably weaker than the headline number suggests.

### 5c. Verdict: scoring predicts routability, but mostly via one tautological channel

Policy reading: the score is an honest, multi-faceted trust signal that *happens to* also predict probe success because one of its inputs is probe uptime. If the question is "does it predict reachability", the answer is "yes, trivially, via Regularity". If the question is "do the OTHER components predict reachability", the answer is "yes, but more weakly (r ≈ 0.65)".

---

## 6. Pathological cases

### 6a. High score + low probe success: **0**
No agent scored ≥ 47 while failing >50% of probes. The top tier is clean.

### 6b. Low score + high probe success: 645

Of these 645 (5.7% of scored population):

| Channels | count | % |
|----------|-------|-----|
| 1 | 598 | 92.7% |
| 2 | 39 | 6.0% |
| 3-5 | 8 | 1.2% |

Average capacity: 0.007 BTC (median 0.004). These are **single-channel leaves** whose sole channel happens to go to a reliable peer, so probes succeed. The score correctly assigns them < 30 because:

- Diversity ≈ 11 (1 peer → minimum score)
- Volume ≈ 6 (1-2 channels → near-minimum)

A trust oracle SHOULD flag single-point-of-failure nodes as risky even if they're currently routable — the channel can close, be drained, or go offline. Classifying these as "not pathological" is the right call.

### 6c. Edge cases (relaxed threshold)
Only **1** agent has score ≥ 40 while probe success < 60%. The false-positive surface at the top is effectively empty.

---

## 7. Weight sensitivity — 5 documented alternatives

Ranking preserved across alternatives (current = baseline):

| Variant | Top-100 overlap | Kendall τ | r(probe rate) |
|---------|-----------------|-----------|---------------|
| **Current (25/30/15/15/15)** | 100.0% | 1.000 | 0.834 |
| Reputation-heavy (15/40/15/15/15) | 94.0% | 0.983 | 0.849 |
| Volume-heavy (40/20/15/15/10) | 94.0% | 0.968 | 0.808 |
| Balanced (20/20/20/20/20) | 93.0% | 0.964 | **0.865** |
| Route-first (30/35/10/10/15) | 93.0% | 0.964 | 0.780 |

Top-100 membership is within ±7 agents of the current ranking regardless of weighting. Kendall τ never drops below 0.96. **The scoring is structurally robust to reasonable weight changes.**

### Grid search — optimal weights for probe correlation

A full 5D grid (step 5%, each weight in [5%, 50%], total = 100%) was run against `r(score, probe rate)`:

| r | vol | rep | sen | reg | div |
|---|-----|-----|-----|-----|-----|
| **0.980** | 5% | 35% | 5% | **50%** | 5% |
| 0.979 | 10% | 30% | 5% | **50%** | 5% |
| 0.978 | 5% | 30% | 5% | **50%** | 10% |
| … | | | | | |
| 0.834 | 25% | 30% | 15% | 15% | 15% | *← current* |
| 0.865 | 20% | 20% | 20% | 20% | 20% | *← balanced* |
| 0.632 | 50% | 5% | 5% | 5% | 35% | *← worst* |

The top of the grid is dominated by **50% Regularity**. Do not interpret this as a recommendation — it's just confirmation that Regularity predicts its own input (probe rate). A real re-weight should use an **external** quality proxy (e.g. reported success rate from `/api/report`), but we have too few reports (~34 tx total in the DB) to drive that today.

---

## 8. Attack cost models

Observed empirical curves (how component scores scale with the game-able quantity):

### Diversity vs unique peers
```
    peers   N    mean div    score impact (×0.15)
    1- 4  6358     13.9           +2.1
    5-19  1297     36.0           +5.4
   20-49   346     55.5           +8.3
   50-99   158     67.8          +10.2
  100-199   66     79.0          +11.9
    200+   32     94.4          +14.2
```

### Volume vs channel count
```
  channels   N    mean vol    score impact (×0.25)
    1- 4   8970     7.8            +2.0
    5-19   1729    20.7            +5.2
   20-49    410    39.1            +9.8
   50-99    172    53.7           +13.4
  100-499   102    73.7           +18.4
    500+    15    91.5           +22.9
```

### Attack 1: Open 50 channels to 50 different peers
- Observed jump: Diversity 14 → 68, Volume 8 → 54 (approx at 50 peers).
- Score delta ≈ (+54 × 0.15) + (+46 × 0.25) ≈ **+19.6 points**.
- **Cost**:
  - ~0.25 BTC of on-chain capital locked for channel funding (50 × 0.005 BTC minimums) ≈ **$15,000 locked** (not spent, recoverable at close).
  - On-chain open fees: 50 × ~2,000 sats ≈ $60.
  - Inbound liquidity (paid LSP or loop-in): ~$150-300.
  - **Net cash burn: ~$200-400; capital at rest: ~$15k for the duration of the attack.**
- **Outcome**: a nobody node (~score 15) reaches ~score 35. **Still not SAFE (< 47).** To reach SAFE with this attack alone, the attacker also needs high Seniority (years of age) and Reputation (PageRank bootstrap). Not buyable in a short timeframe.

### Attack 2: Wash routing
- For LN-source agents, `Volume = log-blend(channels, capacity)`. Routing a transaction does NOT change `channels` or `capacity`. **Wash routing buys zero Volume.**
- For Observer-source agents (rare), volume counts verified txns. Each wash tx requires a real invoice + preimage through Observer Protocol (cryptographic receipt). Fees are trivial but Observer verifies deliverability — faked txns don't pass.
- **Conclusion**: Volume is essentially non-gameable.

### Attack 3: Be reliable (Regularity)
- Cost: ~$10/month VPS for uptime.
- Gain: up to +80 Regularity = +12 score points.
- **This isn't really an "attack" — it's the correct incentive.** Being a reliable node *should* be rewarded; reliability IS the signal. The fact that this is cheap is a feature of the network: everyone can afford to be a reliable node.

### Attack 4: Sybil PageRank
- PageRank rewards INCOMING edges from high-PR nodes.
- A sybil fleet needs real LN channels between sybils AND ideally channels from real hubs to the sybil. The former is self-referential (sybils linking to sybils inflates their PR slowly and detectably). The latter requires real channels = real capital.
- **Cost**: dominated by capital requirements; same order of magnitude as Attack 1, but multiplied by the number of sybils needed to move PageRank meaningfully. For a 10-node sybil ring with meaningful PR, that's 0.5-2 BTC ($30-120k) locked.
- Detection: anti-gaming code already penalizes 3-hop cycles (90-95% score reduction) and mutual attestations (see `scoringService.ts` circular-cluster detection).
- **Verdict**: expensive and detectable.

### Summary table

| Attack | Cost (cash) | Capital locked | Score gain | SAFE achievable? |
|--------|-------------|----------------|-----------|--------------------|
| 50 channels (Attack 1) | ~$300 | ~$15,000 | +19 | No — requires age + PR too |
| Wash routing (Attack 2) | near-zero | 0 | 0 | — |
| Uptime (Attack 3) | ~$10/mo | 0 | +12 | No alone |
| Sybil PageRank (Attack 4) | $30-120k | $30-120k | slow +15-25 | Detectable |

**The most manipulable component** (lowest cost per score point) is Regularity via Attack 3, but since Regularity measures reliability honestly, this isn't an exploit — it's the correct incentive structure.

**The least manipulable component** is Reputation / PageRank, which requires real LN capital and is additionally protected by circular-cluster penalties.

---

## 9. Reputation sub-signals

Reputation combines: PageRank + peer trust (capacity/channel) + routing quality + capacity trend + fee stability. We only have durable data on the first two.

| Sub-signal | Coverage | r vs Reputation |
|------------|----------|-----------------|
| PageRank score | 71.4% of agents | **0.730** |
| Capacity per channel | 72.5% | 0.398 |
| Positive LN+ ratings | 13.9% | 0.252 |
| Negative LN+ ratings | 2.8% | — |

### Findings

1. **PageRank dominates** — r = 0.73 is a huge chunk of Reputation's signal. Solid — PageRank is a mathematically sound centrality measure, very hard to game without real capital.
2. **LN+ ratings are near-noise and poorly covered** — only 14% of scored agents have any rating, and the correlation with our Reputation component is a weak 0.25. The LN+ input contributes very little, both because of low coverage and because its signal is weak.
3. **Peer trust (capacity-per-channel)** is moderately predictive (r = 0.40) and broadly covered (73%). This is a useful, honest signal.

### Recommendation for sub-signal cleanup

- **Deprecate or down-weight LN+ ratings.** The component that absorbs them (via `computeLightningReputation`) could treat them as a tie-breaker rather than a primary signal. Saves an external crawl dependency (LN+ doesn't offer a stable API) without measurable loss of signal.
- **Keep PageRank + peer trust as the backbone** of Reputation; these together likely explain ~85-90% of the Reputation component's variance.
- **Consider instrumenting fee stability and capacity trend as their own signals** in the snapshot JSON — currently we can't measure them from the stored data, which means we can't audit them.

---

## 10. Recommendations

### Primary: current weights are defensible, don't change them reactively

The grid search headline ("50% regularity maximizes r with probe rate") is **self-referential** and should NOT drive a re-weight. The top-100 is stable under every reasonable weight change (Kendall τ ≥ 0.96). Current weights produce a multi-faceted trust score that resists overfitting to any single signal.

### Marginal tuning opportunity: bring weight closer to variance contribution

If we want weights to reflect observed score-moving power:

| Component | Current | Variance share | Proposed |
|-----------|---------|----------------|----------|
| Volume | 25% | 14.9% | 20% |
| Reputation | 30% | 17.7% | 25% |
| Seniority | 15% | 17.3% | 15% |
| Regularity | 15% | 40.1% | 25% |
| Diversity | 15% | 10.0% | 15% |

Rationale: Regularity already drives 40% of variance; aligning weight (25%) with that reality removes the disconnect. Volume and Reputation are relatively flat contributors — a 5% trim each frees budget for Regularity. Expected impact on probe r: +0.02–0.03. Expected top-100 impact: ~5% shuffle.

### Non-recommendation: balanced 20/20/20/20/20

Scores marginally better on the probe proxy (r = 0.87 vs 0.83) but spreads risk equally across components that have different game-ability profiles. Reputation is the best anti-gaming signal (least manipulable); under-weighting it from 30 to 20 makes the score more exploitable without a corresponding quality gain.

### LN+ ratings

Reduce their influence in `computeLightningReputation`. Coverage is 14% and r is 0.25 — the signal is too thin to justify the crawl cost + external dependency. Keep the **negative** ratings (fraud detection — 2.8% coverage but high-value signal) but consider removing the positive-ratings multiplier.

### Measurement recommendation (not a scoring change)

The biggest observability gap today is that the score's real-world predictive power is currently assessed against probe success rate, which is partially circular. Wire a dashboard panel that correlates score against **reported** success rate from `/api/report` once we have N ≥ 200 distinct reports. That number currently sits at 34 — below statistical significance.

### Sub-signal exposure

When persisting `components` JSON in `score_snapshots`, consider including the Reputation sub-signals (`pagerank_contribution`, `peer_trust_contribution`, `routing_quality_contribution`, `capacity_trend_contribution`, `fee_stability_contribution`) so future audits can attribute Reputation's movement to its drivers. Today it's a black box.
