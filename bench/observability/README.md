# Phase 12A — Observability stack

**Status:** A1 deliverable. Deployed on staging only; prod gets a promtail daemon (nginx log shipping) deployed separately via `deploy-prod-promtail.sh` once authorized.

## Topology

```
┌─────────────────────────────── staging (178.104.142.150) ────────────────────────────────┐
│                                                                                          │
│  ┌─ prometheus :9090                                                                     │
│  │   scrapes:                                                                            │
│  │   • self                                                                              │
│  │   • host.docker.internal:9100  (node-exporter, host-mode)                             │
│  │   • cadv12a:8080               (cadvisor, bridge)                                     │
│  │   • host.docker.internal:8080  (staging SatRank /metrics, localhost bypass)           │
│  │   • host.docker.internal:18080 (PROD SatRank /metrics via SSH tunnel ─┐)              │
│  │                                                                      │               │
│  ├─ grafana :3000  (default creds admin / ${GRAFANA_ADMIN_PASSWORD})    │               │
│  │   datasources: Prometheus (default) + Loki                          │               │
│  │   dashboards: satrank-api, satrank-system, satrank-sqlite, satrank-logs              │
│  │                                                                      │               │
│  ├─ loki :3100  (14-day retention, filesystem storage)                  │               │
│  │    ← pushed by promtail (staging)  [docker container logs]            │               │
│  │    ← pushed by ptail-prod (prod)   [nginx access/error logs]          │               │
│  │                                                                      │               │
│  ├─ promtail (ptail12a)  — tails /var/lib/docker/containers/*-json.log  │               │
│  ├─ node-exporter (host mode) :9100                                     │               │
│  ├─ cadvisor :8088                                                      │               │
│  │                                                                      │               │
│  └─ systemd: satrank-prod-tunnel.service                                │               │
│       ssh -L 0.0.0.0:18080:127.0.0.1:8080 root@prod ──────────────────────┘               │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           │ SSH tunnel (18080 → prod localhost 8080)
                                           ▼
┌──────────────────────────────── prod (178.104.108.108) ──────────────────────────────────┐
│                                                                                          │
│  ┌─ satrank-api :8080   /metrics already exposed (localhost bypass on auth)              │
│  │                                                                                       │
│  ├─ nginx :80/:443      access.log + error.log → tailed by ptail-prod                   │
│  │                                                                                       │
│  └─ ptail-prod          (authorized promtail sidecar)                                    │
│        pushes {job="nginx",host="prod"} streams → staging Loki :3100                     │
│                                                                                          │
│  NOTE: prod gets ONE authorized daemon addition (ptail-prod). No other changes.          │
│        No node-exporter, no cadvisor, no nginx config mods. All other observability      │
│        comes from what prod already exposes + its existing nginx logs.                   │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Ports

| Port on staging | Service      | Access            |
|-----------------|--------------|-------------------|
| 3000            | Grafana      | web UI            |
| 3100            | Loki         | push/query API    |
| 8088            | cAdvisor     | /metrics          |
| 9090            | Prometheus   | web UI + /metrics |
| 9100            | node-exporter (host) | /metrics   |
| 18080           | SSH tunnel to prod:8080 | internal |

## Credentials

- **Grafana admin**: `admin` / value of `GRAFANA_ADMIN_PASSWORD` env (default `admin`, override in production)

## Deploy

### Staging (full stack)

```bash
cd bench/observability
GRAFANA_ADMIN_PASSWORD='<strong>' ./deploy-staging.sh
```

This rsyncs the configs to `/opt/observability` on staging, installs the SSH tunnel systemd unit, then `docker compose up -d`. Readiness probes wait up to 60s per service.

### Prod (promtail only, authorized deploy)

```bash
cd bench/observability
PHASE_12A_PROD_PROMTAIL_OK=yes ./deploy-prod-promtail.sh
```

The env-var gate forces an explicit operator acknowledgement. Without it the script refuses.

## What's NOT in this stack (intentional)

- **No alertmanager** — rules exist (`prometheus/alert_rules.yml`) but routing is left disabled; alerts surface as panel annotations inside Grafana.
- **No tracing** — Jaeger/Tempo were out of scope for rupture-point detection. Can be added later if the bench identifies a latency hot-spot that span-level data would resolve.
- **No prod node-exporter / cadvisor** — scraping those would require installing daemons on prod. Deferred until Romain approves.

## Dashboards

1. **SatRank — API** (`satrank-api-p12a`): HTTP RED per route, status codes, p50/p95/p99 latency, rate-limit rejections, verdict outcomes, probe outcomes.
2. **SatRank — System** (`satrank-system-p12a`): host CPU/mem/disk/net + per-container CPU/mem + Node.js event loop lag + GC + LND inflight + Nostr publish rate.
3. **SatRank — SQLite & Cache** (`satrank-sqlite-p12a`): DB query rate/p95 per repo/method, cache hit ratio, cache freshness per key, refresh failures, score compute p95.
4. **SatRank — Logs** (`satrank-logs-p12a`): Nginx request rate by status class, container log rate by stream, error-line tail.

All dashboards are filesystem-provisioned and edit-locked (`allowUiUpdates: false`). To change a panel, edit the JSON in this repo and redeploy.

## Dependencies on existing SatRank code

**Zero.** The stack consumes what `src/middleware/metrics.ts` already exposes. Dashboard panels reference the existing metric names (e.g. `satrank_http_request_duration_seconds`, `satrank_db_query_duration_seconds`, `satrank_verdict_total`). No new instrumentation was added for Phase 12A A1.
