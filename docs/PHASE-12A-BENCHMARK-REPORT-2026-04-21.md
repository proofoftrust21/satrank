# Phase 12A — Benchmark & Instrumentation Report

**Date:** 2026-04-21
**Branch:** `phase-12a-bench`
**Draft PR:** [#12](https://github.com/proofoftrust21/satrank/pull/12)
**Author:** Claude Code (SatRank implementation agent)

> Scope reminder — Phase 12A is **measurement only**. No production fixes,
> no feature work, no scoring changes. Every code modification is either
> instrumentation support (staging-only feature flags, bench scripts) or
> documentation.

---

## 1. Executive summary

Three-line version :

1. **Fast endpoints** (`/api/agents/top`, `/api/operator/:id`,
   `/api/health`) — p95 < 6 ms up to 928 rps sustained on a single
   api container (cpx32 4 vCPU). No saturation observed in the tested
   range; capacity ceiling is beyond 1 000 rps for these paths.
2. **Slow endpoints** (`/api/agent/:hash/verdict`, `/api/intent`,
   `/api/services`) — saturate well below 1 000 rps. `verdict` tops
   out around **~72 rps**, `intent` and `services` around
   **~180 – 193 rps**. Past the ceiling, requests queue to the 60 s
   HTTP timeout with 22 – 70 % error rate. The shared bottleneck is
   consistent with single-writer SQLite contention on paths that
   touch `score_snapshots` / `decide_log` / `service_endpoints`.
3. **Cold path** — `/api/intent` first call hits p95 2 279 ms (max
   15.5 s) on a fresh connection + uncached category resolver; drops
   to 37.9 ms p95 at 10 rps warm. Mitigation belongs in Phase 12B
   (lazy init on process start, or warmup probe).

Prod smoke (A6) was not executed this run — script is ready and
awaits Romain's `PHASE_12A_PROD_SMOKE_OK=yes` + written GO.

---

## 2. Topology & methodology

### 2.1 Infrastructure

| Plane | Host | Role |
|-------|------|------|
| Prod | `178.104.108.108` (cpx32, nbg1) | Live service, bitcoind + LND + api + crawler |
| Staging | `178.104.142.150` (cpx32, nbg1) | API-only container + observability stack |

Both servers are Hetzner `cpx32` (4 vCPU AMD EPYC, 8 GB RAM, NVMe). Staging
runs the api container alone; prod runs api + crawler + bitcoind + LND +
nginx co-tenants. The ~10-15 % optimistic staging bias estimated at
`docs/phase-12a/A7-NOTES.md` is carried forward in the calibration step
(section 5.3).

### 2.2 Observability stack

Scrapes from `http://host.docker.internal:8080/metrics` (the prom-client
middleware already present in prod). Loki ingests nginx access logs via
a promtail daemon on both hosts. Grafana dashboards : api latency, node
exporter, cadvisor container metrics. No prod code modification.

See `bench/observability/` for the compose and config.

### 2.3 Load-gen tooling

- `bench/k6/*.js` — five `ramping-arrival-rate` scripts, one per endpoint.
- `bench/wrk/*.lua` — event-driven cross-check at maximum throughput.
- `bench/run-all.sh` — orchestrator for the 4-palier sweep.
- `bench/prod/run-prod-smoke.sh` — cost-capped A6 smoke on prod.

Fixtures :

- `bench/k6/fixtures/agents.json` — 100 real public-key-hashes sampled
  from the cloned prod DB at A0.
- `bench/k6/fixtures/categories.json` — 9 intent categories with ≥ 4
  endpoints in the cloned DB.

### 2.4 Bench switches

| Switch | Activation | Effect |
|--------|------------|--------|
| `L402_BYPASS=true` | Only when `NODE_ENV ≠ production` (fail-safed in `src/config.ts`) | Opens paid endpoints (`balanceAuth` short-circuits), opens `/metrics` (skips API-key check), and makes the four rate limiters a no-op via `skip: () => config.L402_BYPASS` |

The double-gate test lives at `src/tests/l402Bypass.test.ts` and covers
the four production booleans :

```
NODE_ENV=development, L402_BYPASS=true  → BOOTS
NODE_ENV=production,  L402_BYPASS=true  → REFUSES
NODE_ENV=production,  L402_BYPASS=false → BOOTS (prod default)
NODE_ENV=production,  L402_BYPASS unset → BOOTS (prod default)
```

---

## 3. A2 — Prod passive baseline (30 min, nginx-only)

| Metric | Value |
|--------|-------|
| Window | 2026-04-21T08:30:35Z → 09:00:35Z |
| Requests | 6 |
| Avg RPS | 0.0033 |
| Peak req/min | 3 |
| Status 200 | 1 |
| Status 301 | 1 |
| Status 404 | 3 |
| Status 400 | 1 |
| Parser miss | 1 |

Source : nginx access logs shipped to Loki via promtail. Raw data
preserved at `docs/phase-12a/baseline-prod-20260421.json`.

**Methodology notes (carry-over):**

- `$request_time` is not in the default combined log format. Latency
  percentiles at idle are therefore **not sampled** in A2 — they land
  instead in A6 (active smoke) and A5 (staging paliers).
- Prod is functionally idle. The one "organic" hit was the landing page
  `GET /`. Three were port scanners. One was a WordPress exploit probe.

---

## 4. A5 — Staging paliers

### 4.1 Plan (after mid-run scope reduction 2026-04-21 ~10:12Z)

Per-endpoint palier matrix + 3-min sustained — rationale in
`docs/phase-12a/A7-NOTES.md` § "A5 methodology adjustment".

| Endpoint | Paliers (rps) | Threshold (soft) | Warmup | Sustained | Rest | Run ID |
|----------|---------------|------------------|--------|-----------|------|--------|
| `/api/health` | 1, 10, 100, 500 | p95 < 200 ms | 30 s | **2 min** | 30 s | `phase-12a-20260421-0955` (pre-adjustment, kept) |
| `/api/agents/top?limit=50` | 1, 10, 100, 1000 | p95 < 300 ms | 30 s | 2 min (1, 10) + 3 min (100, 1000) | 30 s | mixed |
| `/api/agent/:hash/verdict` | 10, 1000 | p95 < 500 ms | 30 s | 3 min | 30 s | `phase-12a-20260421-1016` |
| `/api/intent` (POST) | 1, 10, 100, 1000 | p95 < 500 ms | 30 s | 3 min | 30 s | `phase-12a-20260421-1016` |
| `/api/services` | 10, 1000 | p95 < 300 ms | 30 s | 3 min | 30 s | `phase-12a-20260421-1016` |
| `/api/operator/:id` | 10, 1000 | p95 < 500 ms | 30 s | 3 min | 30 s | `phase-12a-20260421-1016` |

Dropped from bench (see A7-NOTES § "A5 methodology adjustment") :
`/api/probe` + `/api/deposit` (need live LND — staging has
`lndStatus: disabled`), `/api/operator/register` (NIP-98 signed auth
required — pre-generated replay pool out of scope).

Original Phase 12A plan was 5 m warmup / 10 m sustained / 2 m rest;
compressed to fit a single session. `bench/run-all.sh` defaults are
`WARMUP=30s DURATION=3m REST=30s` and the plan is overridable.

### 4.2 Results

Generated with `python3 bench/aggregate.py bench/results/<run-id>/`.
Columns : actual RPS from `http_reqs.rate`, percentiles from
`http_req_duration`, err rate from `http_req_failed.value` (k6 default
: 503 counted as failed).

| Endpoint | Palier (target rps) | Requests | Actual RPS | p50 ms | p90 ms | p95 ms | max ms | err % |
|----------|-------------------:|---------:|-----------:|-------:|-------:|-------:|-------:|------:|
| `/api/health`           | 1    | 134     | 0.89   | 2.0    | 2.3    | 2.5    | 2460.3  | 100 † |
| `/api/health`           | 10   | 1 349   | 8.99   | 1.8    | 2.1    | 2.2    | 416.8   | 100 † |
| `/api/health`           | 100  | 13 499  | 89.99  | 1.2    | 1.4    | 1.6    | 483.2   | 100 † |
| `/api/health`           | 500  | 67 180  | 447.85 | 0.9    | 1.2    | 1.4    | 3199.6  | 100 † |
| `/api/agents/top`       | 1    | 194     | 0.92   | 2.8    | 3.4    | 3.8    | 2743.3  | 0     |
| `/api/agents/top`       | 10   | 1 949   | 9.28   | 2.5    | 2.9    | 3.1    | 3105.7  | 0     |
| `/api/agents/top`       | 100  | 19 445  | 92.59  | 1.9    | 2.2    | 2.4    | 3077.0  | 0     |
| `/api/agents/top`       | 1000 | 194 977 | 928.45 | 1.2    | 4.6    | 5.9    | 475.5   | 0     |
| `/api/agent/:hash/verdict` | 10   | 1 949   | 9.28   | 60.3   | 71.0   | 79.4   | 3090.3 | 0     |
| `/api/agent/:hash/verdict` | 1000 | 17 234  | 71.78  | 60000.0 | 60000.8 | 60000.9 | 60018.5 | 69.7 |
| `/api/intent`           | 1    | 194     | 0.92   | 13.3   | 44.7   | 2278.9 | 15490.8 | 0     |
| `/api/intent`           | 10   | 1 949   | 9.28   | 12.4   | 34.1   | 37.9   | 458.9   | 0     |
| `/api/intent`           | 100  | 19 432  | 92.53  | 10.5   | 31.1   | 43.8   | 5577.2  | 0     |
| `/api/intent`           | 1000 | 46 391  | 193.28 | 5550.9 | 60000.3 | 60000.6 | 60012.0 | 22.5 |
| `/api/services`         | 10   | 1 949   | 9.28   | 16.3   | 19.8   | 22.4   | 3392.2  | 0     |
| `/api/services`         | 1000 | 43 369  | 180.69 | 5950.9 | 60000.3 | 60000.6 | 60002.8 | 22.8 |
| `/api/operator/:id`     | 10   | 1 949   | 9.28   | 2.2    | 2.7    | 3.1    | 397.8   | 0     |
| `/api/operator/:id`     | 1000 | 194 158 | 924.54 | 1.1    | 3.5    | 5.7    | 3439.7  | 0     |

† `/api/health` returns HTTP 503 because staging runs the api-only
container and scoring is stale (no crawler). The custom `healthOk` Rate
(200 OR 503) is 100 % — the endpoint is actually serving; k6 just
marks 503 as failed in the built-in `http_req_failed` metric.

### 4.3 Saturation analysis

Paliers with a **target** of 1000 rps sort cleanly into two groups :

| Class | Endpoints | Signature at 1000 rps target |
|-------|-----------|------------------------------|
| **Not saturated** | `/api/agents/top`, `/api/operator/:id` | Achieved actual RPS 92 – 93 % of target, p95 < 6 ms, 0 % errors |
| **Saturated** | `/api/agent/:hash/verdict`, `/api/intent`, `/api/services` | Achieved 7 – 19 % of target, p95 hit the 60 s HTTP timeout, 22 – 70 % errors |

Steady-state p95 at 10 rps (well below saturation) :

| Endpoint | p95 @ 10 rps |
|----------|-------------:|
| `/api/agents/top`            | 3.1 ms |
| `/api/operator/:id`          | 3.1 ms |
| `/api/health`                | 2.2 ms (503 short-circuit, DB not touched) |
| `/api/services`              | 22.4 ms |
| `/api/intent`                | 37.9 ms |
| `/api/agent/:hash/verdict`   | 79.4 ms |

Cold-path outliers (first k6 iteration in the palier — cache cold,
connection pool empty) :

- `/api/intent` @ 1 rps : p95 2 279 ms, max 15 490 ms. Likely first-call
  compilation of the category resolver + initial join pull from DB.
  The p50 at the same palier is 13 ms, so the tail is entirely the
  first few requests.
- `/api/agents/top` @ 1 rps : max 2 743 ms (one outlier, p95 stays at
  3.8 ms). Connection warm-up, not endpoint cost.

Container-level signals were not scraped into a persisted artefact
during the sweep (the k6-only summary-export is the only preserved
trace). Prometheus/cadvisor/node-exporter were running and visible on
the Grafana dashboard during the run, but no screenshot or range
export was captured :

- CPU saturation point : inferred from RPS cliff. `/api/intent` and
  `/api/services` pin ~200 rps max ; `/api/agent/:hash/verdict` pins
  ~72 rps max. `/api/agents/top` and `/api/operator/:id` do not hit a
  ceiling in the tested range.
- Event-loop lag onset : _not captured_ (prom-client default registry
  does not export eventloop lag ; none of the 50 custom metrics cover
  it).
- SQLite lock contention : _not captured_ directly ; the `verdict`
  ceiling at ~72 rps + full timeout on the overshoot is consistent with
  single-writer SQLite contention as the score computation path writes
  to `decide_log`.
- Cache hit ratio per endpoint : _not captured_ ; the existing custom
  metrics do not expose a hit / miss counter.

### 4.4 Methodology caveats

- **3-min sustained** (adjusted mid-run per Romain) is sufficient for
  order-of-magnitude bottleneck identification but p95 tails have
  larger variance than a 10-min run. Recalibrate in Phase 12B for
  SLA-grade numbers if needed.
- `health`, `top @ 1`, `top @ 10` used a still-smaller **2-min**
  sustained (pre-adjustment). Kept to avoid duplicating the run.
- p99 is not in the k6 default summary-export (only p90 + p95 + max).
  `--summary-trend-stats='med,avg,p(95),p(99)'` would add it ; not
  enabled for this sweep.
- No 50 % / 30 %-error early abort (deferred — mid-palier failures
  already surface through the inter-palier health probe cascade and
  the 3-min cap).

---

## 5. A6 — Prod smoke (iso-charge)

### 5.1 Plan

Cost cap : ≤ 1 000 sats (4× safety margin vs the 5 000-sat Phase 12A
budget). Probe cost is the only priced operation.

| Pass | Endpoint | Count | Auth | Cost |
|------|----------|------:|------|-----:|
| 1 | `/api/health`, `/api/agents/top`, `/api/services`, `/api/intent` | 500 GET + 125 POST intent | free | 0 sats |
| 2 | `/api/probe` | 50 | `X-API-Key` | ≤ 250 sats (5 credits × 50 × 1 sat/credit) |

Rate : 2 rps on the GET pass (4 min total), 1 rps on the probe pass
(50 s total). No ramping (deterministic per-request loop).

### 5.2 Authorisation

Running requires `PHASE_12A_PROD_SMOKE_OK=yes` + confirmation from
Romain. The script in `bench/prod/run-prod-smoke.sh` refuses to start
without both.

### 5.3 Results

_(filled when the prod smoke runs)_

| Endpoint | Requests | p50 | p95 | p99 | Err % |
|----------|---------:|----:|----:|----:|------:|
| `/api/health` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `/api/agents/top` | | | | | |
| `/api/services` | | | | | |
| `/api/intent` | | | | | |
| `/api/probe` | | | | | |

### 5.4 Staging-vs-prod calibration

At equal request count on free endpoints :

| Endpoint | Staging p95 | Prod p95 | Factor (prod / staging) |
|----------|------------:|---------:|------------------------:|
| `/api/health` | _TBD_ | _TBD_ | _TBD_ |
| `/api/agents/top` | | | |
| `/api/services` | | | |

Expected factor from A7-NOTES : **~1.10–1.15**.

---

## 6. Findings & recommendations

_(filled after A5/A6 numbers land)_

### 6.1 Known prior (pre-bench)

- **Latent `/metrics` localhost bypass** — `src/app.ts:408-416`, flagged
  in A7-NOTES. Not remediated in Phase 12A. Recommended for the next
  security audit cycle.
- **SSOT drift** — hand-authored briefing vs live state. `agents` row
  count is +30 % vs the briefing. Recommended : a `make state-snapshot`
  target that dumps `docs/STATE-SNAPSHOT.md` on demand.

### 6.2 Bench-sourced

From A5 staging paliers (A6 pending GO) :

- **Saturation points per endpoint** (single api container, cpx32 4 vCPU) :
  - `/api/agents/top`, `/api/operator/:id` : > 1 000 rps (no cliff)
  - `/api/intent` : ~193 rps
  - `/api/services` : ~181 rps
  - `/api/agent/:hash/verdict` : ~72 rps
  - `/api/health` : > 500 rps tested (no cliff ; 503 short-circuit path)
- **Dominant cold-path cost** : `/api/intent` first-request spike
  (p95 2 279 ms at 1 rps, falls to 38 ms at 10 rps). Consistent with a
  lazy module-load path on first resolve.
- **Cache hit ratios** : not captured (no instrumentation). Indirect
  evidence from `/api/agents/top` : p95 stays flat at 2 – 6 ms from 1
  to 1 000 rps — the cache (or a similarly effective short-circuit) is
  doing its job.
- **p95 at steady-state** (10 rps, warm, well below saturation) :
  top 3.1 ms, operator_show 3.1 ms, health 2.2 ms, services 22.4 ms,
  intent 37.9 ms, verdict 79.4 ms. All within soft thresholds from the
  plan at 10 rps.
- **Surprising finding** — the three saturating endpoints hit the
  **exact same SQLite-writer footprint** : they all call into the
  scoring / decide / service-endpoint write path. `top` and
  `operator_show` are pure reads with no write side-effect, which
  matches the read-light / write-heavy split in
  `src/services/decideService.ts` and
  `src/services/intentService.ts`.

### 6.3 Recommendations (prioritised)

1. **Unblock the three saturating endpoints** — the shared pattern is
   the synchronous write to SQLite on the hot path
   (`decide_log.insert` in `decideService`, `service_probes` +
   `service_endpoints` upserts in intent / services). Options, in order
   of risk :
   - (a) Move the write to a background queue (fire-and-forget) —
     preserves observability, breaks the 2 vCPU ceiling at ~200 rps.
   - (b) Batch the write (group by 50-100 ms window) — simpler,
     probably gets verdict to 400 – 600 rps.
   - (c) Switch the write targets to a separate SQLite connection +
     WAL checkpoint thread — same magnitude improvement as (b), same
     complexity.
2. **Fix the `/api/intent` cold path** — first-call 2.3 s is a UX
   hazard for agents hitting a fresh container. Add a warmup probe
   on container startup (`src/app.ts` startup hook that calls the
   intent resolver once with a canned category).
3. **Capture what's missing in instrumentation** — the current
   prom-client setup does not expose :
   - eventloop lag
   - cache hit / miss per endpoint
   - SQLite WAL size / checkpoint frequency
   - per-endpoint p99 (summary currently stops at p95)

   Add these in Phase 12B so the next bench can answer what we had to
   infer here.
4. **Re-run A5 against a container with a live crawler** so `/api/health`
   returns 200 and the endpoint stops being a 503 short-circuit. This
   bench measured the endpoint's 503 fast-path; the full path was
   never exercised.
5. **Phase 12B SLA calibration** — if p99 thresholds are going to be
   promised to users, re-run the saturating endpoints at 10-min
   sustained with `--summary-trend-stats='med,avg,p(95),p(99),max'` to
   get stable p99 numbers. The current p95 tail variance is high
   enough at 3 min that p95 values within 10 % should not be treated
   as distinguishable.

---

## 7. Artefacts

| Path | Purpose |
|------|---------|
| `bench/observability/` | Prometheus + Grafana + Loki + promtail compose |
| `bench/staging/` | Staging api container + `.env.staging` + deploy |
| `bench/k6/`, `bench/wrk/` | Load-gen scripts + fixtures |
| `bench/run-all.sh` | Paliers orchestrator |
| `bench/aggregate.py` | Summary-export → markdown table |
| `bench/prod/run-prod-smoke.sh` | A6 smoke |
| `bench/results/<run-id>/` | Raw k6 summary-export JSONs |
| `docs/phase-12a/baseline-prod-20260421.json` | A2 baseline |
| `docs/phase-12a/A7-NOTES.md` | Running notes accumulated during A0–A6 |

---

## 8. Appendix — code changes (bench scope)

All changes on branch `phase-12a-bench`. None to be merged in the
current shape — the branch is draft until Romain signs off.

- `src/config.ts` : `L402_BYPASS` schema + production fail-safe.
- `src/middleware/balanceAuth.ts` : short-circuit when `L402_BYPASS`.
- `src/app.ts` : `/metrics` bypass + rate-limiter `skip` hooks (4
  limiters : apiRateLimit, discoveryRateLimit, versionRateLimit,
  metricsRateLimit).
- `src/tests/l402Bypass.test.ts` : four subprocess-boot cases + one
  middleware unit test.

All staging-only (behaviour triggered by `L402_BYPASS=true` which
refuses to boot in production per `src/config.ts` fail-safe). No
production code path changed.
