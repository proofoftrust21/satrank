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
