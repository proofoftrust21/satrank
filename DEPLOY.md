# DEPLOY.md

Production deployment guide for SatRank V3.

## 1. Overview

SatRank V3 runs as a single Express container on one host, fronted by nginx
for TLS, with PostgreSQL 16 on a separate VM reachable over a private network.
LND is optional; without it, paid `/api/intent` and `/api/deposit` return
`503 L402_NOT_CONFIGURED` and the service is read-only.

```
Internet (443 TLS)
  │
  ▼
nginx (VM1, 443) ──▶ Express api (VM1, 127.0.0.1:3000)
                       │
                       ├──▶ L402 native middleware (HMAC macaroons + LND)
                       ├──▶ LND v0.18+ REST  (VM1, addInvoice + payInvoice)
                       └──▶ PostgreSQL 16    (VM2, 5432, private network)

crawler (in-process cron, every 15 min) ──▶ l402.directory + RSS + DNS TXT
```

No reverse-proxy L402 layer (no Aperture). No fulfill proxy. No AEPS audit
chain. The container is the entire surface — see `README.md` for the
14-source-file architecture.

## 2. Prerequisites

- A VM with Docker + Docker Compose v2 (Ubuntu 22.04 / 24.04 tested).
- A reachable PostgreSQL 16 with a database + user for SatRank.
- A TLS-enabled reverse proxy (nginx + Let's Encrypt assumed below).
- Optional but recommended for paid routes:
  - An LND v0.18+ node, REST enabled.
  - A baked macaroon with `invoices:read invoices:write offchain:read offchain:write`
    scopes (covers `addInvoice` for /api/deposit + /api/intent challenge, plus
    `payInvoice` for paid probes and self-pay testing).

## 3. First deploy

From an operator workstation with SSH access to VM1:

```bash
git clone https://github.com/proofoftrust21/satrank
cd satrank

# 1. Prepare secrets locally; transfer .env.production manually out of band.
cp .env.example .env.production
$EDITOR .env.production   # set DATABASE_URL, L402_MACAROON_SECRET, LND_*, NOSTR_PRIVATE_KEY

scp .env.production root@VM1:/root/satrank/.env.production

# 2. Bake the LND macaroon and copy to VM1.
lncli bakemacaroon \
  --save_to lnd-macaroon.macaroon \
  invoices:read invoices:write offchain:read offchain:write
scp lnd-macaroon.macaroon root@VM1:/root/satrank/fulfill.macaroon

# 3. Push source tree (secrets excluded via .rsync-exclude).
SATRANK_HOST=root@VM1 REMOTE_DIR=/root/satrank make deploy

# 4. First boot.
ssh root@VM1 "cd /root/satrank && docker compose build api && docker compose up -d api"

# 5. Sanity check.
curl -sf https://your.domain/health
curl -sI -X POST https://your.domain/api/intent \
  -H 'Content-Type: application/json' \
  -d '{"category":"data"}'
# Expect HTTP/2 402, WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
```

## 4. nginx config

Source of truth: `infra/nginx/satrank.conf`. Apply:

```bash
ssh root@VM1
cp /root/satrank/infra/nginx/satrank.conf /etc/nginx/sites-enabled/satrank
nginx -t && systemctl reload nginx
```

The config is one server block: TLS 1.2/1.3 only, modern ciphers, security
headers (HSTS, X-Frame-Options DENY, etc.), client_max_body_size 16k, and a
catch-all `location /` proxy to Express on `127.0.0.1:3000`. No path-specific
locations — Express owns the routing table.

## 5. Continuous deploys

```bash
# 1. Align local tree with main
git pull origin main

# 2. Push to VM1 (.env.production preserved via .rsync-exclude)
SATRANK_HOST=root@VM1 REMOTE_DIR=/root/satrank make deploy

# 3. Rebuild + recreate (runtime code changes need a rebuild)
ssh root@VM1 "cd /root/satrank && docker compose build api && docker compose up -d --force-recreate api"

# 4. Verify
curl -sf https://your.domain/health && echo OK
```

## 6. Secrets management

`.env.production` is the only piece never tracked by git (excluded via
`.rsync-exclude` and `.dockerignore`). Required values:

| Var | Why |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `L402_MACAROON_SECRET` | 32-byte hex; HMAC seal for L402 macaroons |
| `LND_REST_URL` | https URL of LND REST (e.g. `https://lnd:8080`) |
| `LND_MACAROON_PATH` | path inside container to the macaroon (e.g. `/app/macaroons/fulfill.macaroon`) |
| `LND_TLS_CERT_PATH` | LND TLS cert path |
| `NOSTR_PRIVATE_KEY` | 32-byte hex; signs kind 30782 trust assertions |

Optional tunings (defaults in `src/config.ts`):

| Var | Default | Notes |
|---|---|---|
| `L402_INTENT_PRICE_SATS` | 2 | Price per /api/intent call |
| `CRAWLER_INTERVAL_SEC` | 900 | Crawl + probe cadence (15 min) |
| `MEANINGFUL_N_OBS_MIN` | 3 | Threshold for `is_meaningful` |
| `PAID_PROBE_ENABLED` | false | Opt-in: pay invoices during probes |
| `PAID_PROBE_DAILY_BUDGET_SATS` | 2000 | Hard ceiling on paid-probe spend / day |
| `PROBE_MAX_INVOICE_SATS` | 1000 | Refuse to pay invoices priced above this |
| `PROBE_FETCH_TIMEOUT_MS` | 15000 | Probe HTTP timeout |
| `NOSTR_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://nostr.mom` | Comma-separated |

Recovery copies of `.env.production` are kept locally as `.bak-YYYYMMDD`
suffixes — manual, operator-managed, never committed. Purge stale `.bak-*`
files after each rotation.

## 7. Monitoring

V3 ships no proprietary monitoring stack. Use what you have. Bare minimum:

- An external uptime check on `https://your.domain/health` (5-min interval).
- A liveness check on the container: `docker ps` + Docker `HEALTHCHECK`
  configured in the Dockerfile (curl /health).
- A glance at `docker logs satrank-api -f` during deploy windows.

The `/api/oracle/budget` endpoint exposes 24-hour revenue + paid-probe spend
publicly — useful as a transparency feed and as a self-test (if revenue is
zero for several days while you expect calls, something is broken upstream).

## 8. Database

V3 uses a single `src/schema.sql` file (9 tables). On boot, `db.ts` runs the
file with `CREATE TABLE IF NOT EXISTS` — idempotent. Retroactive ALTERs for
older instances are wrapped in `DO $$ BEGIN ... END $$` guards.

There is no migrations folder. New columns / constraints are added in-place
in `schema.sql` with a guard. Schema changes ship with the code in the same
commit and apply on the next container boot.

Backups: a daily `pg_dump` of the `satrank` database to off-VM storage is
sufficient. Restoration is a plain `psql < dump.sql` against an empty DB.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503 L402_NOT_CONFIGURED` on /api/intent | LND unreachable or macaroon missing | Verify `LND_REST_URL`, `LND_MACAROON_PATH`, mount + chown 1001:1001 the macaroon |
| `400 INVALID_PAYLOAD` | Body fails Zod | Check the issue list in the response — usually a type mismatch |
| `429 RATE_LIMITED` | Hit 120/min global or 30/min /api/intent | Honor `RateLimit` header; exponential backoff |
| Container loops "DATABASE_URL Required" | `.env.production` not loaded by docker-compose | Verify `env_file` line in `docker-compose.yml` and file existence on host |
| Crawler returns 0 endpoints | l402.directory format change | Check logs `crawler: ...`; the parser is in `src/crawler.ts` (one file, easy to fix) |

## 10. rsync safety

`.rsync-exclude` keeps `.env.production`, `*.macaroon`, `node_modules`, `.git`,
and a few other local-only paths off the wire. Verify before any `make deploy`
that nothing critical is missing on the destination — a deploy that overwrites
`.env.production` is the documented way to lose the LND macaroon path.

`make deploy` chowns macaroons back to uid 1001:1001 after rsync (rsync
preserves the operator's local UID, which doesn't exist on the VM). Without
this step, the container fails at boot with `EACCES`.
