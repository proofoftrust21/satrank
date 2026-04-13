# DEPLOY.md

Production deployment guide for SatRank on a VPS with L402 via Aperture.

## Architecture

```
Internet → nginx (443) → Aperture (8443) → Express (3000)
                                ↕
                         LND + bitcoind (mainnet)
```

- **nginx**: TLS termination, static assets, proxy to Aperture
- **Aperture**: L402 reverse proxy that generates invoices and verifies payments
- **Express**: SatRank API (Docker container)
- **LND**: Lightning node, backed by a local **bitcoind v28.1** full node for UTXO-validated channel data. Any LND deployment (self-hosted, Voltage, Nodana, ...) works; it just needs to expose gRPC or REST with a macaroon.

## Prerequisites

- Ubuntu 22.04+ VPS
- Domain pointed to your VPS IP
- An LND node (mainnet) with an admin macaroon available to Aperture and a readonly macaroon available to the SatRank crawler container
- Go 1.21+ (to build Aperture)

## 1. Aperture

### Install

```bash
git clone https://github.com/lightninglabs/aperture.git /opt/aperture
cd /opt/aperture && go build -o /usr/local/bin/aperture ./cmd/aperture
```

### Config: /etc/aperture/aperture.yaml

```yaml
listenaddr: "127.0.0.1:8443"
debuglevel: "info"
autocert: false

authenticator:
  lnd:
    # gRPC host of the LND node Aperture uses to mint L402 invoices.
    # Prefer "localhost:10009" when LND runs on the same host — this avoids
    # copying macaroons/certs around and picks up LND cert regenerations
    # automatically (Aperture re-reads `tlspath` on restart).
    host: "localhost:10009"
    macaroonpath: "<LND_DATA_DIR>/data/chain/bitcoin/mainnet/admin.macaroon"
    tlscertpath: "<LND_DATA_DIR>/tls.cert"

services:
  - name: "satrank-api"
    hostregexp: "satrank.dev"
    pathregexp: '^/api/(decide|verdicts|best-route|profile/|agent/[a-f0-9])'
    protocol: "http"
    address: "localhost:3000"
    auth: "on"
    price: 21
    dynamicprice:
      enabled: false

dbbackend: "sqlite"
```

**Notes:**
- `price: 21`: 21 sats per L402 token = 21 requests (1 sat/request effective)
- Express tracks the balance via `token_balance` table and returns `X-SatRank-Balance` header
- `pathregexp`: covers decide, verdicts, best-route, profile, agent/:hash (and sub-routes). Health/stats/ping/report are free
- Replace `<LND_DATA_DIR>` with the absolute path to your LND data directory (where `tls.cert` and `data/chain/bitcoin/mainnet/admin.macaroon` live). Pointing Aperture at LND's live files instead of a copy means a cert regeneration on the LND side is picked up by `systemctl restart aperture` without any file juggling.
- `host: "localhost:10009"` assumes LND is on the same host and listens on the loopback interface (recommended; see the `restlisten=127.0.0.1:10009` convention in `lnd.conf`). If LND is remote, replace with `hostname:port` and add that IP to LND's `tlsextraip`.

### Systemd: /etc/systemd/system/aperture.service

```ini
[Unit]
Description=Aperture L402 Reverse Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aperture
Group=aperture
ExecStart=/usr/local/bin/aperture --configfile=/etc/aperture/aperture.yaml
Restart=always
RestartSec=5
LimitNOFILE=65536

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/aperture
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin aperture
sudo mkdir -p /var/lib/aperture
sudo chown aperture:aperture /var/lib/aperture
sudo systemctl daemon-reload
sudo systemctl enable --now aperture
```

## 2. nginx

### /etc/nginx/sites-available/satrank.dev

```nginx
server {
    listen 80;
    server_name satrank.dev;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name satrank.dev;

    ssl_certificate /etc/letsencrypt/live/satrank.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/satrank.dev/privkey.pem;

    # L402-gated endpoints — proxy through Aperture.
    # `/api/agent/{hash}` and `/api/agent/{hash}/{verdict,history,attestations}`
    # all match because the regex requires a 64-hex-char id after `/agent/`.
    # `/api/agents/top`, `/api/agents/movers`, `/api/agents/search` do NOT match
    # (no hex id after `/agents/`) — they fall through to Express and are free.
    location ~ ^/api/agent/[a-f0-9]+ {
        proxy_pass https://127.0.0.1:8443;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Explicit paid routes (exact match on /api/decide, prefix on /api/profile/).
    location = /api/decide {
        proxy_pass https://127.0.0.1:8443;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/api/profile/ {
        proxy_pass https://127.0.0.1:8443;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Free endpoint — report goes direct to Express (API key auth, no L402).
    location = /api/report {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # NIP-05 (.well-known/nostr.json) — public JSON, needs CORS.
    location /.well-known/nostr.json {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        add_header Access-Control-Allow-Origin * always;
    }

    # Catch-all — every non-paid `/api/*` (health, stats, agents/top,
    # agents/movers, agents/search, ping, verdicts, attestations, docs,
    # openapi.json), plus static assets (landing page, methodology, icons).
    # `/api/verdicts` is L402-gated at the Express level via `apertureGateAuth`,
    # so reaching Express direct returns 402 for external callers.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/satrank.dev /etc/nginx/sites-enabled/
sudo certbot --nginx -d satrank.dev
sudo nginx -t && sudo systemctl reload nginx
```

**Routing logic (matches README + landing page cost tables):**
- `/api/agent/{hash}`, `/api/agent/{hash}/verdict`, `/api/agent/{hash}/history`, `/api/agent/{hash}/attestations` → nginx → Aperture → Express (L402, 1 req from balance)
- `/api/decide` → nginx → Aperture → Express (L402, 1 req from balance)
- `/api/profile/{id}` → nginx → Aperture → Express (L402, 1 req from balance)
- `/api/verdicts` → nginx → Aperture → Express (L402, 1 request from balance)
- `/api/best-route` → nginx → Aperture → Express (L402, 1 request from balance)
- `/api/report`, `/api/attestations` → nginx → Express direct (free, X-API-Key required)
- `/api/health`, `/api/stats`, `/api/ping/{pubkey}`, `/api/agents/top`, `/api/agents/movers`, `/api/agents/search`, `/api/docs`, `/api/openapi.json` → nginx → Express direct (free, no auth)
- `/`, static assets, `/methodology.html` → nginx → Express static (free)
- `/.well-known/nostr.json` → nginx → Express direct (free, CORS enabled for NIP-05)

## 3. SatRank (Docker)

### Deploy

```bash
SATRANK_HOST=<user>@<your.server> REMOTE_DIR=/path/to/satrank make deploy
# expands to:
# rsync -avz --exclude node_modules --exclude dist --exclude .git \
#   --exclude .env.production --exclude data --exclude '*.macaroon' \
#   --exclude aperture.yaml --exclude '.claude' \
#   . <user>@<your.server>:/path/to/satrank/
```

### Start on server

```bash
ssh <user>@<your.server>
cd /path/to/satrank
docker compose up -d
```

### Verify

```bash
# Health (free, bypasses Aperture)
curl https://satrank.dev/api/health

# L402-gated endpoint — should return 402
curl -i https://satrank.dev/api/agents/top
# HTTP/2 402
# WWW-Authenticate: L402 macaroon="...", invoice="lnbc10n1..."

# Pay with lncli and retry
lncli payinvoice lnbc10n1...
curl -H "Authorization: L402 <macaroon>:<preimage>" https://satrank.dev/api/agents/top
```

## 4. Secrets management

Replace `$SATRANK_DIR` below with your install directory (e.g. `/opt/satrank`).

| Secret | Location on server | NOT in repo |
|--------|--------------------|-------------|
| API_KEY | `$SATRANK_DIR/.env.production` | .gitignore |
| APERTURE_SHARED_SECRET | `$SATRANK_DIR/.env.production` | .gitignore |
| LND admin macaroon | `/etc/aperture/admin.macaroon` | manual copy |
| LND readonly macaroon | `$SATRANK_DIR/readonly.macaroon` | manual copy (bind-mounted into crawler container) |
| LND TLS cert | `/etc/aperture/tls.cert` | manual copy |
| Let's Encrypt certs | `/etc/letsencrypt/` | certbot |

**Rotate API_KEY:**
```bash
NEW_KEY=$(openssl rand -hex 32)
sed -i "s/^API_KEY=.*/API_KEY=$NEW_KEY/" "$SATRANK_DIR/.env.production"
cd "$SATRANK_DIR" && docker compose restart api
```

## 5. Monitoring

```bash
# Container health
docker ps --format "table {{.Names}}\t{{.Status}}"

# Logs
docker logs -f satrank-api --since 1h
docker logs -f satrank-crawler --since 1h

# Aperture logs
journalctl -u aperture -f

# nginx access
tail -f /var/log/nginx/access.log | grep satrank
```

### Prometheus scraping

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: satrank
    scrape_interval: 15s
    static_configs:
      - targets: ['satrank-api:3000']
    metrics_path: /metrics
```

### Alerting rules

Create `satrank-alerts.yml` and include it in your Alertmanager config:

```yaml
groups:
  - name: satrank
    rules:
      # API is down
      - alert: SatRankDown
        expr: up{job="satrank"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "SatRank API is unreachable"

      # No agents indexed (data loss or failed migration)
      - alert: SatRankNoAgents
        expr: satrank_agents_total == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "No agents indexed — possible data loss or migration failure"

      # p99 latency > 5s
      - alert: SatRankHighLatency
        expr: histogram_quantile(0.99, rate(satrank_http_request_duration_seconds_bucket[5m])) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "SatRank p99 latency > 5s"

      # Score computation > 2s (should be <100ms normally)
      - alert: SatRankSlowScoring
        expr: histogram_quantile(0.99, rate(satrank_score_compute_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Score computation p99 > 2s — possible DB performance issue"

      # Crawler taking too long (> 5 minutes)
      - alert: SatRankCrawlSlow
        expr: histogram_quantile(0.99, rate(satrank_crawl_duration_seconds_bucket[30m])) > 300
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Crawler run exceeding 5 minutes"

      # High error rate (> 5% of requests returning 5xx)
      - alert: SatRankHighErrorRate
        expr: rate(satrank_requests_total{status=~"5.."}[5m]) / rate(satrank_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "SatRank 5xx error rate > 5%"
```

## 6. Backup

```bash
# Manual backup
docker compose exec api node dist/scripts/backup.js

# Automated hourly backup via cron (replace $SATRANK_DIR with your install path)
0 * * * * cd $SATRANK_DIR && docker compose exec -T api node dist/scripts/backup.js >> /var/log/satrank-backup.log 2>&1
```

Backups are stored in `data/backups/`, with the 24 most recent retained automatically.
Each backup is verified with `PRAGMA integrity_check` after copy.

## 7. Crawl intervals

Each data source runs on its own timer in `--cron` mode. At startup, a full crawl of all sources runs immediately, then each source follows its own interval.

| Variable | Default | Description |
|----------|---------|-------------|
| `CRAWL_INTERVAL_OBSERVER_MS` | `300000` (5 min) | Observer Protocol transactions |
| `CRAWL_INTERVAL_LND_GRAPH_MS` | `3600000` (1 hour) | LND full graph (~14k active nodes on mainnet) |
| `CRAWL_INTERVAL_LNPLUS_MS` | `86400000` (24 hours) | LN+ community ratings |
| `CRAWL_INTERVAL_PROBE_MS` | `1800000` (30 min) | Route probe (reachability check) |
| `PROBE_MAX_PER_SECOND` | `15` | Max probes per second (rate limiter) |
| `PROBE_AMOUNT_SATS` | `1000` | Base amount in sats to test routes with (multi-amount probing escalates to 10k/100k/1M for hot nodes) |
| `DECIDE_REPROBE_STALE_SEC` | `1800` | Max age (seconds) of probe data before `/api/decide` fires a live re-probe at the caller's amountSats |

Override in `.env.production`:

```bash
# Aggressive: refresh everything often (higher resource usage)
CRAWL_INTERVAL_OBSERVER_MS=60000        # 1 minute
CRAWL_INTERVAL_LND_GRAPH_MS=300000      # 5 minutes
CRAWL_INTERVAL_LNPLUS_MS=3600000        # 1 hour

# Relaxed: save resources
CRAWL_INTERVAL_OBSERVER_MS=600000       # 10 minutes
CRAWL_INTERVAL_LND_GRAPH_MS=21600000    # 6 hours
CRAWL_INTERVAL_LNPLUS_MS=86400000       # 24 hours
```

After each LND crawl, the scoring pipeline runs in two passes: first any unscored
agents that accumulated since the last cycle (bulk scoring, unscored), then all
previously scored agents are rescored with fresh data (bulk rescore). On a normal
cycle this touches every eligible agent in the index, not a top-N subset. Logs
show exact counts (`scored X/Y errors=0`) for each pass.

## 8. Snapshot retention

The `score_snapshots` table grows with every score computation. On the production
mainnet instance each cycle writes ~7,000+ rows, and the retention cron keeps the
last 45 days.

The retention policy is defined in `src/config/retention.ts` and applied by a
dedicated cron inside the crawler process (not embedded in each crawl):

- **`RETENTION_POLICIES`** (flat cutoff per table):
  - `probe_results`: 14 days (regularity uses the last 7, kept 2x for margin)
  - `score_snapshots`: **45 days** (delta windows up to 30d, kept 1.5x for margin)
  - `channel_snapshots`: 14 days
  - `fee_snapshots`: 14 days
- **`RETENTION_CHUNK_SIZE`**: deletes run in chunks of 50,000 rows per
  transaction so the SQLite WAL never balloons (previous multi-million-row
  monolithic `DELETE` grew the WAL past 1 GB and stalled, which is why chunking).
- **`RETENTION_INTERVAL_MS`**: the retention cron runs every **24 hours**,
  independent from the crawler's data ingestion cycle. At startup it also runs
  once immediately.

The retention cron is started from `src/crawler/run.ts` and logs each table's
`{deleted, durationMs}` after every sweep.
