# DEPLOY.md

Production deployment guide for SatRank: a native-L402 Lightning trust oracle running on two Hetzner Cloud VMs with a full bitcoind node and a self-hosted LND.

## 1. Overview

SatRank runs its own Bitcoin (bitcoind v28.1) and Lightning (LND v0.20.1) nodes. The Express api container mints and verifies L402 macaroons natively via HMAC-SHA256; no L402 reverse proxy sits in front of it. Nginx terminates TLS and forwards to Express on loopback. Postgres 16 runs on a second VM reachable only over a Hetzner private network.

```
Internet (443 TLS)
  |
  v
nginx (VM1, 443) --> Express api (VM1, 127.0.0.1:3000)
                        |
                        +--> L402 native middleware (HMAC macaroons)
                        +--> LND v0.20.1 (VM1, gRPC 10009, REST 8080)
                        |       |
                        |       v
                        |    bitcoind v28.1 (VM1, mainnet full node)
                        |
                        +--> Postgres 16 (VM2, 5432 over private network)

crawler (VM1, Docker, same image as api)
  +--> LND graph, probes, registry
  +--> metrics on 127.0.0.1:9091
```

## 2. Architecture

Two Hetzner Cloud VMs (AMD EPYC):

- VM1 SatRank CPX32 (8 vCPU, 16 GB RAM): Docker compose (api + crawler), nginx, LND v0.20.1, bitcoind v28.1, certbot. Server ID 125533390. System disk 75 GB.
- VM2 satrank-postgres CPX42 (16 vCPU, 32 GB RAM): Postgres 16, reachable only from VM1 over Hetzner private network. Server ID 127633334. System disk 301 GB.

Hetzner Block Storage volumes attached to VM1:

- lnd-data (21 GB, mounted at /mnt/lnd-data): LND chain data, channel state, on-disk macaroons.
- bitcoin-data (1 TB, mounted at /mnt/bitcoin-data): bitcoind chainstate and blocks. Currently at 81% capacity; review quarterly, resize before 90%.

Canonical workspace on VM1: /root/satrank/. Source of truth is origin/main (git fetch && git reset --hard origin/main). Docker builds and runs from this directory. Secrets (.env.production, .macaroon files) live alongside but are excluded from git and from rsync deploys via .rsync-exclude.

## 3. Prerequisites

VM1 host packages:

- Ubuntu 22.04 LTS
- Docker 24+ with compose plugin
- nginx 1.18+
- certbot with nginx plugin
- LND v0.20.1 + bitcoind v28.1 running as systemd units (see /etc/systemd/system/bitcoind.service, lnd.service)
- Node 20+ only required if building outside Docker
- make, rsync, openssl

VM2 host packages: Postgres 16 with role `satrank`, database `satrank`, pg_hba.conf restricted to VM1 private IP.

LND macaroons (bake on VM1, not in git):

```bash
# Invoice macaroon: mints invoices via addInvoice
lncli bakemacaroon invoices:read invoices:write --save_to /root/satrank/invoice.macaroon
# Readonly macaroon: standard LND readonly.macaroon (all nine :read scopes)
cp <LND_DATA_DIR>/data/chain/bitcoin/mainnet/readonly.macaroon /root/satrank/readonly.macaroon
# Pay macaroon: outbound probe payments, offchain scope only
lncli bakemacaroon offchain:read offchain:write --save_to /root/satrank/probe-pay.macaroon
chmod 600 /root/satrank/*.macaroon
```

Secret generation (run once per fresh deploy):

```bash
openssl rand -hex 32    # L402_MACAROON_SECRET
openssl rand -hex 32    # OPERATOR_BYPASS_SECRET
openssl rand -hex 32    # API_KEY
```

## 4. First deploy

From an operator workstation with an SSH key on VM1:

```bash
git clone git@github.com:proofoftrust21/satrank.git
cd satrank

# Prepare .env.production locally using the template in docs/env.example.md.
# Transfer it manually out of band (never via rsync, never via git):
scp .env.production root@VM1:/root/satrank/.env.production
ssh root@VM1 'chmod 600 /root/satrank/.env.production'

# Push source tree to VM1 (secrets preserved by .rsync-exclude)
SATRANK_HOST=root@VM1 REMOTE_DIR=/root/satrank make deploy
```

On VM1:

```bash
cd /root/satrank
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Smoke-test the L402 gate from outside:

```bash
curl -i -X POST https://satrank.dev/api/intent \
  -H 'Content-Type: application/json' \
  -d '{"target":"<64hex>","caller":"<64hex>"}'
# Expect: HTTP/2 402, WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
```

## 5. Nginx config

Canonical file, checked into the repo: `infra/nginx/satrank.conf.l402-native`. Deploy it once on VM1:

```bash
sudo cp /root/satrank/infra/nginx/satrank.conf.l402-native /etc/nginx/sites-available/satrank.dev
sudo ln -sf /etc/nginx/sites-available/satrank.dev /etc/nginx/sites-enabled/satrank.dev
sudo certbot --nginx -d satrank.dev -d api.satrank.dev
sudo nginx -t && sudo systemctl reload nginx
```

Nginx does pure TLS termination and reverse proxy. All L402 logic (challenge minting, macaroon verification, balance deduction) runs inside Express via `src/middleware/l402Native.ts`. Nginx carries no L402 awareness: it forwards /api/* to 127.0.0.1:3000 and serves static assets from Express.

## 6. Continuous deploys

```bash
# 1. Align local tree with main
git fetch origin && git reset --hard origin/main

# 2. Rsync source to VM1 (secrets excluded via .rsync-exclude)
SATRANK_HOST=root@VM1 REMOTE_DIR=/root/satrank make deploy

# 3. Rebuild image + recreate containers (runtime code changes require rebuild)
ssh root@VM1 'cd /root/satrank && docker compose build api && docker compose up -d --force-recreate api'

# 4. Verify
curl -fsS https://satrank.dev/api/health
```

Downtime during --force-recreate is typically 5 to 10 seconds (Express cold boot plus healthcheck start_period). Rollback uses the same flow with a previous SHA: `git reset --hard <sha> && make deploy && docker compose build api && docker compose up -d --force-recreate api`.

The `.rsync-exclude` file at the repo root is authoritative. It keeps `.env*`, `data/`, `*.db`, `*.sqlite*`, `*.macaroon`, `node_modules/`, `dist/`, `.git/`, `.claude/`, `sdk/`, `python-sdk/.venv/`, logs, coverage, and IDE directories out of the payload. Read it before running any ad-hoc rsync.

## 7. Secrets management

Secrets live only in `/root/satrank/.env.production` on VM1 (chmod 600) plus the three `.macaroon` files alongside. Never in git, never in Docker images, never in rsync payloads.

| Secret | Purpose | Leak impact | Rotation |
|--------|---------|-------------|----------|
| L402_MACAROON_SECRET | HMAC seal of L402 macaroons | Forgeable macaroons, still blocked by preimage mismatch at LND | `openssl rand -hex 32`, restart api. Old macaroons become invalid (no sliding window). |
| OPERATOR_BYPASS_SECRET | X-Operator-Token header for CI and admin bypass | Unlimited free access to paid endpoints until rotation | `openssl rand -hex 32`, restart api. |
| API_KEY | Write-endpoint auth (report, attestations) | Write access to index and report ingestion | `openssl rand -hex 32`, restart api. |
| NOSTR_PRIVATE_KEY | Signs NIP-85 and NIP-05 events | Identity impersonation on relays | New keypair, refresh NIP-05 DNS, re-publish kind 10040. |
| LND invoice macaroon | Mints invoices via LND REST addInvoice for deposit and L402 challenge flows | Scope `invoices:read invoices:write`. Can mint arbitrary invoices and look up invoice status. Cannot move funds, cannot open or close channels. | `lncli bakemacaroon invoices:read invoices:write --save_to invoice.macaroon`, swap file, restart api. |
| LND readonly macaroon | Crawler graph reads and node status checks (describegraph, listchannels, getinfo) | LND default readonly.macaroon with nine `:read` scopes (address, info, invoices, macaroon, message, offchain, onchain, peers, signer). Cannot move funds, cannot bake new macaroons. | Copy LND default `readonly.macaroon` from its data directory, swap file, restart crawler. |
| LND pay macaroon | Outbound probe payments | Scope `offchain:read offchain:write`. Can initiate outbound Lightning payments up to available channel liquidity. No on-chain funds access, no channel open or close. | `lncli bakemacaroon offchain:read offchain:write --save_to probe-pay.macaroon`, swap file, restart api. |

The LND seed phrase is the operator's responsibility: stored offline, never on VM1, never in any backup that leaves the operator's physical custody. A full VM1 loss with the seed recovers channel funds via LND SCB restore (see section 10); without the seed, channel funds are lost.

Recovery backups of `.env.production` are kept as `.bak-YYYYMMDD` suffixes in the same directory. These are manual, operator-managed, never committed. Purge stale `.bak-*` files after each rotation lands.

## 8. Monitoring

Live endpoints (public, no auth):

- GET /api/health: node pubkey, block height, channel count, DB ping.
- GET /api/stats: aggregate counts (agents, transactions, reports).
- GET /api/stats/reports: Tier 1 and Tier 2 report economy metrics.

Prometheus scraping:

- api container exposes /metrics on its Express bind (127.0.0.1:3000/metrics). Loopback access is free; external access requires `X-API-Key`.
- crawler container exposes /metrics on 127.0.0.1:9091 (env `CRAWLER_METRICS_PORT`). Loopback bound, same auth rule.

Logs:

```bash
docker logs -f satrank-api --since 1h
docker logs -f satrank-crawler --since 1h
journalctl -u nginx -f
journalctl -u lnd -f
journalctl -u bitcoind -f
```

### External monitoring (BetterStack)

Four BetterStack uptime monitors check production endpoints externally and alert via email + mobile push on failure. SSL and domain expiration alerts are enabled with 14 day lead time.

- SatRank API health: GET https://satrank.dev/api/health, 3 min interval, status 200 + body contains `"status":"ok"`.
- SatRank stats endpoint: GET https://satrank.dev/api/stats, 5 min interval, status 200 + body contains `agentsIndexed`.
- SatRank L402 challenge gate: GET https://satrank.dev/api/agent/<zero-hash>, 5 min interval, status 402 expected (verifies the L402 native gate is active).
- SatRank OpenAPI spec: GET https://satrank.dev/api/openapi.json, 10 min interval, status 200 + body contains `satrank`.

Configured via the BetterStack v2 API. Monitor management lives in the BetterStack dashboard.

### Internal degradation monitor

`scripts/satrank-health-check.sh` is deployed to VM1 at `/root/satrank-health-check.sh` and runs every 5 minutes via cron. It checks the local `/api/health` endpoint for degraded states that BetterStack cannot detect from outside the API:

- `data.status` not equal to `ok`.
- `data.dbStatus` or `data.lndStatus` not equal to `ok`.
- `data.schemaVersion` drift relative to the expected schema (currently 41).
- `data.scoringStale` true.
- `data.scoringAgeSec` greater than 7200 (2h scoring loop guardrail).

On any degradation, the script sends an email via msmtp Brevo to the operator address. Logs are appended to `/root/satrank-health-check.log` (append-only, manual rotation via logrotate if it grows). Brevo delivery to ProtonMail still fails SPF silently (see section 10), so this is a best-effort backup channel; BetterStack remains the primary alerting layer.

### Cron failures (legacy)

Brevo SMTP via msmtp on VM1 also covers LND backup cron failures (see `/root/backups/lnd/backup.sh`).

## 9. Database migrations

Postgres 16 on VM2, consolidated schema at version 41. Migrations are bootstrapped idempotently at api container start from `src/database/migrations.ts` using `src/database/postgres-schema.sql` as the source of truth. There is no manual migration step during continuous deploys.

For forward migrations in new phases, edit `src/database/migrations.ts`, increment `CONSOLIDATED_VERSION`, add ALTER statements in the sequence block. `src/tests/migrations.test.ts` validates replay from v1. On deploy, the api container runs migrations before accepting traffic.

Postgres backups: Hetzner Cloud Backups on VM2 (server ID 127633334), daily snapshot with 7-day rotation. No pg_dump cron layer at this time; recovery goes through the Hetzner console (snapshot to new VM or in-place restore). See section 11 for the single-provider consideration.

## 10. Backup strategy

Four independent layers:

1. LND SCB (channel.backup): cron on VM1 at `/root/backups/lnd/backup.sh` runs daily at 06:00 UTC, writes a timestamped channel.backup file, retains 90 days locally on VM1. Mirrored daily to an operator local Mac via launchd plus rsync pull over SSH (read-only, no push path). SCB plus seed equals full channel recovery.
2. Hetzner Cloud Backups on VM1 (server ID 125533390): daily auto-snapshot, 7-day rotation. Captures the root filesystem and attached Block Storage volumes, including .env.production and macaroons in place.
3. Hetzner Cloud Backups on VM2 (server ID 127633334): daily auto-snapshot, 7-day rotation. Captures the Postgres data directory.
4. LND seed phrase: offline, operator-held, never on infrastructure. Without the seed, no layer above can recover channel funds.

bitcoind chainstate is intentionally not backed up. A full VM1 loss triggers IBD from the P2P network (roughly 24 to 48 hours for a fresh 1 TB chainstate). Chainstate is reproducible from network consensus.

## 11. Troubleshooting and known operational risks

Common issues:

- /api/health returns 503: check `docker compose ps` for api container state, then `docker logs --tail 100 satrank-api` for boot errors (missing env, LND unreachable, Postgres down).
- 402 response missing the `invoice` field: `L402_MACAROON_SECRET` unset or the LND invoice macaroon missing. Check `docker logs satrank-api | grep -i l402`.
- Scoring pipeline stalls: inspect crawler /metrics for a flat `scored_total` counter. Restart: `docker compose restart crawler`.

Known operational risks:

- LND graph breaker carve-out depends on string matching against LND v0.20.1 error surfaces. Any LND upgrade requires re-validating the regex set in `src/lnd/lndGraphClient.ts`.
- Single-host SPOF on VM1: nginx, api, crawler, LND, bitcoind all co-located. No hot standby. RTO for a full VM1 loss is bounded by Hetzner snapshot restore (typically 20 to 40 minutes) plus bitcoind IBD when the chainstate volume is the loss.
- /mnt/bitcoin-data at 81% capacity. Review quarterly; resize the Block Storage volume before the 90% threshold.
- Postgres backups depend on a single provider (Hetzner Cloud Backups). A Hetzner outage during a recovery window leaves no fallback. An offsite pg_dump is a known gap.
- Brevo SMTP alerts to ProtonMail fail SPF silently. Treat email as best-effort and rely on Prometheus plus manual health checks.

## 12. rsync safety and incident history

### Mechanical rule

Every deploy must go through `make deploy`. Never an ad-hoc `rsync` against prod. Exclusions are centralized in `.rsync-exclude` at the repo root, and the Makefile refuses to deploy if that file is missing.

### Files that must never be erased by rsync

These are never in git and must be preserved across every deploy.

- Environment secrets: `.env.production`, `.env`, `.env.local`, `.env.*.local`
- LND macaroons: `probe-pay.macaroon`, `admin.macaroon`, `invoice.macaroon`, `readonly.macaroon`, pattern `*.macaroon`
- Runtime state: `data/`, `*.db`, `*.sqlite*`, `backups/`

The `.rsync-exclude` file at the repo root enforces these exclusions. Read it before any ad-hoc rsync.

### Incident history

| Date | Phase | File erased | Root cause |
|------|-------|-------------|------------|
| 2026-04-19 | Phase 7 | .env.production | Ad-hoc rsync --delete, exclusion forgotten |
| 2026-04-20 | Phase 9 | probe-pay.macaroon | Ad-hoc rsync --delete, exclusion forgotten |

Both incidents are the same procedural fault: bypassing `make deploy` for a manual rsync. This section is the written rule that makes that bypass illegal.
