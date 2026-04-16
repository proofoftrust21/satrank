# Observability Audit — SatRank

_Date: 2026-04-16._
_Scope: API + crawler containers, metrics / logs / health / SLIs._

## TL;DR

Observability is solid for the API hot paths (HTTP latency, cache freshness, LND saturation). Two large blind spots remain:

1. **Crawler container exports zero metrics.** `crawlDuration` and related histograms are captured into the registry but no `/metrics` endpoint is exposed on the crawler process. Prometheus cannot scrape it.
2. **Business SLIs are missing.** We track HTTP status but not verdict breakdown (SAFE/RISKY/UNKNOWN), report outcomes, deposit phases, Nostr publishing, or rate limit hits. A prod incident on any of these would be invisible until a user complains.

Everything else is either instrumented or has a clear, cheap fix below.

---

## What's Covered Today

### API container (✓)
- **HTTP**: `satrank_requests_total` + `satrank_http_request_duration_seconds` labelled by `method`, `route`, `status`. Route normalized to Express pattern (no cardinality explosion on `:hash`).
- **LND saturation**: `satrank_lnd_inflight` (gauge) + `satrank_lnd_queryroutes_duration_seconds` (histogram). Semaphore cap of 10 is directly observable.
- **Cache freshness**: `satrank_cache_age_seconds{key}` + `satrank_cache_refresh_failures{key}` refreshed on every `/metrics` scrape. `/api/health.cacheHealth.degraded` flips to `true` when `ageSec > TTL × 3` or `consecutiveFailures ≥ 3`.
- **Cache hits/misses**: `satrank_cache_events_total{namespace, event}`.
- **Node defaults**: event loop lag, heap, GC, resident memory (`client.collectDefaultMetrics`).
- **Health endpoint**: `/api/health` — DB ping + schema version check + cache degradation. Returns 503 on failure, which Docker healthcheck consumes.
- **Request ID**: `requestIdMiddleware` assigns uuid per request; echoed in error responses + logs on 500s.

### Crawler container (partial)
- **Logs**: All source crawls emit structured pino logs with counts, durations, error lists.
- **Liveness**: `/tmp/crawler.heartbeat` mtime probed every 60s; Docker kills container after 5× heartbeat stall.
- **Process safety**: `unhandledRejection` + `uncaughtException` handlers keep the crawler alive across nostr-tools relay flakes.

### Error handling (✓)
- No `console.log` in production paths (only in `src/scripts/` CLI tools).
- Pino logger used consistently across 38 files.
- Top-level crawler promise rejections logged with context.

---

## Gaps

### CRITICAL — blind spots that will bite in production

#### C1. Crawler has no `/metrics` endpoint
- `src/crawler/run.ts:75` (and all `crawlDuration.observe` calls) write to a `prom-client` registry that is never exported.
- Impact: no way to alert on a stuck probe cycle, a slow LND graph crawl, or a Lnplus/registry scrape that's failing quietly.
- Fix: add a minimal HTTP server in `run.ts` (e.g. 15 LOC, port bound to `127.0.0.1`) serving `GET /metrics`. Expose the same `metricsRegistry`. Scrape target: `crawler:9090/metrics`. Effort: ~1h.

#### C2. No verdict / decide outcome counter
- `satrank_requests_total` captures HTTP status but not the semantic response. A deploy that flips every verdict to UNKNOWN would look healthy.
- Fix: `satrank_verdict_total{verdict}` counter incremented in `VerdictService.getVerdict` and in `v2Controller.decide`'s result path. Effort: ~30m.

#### C3. Nostr publishing is completely un-metered
- `src/nostr/*` has zero `metricsRegistry` imports.
- Today, if Stream A or Stream B stop publishing, the only signal is silence in the crawler logs. The WoT-a-thon scoring depends on publishing being alive.
- Fix: 3 metrics — `satrank_nostr_publish_total{stream, result}` (counter), `satrank_nostr_relay_ack_total{relay, result}`, `satrank_nostr_last_publish_timestamp{stream}` (gauge). Wire into `NostrPublisher.publishScores` + `NostrIndexedPublisher.publishFromMiningJson`. Effort: ~45m.

### HIGH — degradations that are detectable but slow

#### H1. `lastUpdate` is exposed but not threshold-checked
- `/api/health.lastUpdate` is the `MAX(computed_at)` from `score_snapshots`. If the crawler stops scoring, this stops moving but `status` stays `ok`.
- Fix: `StatsService.getHealth` flips `status` to `error` (or adds `scoringStale` flag) when `now - lastUpdate > 2 × expected crawl interval`. Effort: ~15m.

#### H2. LND connectivity is not in `/api/health`
- LND being down breaks `/api/decide`, `/api/best-route`, and verdict pathfinding. Health returns 200 OK.
- Fix: Add an opportunistic `lndClient.getInfo()` behind a 1s timeout, cached for 30s. If it fails 3 times consecutively, mark health degraded. Effort: ~30m.

#### H3. `satrank_db_query_duration_seconds` is declared but never observed
- `middleware/metrics.ts:102` defines the histogram; grep finds zero `.observe()` calls.
- Impact: a SQL regression (bad plan, missing index) is invisible until p99 latency on the HTTP path climbs.
- Fix: either delete the metric or wrap hot repository methods. Minimum coverage: `agentRepo.findTopByScore`, `snapshotRepo.findLatestByAgents`, `probeRepo.computeTierSuccessRates`. Effort: ~30m.

#### H4. Rate limit hits are invisible
- `express-rate-limit` returns 429 but there's no counter to distinguish "global" vs "discovery" vs "deposit" limiter. If a legitimate aggregator is being throttled, we'd never know.
- Fix: `satrank_rate_limit_hits_total{limiter}` counter, incremented via the `handler` option on each limiter. Effort: ~15m.

#### H5. `/metrics` endpoint silently swallows errors
- `src/app.ts:262` — `catch { res.status(500).end('Internal Server Error'); }` with no log. If `getNetworkStats()` throws during a scrape, Prometheus sees 500 with no diagnostic.
- Fix: `logger.error({ err }, 'Metrics scrape failed')` before the 500. Effort: 2 min.

### MEDIUM — legitimately silent failures that could hide bugs

#### M1. Three JSON-parse fallbacks swallow bad data
- `src/services/agentService.ts:166` — components JSON parse failure returns zeros in `/api/agents/top`.
- `src/nostr/nostrIndexedPublisher.ts:203` — same for published Nostr events.
- `src/repositories/agentRepository.ts:219,284` — column-missing fallbacks (schema is at v28; these branches are dead).
- Fix: add `logger.warn({ agentHash, error })` in the parse-failure branches. Drop the dead column-missing branches. Effort: ~20m.

#### M2. `v2Controller.decide` silently swallows `decide_log` insert failure
- `src/controllers/v2Controller.ts:76` — catastrophic DB issues would cause L402 token / target linkage to be lost, breaking subsequent `/api/report` auth.
- Fix: `logger.warn({ err, targetHash }, 'decide_log insert failed')`. Effort: 2 min.

#### M3. Request ID not set on response headers
- `requestIdMiddleware` puts the ID on `req` and in error bodies, but not on `res.setHeader('X-Request-Id', ...)`. Clients can't return an ID with a bug report.
- Fix: set header in the middleware. Effort: 2 min.

#### M4. Circuit breaker state is un-instrumented
- `src/utils/circuitBreaker.ts` uses `logger` on open/close but no gauge.
- Fix: `satrank_circuit_breaker_state{name}` (0=closed, 1=half-open, 2=open). Effort: ~15m.

### LOW — nice to have

- **Deposit phase counter** (`invoice_created` / `verify_success` / `verify_pending` / `verify_not_found`).
- **Watchlist flagged-changes counter** (cross-threshold events per cycle).
- **Bytes in / out of Nostr relays** (bandwidth accounting, not critical).
- **Pino log-level distribution** metric (warn / error rate over time).

---

## SLI Readiness

Given the current instrumentation, here are the SLOs we can declare **today** vs **after C1–C3 land**:

| SLO | Today | After C1–C3 |
|-----|-------|-------------|
| Availability (HTTP 5xx rate) | ✓ | ✓ |
| p95 latency per endpoint | ✓ | ✓ |
| Cache freshness (staleness) | ✓ | ✓ |
| LND pathfinding latency | ✓ | ✓ |
| Crawler cycle duration | logs only | ✓ |
| Probe success rate | logs only | ✓ |
| Nostr publish success rate | ✗ | ✓ |
| Verdict stability (e.g. "≥99.9% of verdicts are deterministic") | ✗ | ✓ |
| Report auth success rate | ✗ | partial (M2) |

---

## Recommended Rollout Order

1. **M3 + H5 + M2** (trivial single-line fixes, 5 minutes total, no risk).
2. **C1** (crawler `/metrics`) — unlocks all crawler SLOs.
3. **C2 + C3** (verdict + nostr counters) — adds business SLIs.
4. **H1 + H2** (health check expansion) — promotes `/api/health` from "is DB up" to "is the service actually functioning".
5. **H3 + H4 + M1 + M4** (breadth: DB latency, rate limits, JSON errors, circuit breaker).
6. LOW items as needed.

Total effort for CRITICAL + HIGH: roughly half a day of focused work.
