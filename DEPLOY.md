# DEPLOY.md

Production deployment guide for SatRank on a VPS with L402 via Aperture.

## Architecture

```
Internet → nginx (443) → Aperture (8443) → Express (3000)
                                ↕
                         LND + bitcoind (mainnet)
```

- **nginx**: TLS termination, static assets, proxy to Aperture
- **Aperture**: L402 reverse proxy — generates invoices, verifies payments
- **Express**: SatRank API (Docker container)
- **LND**: Lightning node, backed by a local **bitcoind v28.1** full node for UTXO-validated channel data. Any LND deployment (self-hosted, Voltage, Nodana, …) works — it just needs to expose gRPC or REST with a macaroon.

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
    host: "YOUR_VOLTAGE_NODE.voltageapp.io:10009"
    macaroonpath: "/etc/aperture/admin.macaroon"
    tlscertpath: "/etc/aperture/tls.cert"

servicesettings:
  - name: "satrank"
    hostregexp: "satrank.dev"
    pathregexp: "/api/(agent|agents|decide|profile).*"
    price: 1
    duration: 31536000
    capabilities:
      - "read"

dbdir: "/var/lib/aperture"
```

**Notes:**
- `price: 1` — 1 satoshi per query
- `duration: 31536000` — L402 token valid for 1 year (365 days in seconds)
- `pathregexp` — only agent/agents endpoints require payment; health/stats/version are free
- Copy your LND admin macaroon to `/etc/aperture/admin.macaroon`
- Copy your LND TLS cert to `/etc/aperture/tls.cert`

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
    listen 443 ssl http2;
    server_name satrank.dev;

    ssl_certificate /etc/letsencrypt/live/satrank.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/satrank.dev/privkey.pem;

    # L402-gated endpoints — proxy through Aperture
    # Matches: /api/agent/*, /api/agents/*, /api/decide, /api/profile/*
    location ~ ^/api/(agent|agents|decide|profile) {
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Free endpoint — report goes direct to Express (API key auth, no L402)
    location = /api/report {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Free endpoints — direct to Express (health, stats, attestations, etc.)
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Static assets (landing page, favicon)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 80;
    server_name satrank.dev;
    return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/satrank.dev /etc/nginx/sites-enabled/
sudo certbot --nginx -d satrank.dev
sudo nginx -t && sudo systemctl reload nginx
```

**Routing logic:**
- `/api/agent/*`, `/api/agents/*`, `/api/decide`, `/api/profile/*` → Aperture (L402, 1 sat)
- `/api/report` → Express direct (API key auth, free)
- `/api/health`, `/api/stats`, `/api/attestations`, `/api/docs` → Express direct (free)
- `/`, `/app.js`, `/favicon.png` → Express static (free)

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
| `CRAWL_INTERVAL_PROBE_MS` | `3600000` (1 hour) | Route probe (reachability check) |
| `PROBE_MAX_PER_SECOND` | `10` | Max probes per second (rate limiter) |
| `PROBE_AMOUNT_SATS` | `1000` | Amount in sats to test routes with |

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

After each Observer and LND crawl, scores are pre-computed for the top 50 agents and old snapshots are purged.

## 8. Snapshot retention

The `score_snapshots` table grows with each score computation (~50 agents every 5 minutes = ~14,400 rows/day).
The crawler automatically purges old snapshots after each crawl run:

- **< 7 days**: all snapshots retained
- **7–30 days**: 1 snapshot per agent per day (deduplication via `ROW_NUMBER()`)
- **> 30 days**: deleted

This runs inside `runCrawl()` at the end of each cycle (cron or single run).
No additional cron job is needed — the purge is embedded in the crawler process.
