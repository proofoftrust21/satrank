# DEPLOY.md

Production deployment guide for SatRank on a VPS with L402 via Aperture.

## Architecture

```
Internet → nginx (443) → Aperture (8443) → Express (3000)
                                ↕
                         LND (Voltage mainnet)
```

- **nginx**: TLS termination, static assets, proxy to Aperture
- **Aperture**: L402 reverse proxy — generates invoices, verifies payments
- **Express**: SatRank API (Docker container)
- **LND**: Lightning node on Voltage (hosted, mainnet)

## Prerequisites

- Ubuntu 22.04+ VPS (tested on Hetzner)
- Domain pointed to VPS IP (satrank.dev)
- Voltage LND node (mainnet) with admin macaroon
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
    pathregexp: "/api/v1/(agent|agents).*"
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
- Copy your Voltage admin macaroon to `/etc/aperture/admin.macaroon`
- Copy your Voltage TLS cert to `/etc/aperture/tls.cert`

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
    location ~ ^/api/v1/(agent|agents) {
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Free endpoints — direct to Express
    location /api/v1/ {
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
- `/api/v1/agent/*` and `/api/v1/agents/*` → Aperture (L402 required, 1 sat)
- `/api/v1/health`, `/api/v1/stats`, `/api/v1/version`, `/api/v1/openapi.json` → Express direct (free)
- `/api/v1/attestation` → Express direct (API key auth, no L402)
- `/`, `/app.js`, `/favicon.png` → Express static (free)

## 3. SatRank (Docker)

### Deploy

```bash
make deploy
# rsync -avz --exclude node_modules --exclude dist --exclude .git --exclude .env.production . root@REDACTED-SERVER-IP:/root/satrank/
```

### Start on server

```bash
ssh root@REDACTED-SERVER-IP
cd /root/satrank
docker compose up -d
```

### Verify

```bash
# Health (free, bypasses Aperture)
curl https://satrank.dev/api/v1/health

# L402-gated endpoint — should return 402
curl -i https://satrank.dev/api/v1/agents/top
# HTTP/2 402
# WWW-Authenticate: L402 macaroon="...", invoice="lnbc10n1..."

# Pay with lncli and retry
lncli payinvoice lnbc10n1...
curl -H "Authorization: L402 <macaroon>:<preimage>" https://satrank.dev/api/v1/agents/top
```

## 4. Secrets management

| Secret | Location on server | NOT in repo |
|--------|--------------------|-------------|
| API_KEY | `/root/satrank/.env.production` | .gitignore |
| LND admin macaroon | `/etc/aperture/admin.macaroon` | manual copy |
| LND TLS cert | `/etc/aperture/tls.cert` | manual copy |
| Let's Encrypt certs | `/etc/letsencrypt/` | certbot |

**Rotate API_KEY:**
```bash
NEW_KEY=$(openssl rand -hex 32)
sed -i "s/^API_KEY=.*/API_KEY=$NEW_KEY/" /root/satrank/.env.production
docker compose restart api
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

# Automated hourly backup via cron
0 * * * * cd /root/satrank && docker compose exec -T api node dist/scripts/backup.js >> /var/log/satrank-backup.log 2>&1
```

Backups are stored in `data/backups/`, with the 24 most recent retained automatically.
Each backup is verified with `PRAGMA integrity_check` after copy.
