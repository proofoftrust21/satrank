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

*(filled in at the end)*

Three-line version :

1. **Cold path p95 ceiling:** _TBD ms on staging, _TBD ms on prod
2. **Cache-warm p95 ceiling:** _TBD ms on staging
3. **Saturation point (single api container, cpx32 2 vCPU):** _TBD rps
   before p95 degrades beyond the threshold

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

### 4.1 Plan

| Endpoint | Paliers (rps) | Threshold (soft) | Warmup | Sustained | Rest |
|----------|---------------|------------------|--------|-----------|------|
| `/api/health` | 1, 10, 100, 500 | p95 < 200 ms | 30 s | 2 min | 30 s |
| `/api/agents/top?limit=50` | 1, 10, 100, 500 | p95 < 300 ms | 30 s | 2 min | 30 s |
| `/api/agent/:hash/verdict` | 1, 10, 100, 500 | p95 < 500 ms | 30 s | 2 min | 30 s |
| `/api/intent` (POST) | 1, 10, 100, 500 | p95 < 500 ms | 30 s | 2 min | 30 s |
| `/api/services` | 1, 10, 100, 500 | p95 < 300 ms | 30 s | 2 min | 30 s |

Compressed vs the original Phase 12A plan (5 m warmup / 10 m sustained /
2 m rest per palier) to fit a single session. Full-duration sweep is
available via `bench/run-all.sh` with defaults.

### 4.2 Results

_(filled from `bench/results/<run-id>/` with `bench/aggregate.py`)_

| Endpoint | Palier | Requests | Actual RPS | p50 | p95 | p99 | Err % |
|----------|--------|----------|-----------:|----:|----:|----:|------:|
| health | 1 | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| health | 10 | | | | | | |
| health | 100 | | | | | | |
| health | 500 | | | | | | |
| top | 1 | | | | | | |
| top | 10 | | | | | | |
| top | 100 | | | | | | |
| top | 500 | | | | | | |
| verdict | 1 | | | | | | |
| verdict | 10 | | | | | | |
| verdict | 100 | | | | | | |
| verdict | 500 | | | | | | |
| intent | 1 | | | | | | |
| intent | 10 | | | | | | |
| intent | 100 | | | | | | |
| intent | 500 | | | | | | |
| services | 1 | | | | | | |
| services | 10 | | | | | | |
| services | 100 | | | | | | |
| services | 500 | | | | | | |

### 4.3 Saturation signals

_(from the Prometheus/node-exporter/cadvisor panes during the sweep)_

- CPU saturation point : _TBD_
- Event-loop lag onset : _TBD_
- SQLite lock contention : _TBD_
- Cache hit ratio per endpoint : _TBD_

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

_(from A5/A6)_

- Saturation point : _TBD_
- Dominant cold-path cost : _TBD_
- Cache hit ratios : _TBD_
- p95 ceiling per endpoint : _TBD_
- Surprising findings : _TBD_

### 6.3 Recommendations (prioritised)

1. _TBD_
2. _TBD_
3. _TBD_

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
- `src/app.ts` : `/metrics` bypass + rate-limiter `skip` hooks.
- `src/tests/l402Bypass.test.ts` : four subprocess-boot cases + one
  middleware unit test.

Total LOC touched in `src/` : _TBD_.
