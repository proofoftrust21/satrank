# Environment variables

Template for `.env.production` on VM1. Never commit actual values. Generate each 64-char hex secret with `openssl rand -hex 32` unless noted otherwise.

## Database

```
DATABASE_URL=postgresql://satrank:<password>@<VM2-private-IP>:5432/satrank
DB_POOL_MAX_API=30
DB_POOL_MAX_CRAWLER=20
DB_STATEMENT_TIMEOUT_MS=15000
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=5000
```

## LND

```
LND_REST_URL=https://127.0.0.1:8080
LND_MACAROON_PATH=/app/data/readonly.macaroon
LND_INVOICE_MACAROON_PATH=/app/data/invoice.macaroon
LND_ADMIN_MACAROON_PATH=/app/data/pay.macaroon
LND_TIMEOUT_MS=30000
NODE_PUBKEY=<66-char-hex>
```

## L402 native gate

```
L402_MACAROON_SECRET=<64-char-hex>
L402_DEFAULT_PRICE_SATS=1
L402_INVOICE_EXPIRY_SECONDS=600
OPERATOR_BYPASS_SECRET=<64-char-hex>
```

## Server

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=https://satrank.dev
SERVER_IP=<VM1-public-IPv4>
LOG_LEVEL=info
PUBLIC_HOST=satrank.dev
```

## Auth

```
API_KEY=<64-char-hex>
```

## Nostr

```
NOSTR_PRIVATE_KEY=<64-char-hex>
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net
NOSTR_PUBLISH_INTERVAL_MS=1800000
NOSTR_MIN_SCORE=30
NOSTR_MULTI_KIND_ENABLED=false
```

## Probes

```
PROBE_MAX_PER_SECOND=30
PROBE_AMOUNT_SATS=1000
PROBE_MAX_INVOICE_SATS=1000
PROBE_FETCH_TIMEOUT_MS=15000
PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR=10
PROBE_RATE_LIMIT_GLOBAL_PER_HOUR=20
```

## Crawler metrics

```
CRAWLER_METRICS_PORT=9091
```

## Paid probes (Sim 7 follow-up — stages 3-5)

OPT-IN. When `PAID_PROBE_ENABLED=true`, the crawler pays L402 invoices on
priority-selected hot-tier endpoints to populate the payment / delivery /
quality stages of the 5-stage L402 contract decomposition. The
`probe-pay.macaroon` referenced by `LND_ADMIN_MACAROON_PATH` MUST be
readable by the container user (uid 1001 = satrank) — `chown 1001:1001`
on host.

```
PAID_PROBE_ENABLED=false
PAID_PROBE_INTERVAL_HOURS=6
PAID_PROBE_MAX_PER_PROBE_SATS=5
PAID_PROBE_TOTAL_BUDGET_SATS=50
PAID_PROBE_BUDGET_PER_24H_SATS=1000
PAID_PROBE_MAX_PER_CYCLE=10
```

`PAID_PROBE_BUDGET_PER_24H_SATS` is a sliding 24h cap added in the audit r2
follow-up (2026-04-29). Each cycle reads the cumulative `paid_probe` spending
of the last 24 hours and caps the per-cycle spend at
`min(PAID_PROBE_TOTAL_BUDGET_SATS, BUDGET_PER_24H - spent_last_24h)`. Set to
`0` to disable the rolling guard. Default 1000 ≈ $0.40/day, ~$12/month —
covers τ=7d posterior decay refresh + new endpoint bootstrap without runaway.

Cap math: 50 sats/cycle × 4 cycles/day = ~200 sats/day max ≈ ~$1/month
at default cap. Adjust `MAX_PER_PROBE_SATS` upward (e.g. 50) to cover
the median catalogue invoice (~21 sats) — see
[OPERATOR_QUICKSTART.md](OPERATOR_QUICKSTART.md) "Paid probe activation".

### Sweep cron (Excellence pass — medium-demand band)

The Pareto-80 cron above probes the daily hot tier. The SWEEP cron is a
slower, lower-rate cron that probes endpoints the daily cron misses —
the medium-demand band: endpoints with at least *some* signal of future
demand (recent intent query, multi-source curation, healthy upstream
reliability) but not in the daily hot tier. Catches drift on the long
tail of the catalogue. OPT-IN.

```
PAID_PROBE_SWEEP_ENABLED=false
PAID_PROBE_SWEEP_INTERVAL_HOURS=168
PAID_PROBE_SWEEP_MAX_PER_RUN=25
PAID_PROBE_SWEEP_FRESH_AFTER_DAYS=30
```

Cap math: 25 probes × ~25 sats × 4 weeks/month = ~2 500 sats/month
(~$1/month). Combined with the daily Pareto-80 cron (~8 000 sats/month
in cruise), excellence-tier total ≈ 10 500 sats/month ≈ $4/month.

## MCP / DVM upstream

`SATRANK_API_BASE` is read by both the MCP server (`intent` tool) and
the NIP-90 DVM (`j: intent-resolve`) when they need to call the oracle's
own `/api/intent` from outside the api container. Default = production.
Validation enforces `https://` (or `http://localhost` for dev) to
prevent SSRF.

```
SATRANK_API_BASE=https://satrank.dev
```

## Rate limiting

```
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
AUTO_INDEX_MAX_PER_MINUTE=10
```

## Optional: SMTP alerts

Set only if configuring an SMTP relay for cron alert emails. Brevo delivery to ProtonMail currently fails SPF silently as of 2026-04-24; treat email alerts as best-effort and rely on Prometheus plus manual health checks as the primary signal.

```
# SMTP_HOST=smtp-relay.brevo.com
# SMTP_USER=<brevo-account>
# SMTP_PASS=<brevo-smtp-key>
```
