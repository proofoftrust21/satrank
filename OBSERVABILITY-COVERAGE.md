# Observability Coverage — SatRank

_Shipped: 2026-04-16. Follow-up to [OBSERVABILITY-AUDIT.md](./OBSERVABILITY-AUDIT.md)._

All 12 findings from the audit (3 CRITICAL, 5 HIGH, 4 MEDIUM) are live in production.

## Endpoints

| Endpoint | Auth | Scope |
|----------|------|-------|
| `https://satrank.dev/api/health` | Public | JSON health payload — now includes `scoringStale`, `lndStatus`, `cacheHealth` |
| `http://localhost:3000/metrics` | localhost or `X-API-Key` | API-side Prometheus exposition |
| `http://localhost:9091/metrics` | localhost or `X-API-Key` | **New** crawler-side Prometheus exposition |
| `http://localhost:9091/healthz` | Public | Crawler liveness (200 ok) |

Both `/metrics` endpoints share the same metric namespace (`satrank_*`) since the registry is process-local; cardinality is modest (< 300 series each).

## Metrics Now Available

### API container

| Metric | Type | Purpose |
|--------|------|---------|
| `satrank_requests_total{method, route, status}` | counter | HTTP request rate |
| `satrank_http_request_duration_seconds{method, route, status}` | histogram | HTTP latency |
| `satrank_verdict_total{verdict}` | counter | **NEW C2** — SAFE / RISKY / UNKNOWN distribution |
| `satrank_rate_limit_hits_total{limiter}` | counter | **NEW H4** — 429 per limiter (global / discovery / deposit / report / attestation / ping) |
| `satrank_db_query_duration_seconds{repo, method}` | histogram | **NEW H3** — wired for `agent.findTopByScore`, `snapshot.findLatestByAgents`, `probe.computeTierSuccessRates` |
| `satrank_lnd_reachable` | gauge | **NEW H2** — 1/0 from the /health probe |
| `satrank_lnd_inflight` | gauge | Concurrent LND queryRoutes (Semaphore) |
| `satrank_lnd_queryroutes_duration_seconds` | histogram | Per-call LND latency |
| `satrank_cache_events_total{namespace, event}` | counter | Hit/miss/evict per cache key |
| `satrank_cache_age_seconds{key}` | gauge | Cache freshness per key (refreshed on every scrape) |
| `satrank_cache_refresh_failures{key}` | gauge | Consecutive background refresh failures per key |
| `satrank_circuit_breaker_state{breaker}` | gauge | **NEW M4** — 0 closed / 1 half-open / 2 open |
| `satrank_score_compute_duration_seconds` | histogram | Per-agent scoring latency |
| `satrank_agents_total`, `satrank_channels_total` | gauge | Network size snapshots |

### Crawler container (all new via C1)

Exports the **same registry** (since `metricsRegistry` is per-process but the crawler runs the same codebase). The metrics that actually populate are:

| Metric | Source |
|--------|--------|
| `satrank_crawl_duration_seconds{source}` | Observer / LND graph / mempool / Lnplus / probe |
| `satrank_nostr_publish_total{stream, result}` | **NEW C3** — Stream A (lightning-indexed) and Stream B (nostr-indexed), result = published / skipped / error |
| `satrank_nostr_relay_ack_total{relay, result}` | **NEW C3** — per-relay ack success / timeout / error |
| `satrank_nostr_publish_duration_seconds{stream}` | **NEW C3** — publish cycle duration |
| `satrank_nostr_last_publish_timestamp{stream}` | **NEW C3** — unix time of last successful publish |
| `satrank_circuit_breaker_state{breaker}` | Crawler breakers: `lnd`, `probe` |

Plus Node process defaults (GC, event loop lag, heap) from `collectDefaultMetrics`.

## Health Response Extensions

`GET /api/health` body additions:

```json
{
  "scoringAgeSec": 459,
  "scoringStale": false,
  "lndStatus": "ok",
  "lndLastProbeAgeSec": 14
}
```

- `scoringAgeSec` flips `status` to `error` when > 2h (**H1**).
- `lndStatus` flips `status` to `error` when 3+ consecutive `getInfo()` failures (**H2**). `disabled` / `unknown` / `ok` / `degraded`.
- `X-Request-Id` response header is now set on every response (**M3**), echoing the server-side request ID for client-side correlation.
- Schema mismatch now logs at warn level on first detection (**trivial**).
- Bad JSON in `score_snapshots.components` now logs at warn for both the top-agents endpoint (**M1**) and the Stream B Nostr publisher (**M1**).
- `decide_log` insert failures in `/api/decide` now log at warn with `targetHash` + `requestId` (**M2**).
- `/metrics` scrape failures now log at error (**H5**).

## Alerts a Monitoring Stack Can Now Build

### Business SLOs

```promql
# Verdict distribution shift — deploy regression detector
(
  rate(satrank_verdict_total{verdict="UNKNOWN"}[5m])
  / rate(satrank_verdict_total[5m])
) > 0.5
# for: 10m → "SAFE ratio collapsed, likely scoring regression"

(
  rate(satrank_verdict_total{verdict="SAFE"}[1h])
  / rate(satrank_verdict_total[1h])
) < 0.4
# for: 30m → "SAFE rate below historical baseline"
```

### Crawler health (previously invisible)

```promql
# No crawl of any source in the last hour
(time() - max by (source) (satrank_crawl_duration_seconds_sum))
> 3600

# Nostr stream silent for > 2h
time() - satrank_nostr_last_publish_timestamp{stream="A"} > 7200
time() - satrank_nostr_last_publish_timestamp{stream="B"} > 7200

# Relay is dead (dropping all acks)
rate(satrank_nostr_relay_ack_total{result="success"}[30m]) == 0
  and rate(satrank_nostr_relay_ack_total[30m]) > 0
```

### Infrastructure

```promql
# API /health is lying about being ok
max_over_time(satrank_cache_refresh_failures[10m]) >= 3

# LND down
satrank_lnd_reachable == 0 for 2m

# Circuit breaker open for too long
satrank_circuit_breaker_state >= 2 for 5m

# SQL regression on hot path
histogram_quantile(0.99, rate(satrank_db_query_duration_seconds_bucket{repo="agent",method="findTopByScore"}[5m])) > 0.1

# A legitimate client is being throttled
rate(satrank_rate_limit_hits_total{limiter="global"}[5m]) > 1
```

### SLIs

```promql
# Availability — the canonical one
1 - (
  sum(rate(satrank_requests_total{status=~"5.."}[5m]))
  / sum(rate(satrank_requests_total[5m]))
)

# p95 latency per endpoint
histogram_quantile(
  0.95,
  sum by (route, le) (rate(satrank_http_request_duration_seconds_bucket[5m]))
)
```

## Remaining Gaps (LOW, non-blocking)

1. **Deposit phase counter** — `invoice_created` vs `verify_success` vs `verify_pending` vs `verify_not_found`. Today we know request rate + status, not the phase mix. Worth adding when deposit volume becomes a business signal.
2. **Watchlist flagged-changes counter** — how many agents crossed thresholds per cycle. Observable from logs; not wired as a metric.
3. **Relay bandwidth accounting** — bytes in / out per relay. Not needed until we hit relay rate limits.
4. **Pino log-level distribution metric** — a gauge of warn / error rate over time. `pino-prometheus` would do this cleanly; skipped for now.
5. **Per-endpoint verdict label** — today `verdictTotal` is one counter with `verdict` label only. Adding `source` (`decide` / `verdict` / `best-route` / `dvm`) would let us see if one endpoint is skewed. Cardinality remains tiny (4 × 3 = 12 series).
6. **Dead fallback branches in `agentRepository.ts`** — `touchLastQueried` and `findHotNodes` have `catch { /* column may not exist yet */ }` guards that are unreachable at schema v28. Safe cleanup but not observability.

## Operator Notes

- `/metrics` auth: **localhost bypass only works from inside the container** (e.g. `docker exec`). Host access via the published port passes through Docker NAT and the source IP is the bridge (172.x.x.x), so external scrapers must use `X-API-Key`.
- Crawler metrics port is configurable via `CRAWLER_METRICS_PORT` env (defaults to 9091); the compose file binds it to host `127.0.0.1`.
- A Prometheus scrape config for both targets:

```yaml
scrape_configs:
  - job_name: satrank-api
    static_configs: [{ targets: ['localhost:3000'] }]
    metrics_path: /metrics
    authorization: { credentials_file: /etc/prometheus/satrank-api-key }
    # Or, equivalently, set X-API-Key via relabel_configs.
  - job_name: satrank-crawler
    static_configs: [{ targets: ['localhost:9091'] }]
    metrics_path: /metrics
    authorization: { credentials_file: /etc/prometheus/satrank-api-key }
```

A single-line alert rule file covering the top 5 critical paths would fit in ~25 lines — happy to ship that when a Prometheus instance is wired up.
