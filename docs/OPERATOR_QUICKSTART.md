# SatRank-compatible Oracle — Operator Quickstart

This guide walks an operator through bootstrapping their own SatRank-compatible Lightning trust oracle that publishes signed Bayesian posteriors to the Nostr federation, ingests crowd-sourced outcome reports, and cross-attests with other oracles.

## Why run an oracle?

SatRank's federation is designed for sovereignty. Running your own oracle means:

- **Trust nobody, verify everything**: your agents query *your* oracle, not someone else's. The trust signal is computed against probes you control.
- **Cross-attestation**: your oracle observes other oracles' calibration history (kind 30783) and can publish your own observations of their accuracy. The web of trust grows as more oracles join.
- **Sovereign LN identity**: your oracle's `lnd_pubkey` in the kind 30784 announcement is your own LND node. Agents can verify you're not a SaaS proxy.
- **Independent revenue**: paid `/intent?fresh=true` (2 sats) flows to your wallet, not someone else's. Self-funding loop closes.

## Hardware requirements

Minimum viable :
- 2 vCPU, 4 GB RAM, 40 GB SSD (Hetzner cx21 or equivalent — ~€4/month)
- Outbound network for Nostr relays + Lightning routing
- Postgres 16 (managed or local)

Recommended (sovereign mode) :
- 4 vCPU, 8 GB RAM, 200 GB SSD (Hetzner cpx31 ~€11/month)
- Self-hosted bitcoind (mainnet) + LND with funded channels (≥ 100k sats outbound for paid probes)
- Postgres 16 dedicated (Hetzner cpx21 ~€7/month for the DB instance)

The oracle works *without* LND (no paid probes, kind 30784 published with `lnd_pubkey` absent), but the wedge of `5-stage-posterior` requires Stages 3-5 paid probes which require LND.

## Bootstrap flow

### 1. Postgres

```bash
# Hetzner / DigitalOcean / your VPS — install Postgres 16
sudo apt install postgresql-16

# Create the DB + role
sudo -u postgres psql <<EOF
CREATE ROLE satrank LOGIN PASSWORD 'change_me';
CREATE DATABASE satrank OWNER satrank;
GRANT ALL PRIVILEGES ON DATABASE satrank TO satrank;
EOF
```

### 2. LND (optional but recommended for sovereignty)

The oracle needs three macaroons :

- **Read-only** (mount in `crawler` container) — for graph crawl and queryRoutes
- **Invoice macaroon** (mount in `api` container) — for `/api/deposit` invoice creation
- **Probe-pay macaroon** (scoped: `offchain:read` + `offchain:write`, no channel ops) — for the paid probe runner

```bash
# Generate the probe-pay macaroon — sovereign mode requires it to be
# scope-limited so a compromised api/crawler container can't drain channels.
lncli bakemacaroon --save_to ./probe-pay.macaroon \
  offchain:read offchain:write
```

### 3. Nostr identity

The oracle signs all events (kind 30782 / 30783 / 30784) with a single Schnorr key. Generate it once :

```bash
node -e "import('nostr-tools/pure').then(({ generateSecretKey, getPublicKey }) => { const sk = generateSecretKey(); console.log('NOSTR_PRIVATE_KEY=' + Buffer.from(sk).toString('hex')); console.log('NOSTR_PUBLIC_KEY=' + getPublicKey(sk)); });"
```

Save both. The private key goes in `.env.production`. The public key is your `oracle_pubkey` advertised in kind 30784 — agents will use it to look up your assertions and calibrations.

### 4. Environment variables

Create `.env.production` :

```bash
# Database
DATABASE_URL=postgresql://satrank:change_me@127.0.0.1:5432/satrank

# Lightning (optional)
LND_REST_URL=https://127.0.0.1:8080
LND_MACAROON_PATH=/app/data/readonly.macaroon
LND_INVOICE_MACAROON_PATH=/app/macaroons/invoice.macaroon
LND_TIMEOUT_MS=5000

# L402 native middleware
L402_MACAROON_SECRET=<32 bytes hex — generate with `openssl rand -hex 32`>
L402_DEFAULT_PRICE_SATS=2
L402_INVOICE_EXPIRY_SECONDS=600

# Nostr federation
NOSTR_PRIVATE_KEY=<from step 3>
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net
NOSTR_MULTI_KIND_ENABLED=true

# Optional : announce contact + onboarding URL in kind 30784
ORACLE_CONTACT=nostr:npub1xxx
ORACLE_ONBOARDING_URL=https://your-oracle.example.com/onboard

# Crawler tuning (defaults are fine for most operators)
HOST_INGESTION_CAP_PER_CYCLE=50
ABSOLUTE_HOST_CAP_TOTAL=100
```

### 5. Boot

```bash
git clone https://github.com/proofoftrust21/satrank
cd satrank

# Build + start
docker compose up -d --build
```

The api comes up on `127.0.0.1:3000` (loopback only — put nginx in front for public TLS).

### 6. Verify

After ~2 hours of uptime, check the federation announcement :

```bash
curl http://localhost:3000/api/oracle/peers
# → your own oracle should appear in the peers list (self-bootstrap via kind 30784 republish)

curl http://localhost:3000/api/oracle/budget
# → revenue/spending snapshot

curl http://localhost:3000/api/oracle/peers/<your_oracle_pubkey>/calibrations
# → empty until first kind 30783 publish (~7 days post-deploy)
```

Verify on Nostr (use any client — Damus, Coracle, etc.) :

```
nostr:nevent1q... — search by your oracle_pubkey, kind 30784
```

You should see :
- A kind 30784 announcement event tagged `satrank-oracle-announcement`
- Re-published every 24h
- After 7+ days of paid probe activity : kind 30783 calibration event
- Per-endpoint kind 30782 trust assertions (for endpoints with meaningful stage_posteriors)

## Federation flow

```
Day 0   — boot, DB migrations apply (v1 → v56)
Day 0+1h — first calibration cron tick (will skip — no outcomes yet)
Day 0+90min — first trust assertion cron tick (skip if no meaningful stages)
Day 0+2h — first oracle announcement kind 30784 published
            └─ self-bootstrap : you appear in your own /api/oracle/peers
Day 0+24h — second kind 30784 announcement
Day 1-7  — paid probes accumulate, stage_posteriors grow toward meaningful threshold
Day 7+   — first non-bootstrap calibration (kind 30783) published with real deltas
Day 14+  — first kind 30782 trust assertions published (cron weekly)
Day 30+  — agents discover your oracle via kind 30784 search, query you in aggregations
```

If other SatRank-compatible oracles are running on the same relays, you discover them within 24h via the kind 30784 subscribe path — see `oracle_peers` table populating.

## Capabilities advertised

Your oracle's kind 30784 announcement carries `capabilities: [...]` describing the protocols supported. The reference implementation publishes :

- `5-stage-posterior` — Bayesian posterior decomposed into challenge / invoice / payment / delivery / quality
- `kind-30782-trust-assertion` — per-endpoint signed trust assertions (NIP-33 addressable replaceable)
- `kind-30783-calibration` — weekly published predicted-vs-observed delta history
- `kind-30784-announcement` — federation discovery
- `dvm-intent-resolve` — Nostr DVM kind 5900/6900 (sovereign agents query via Nostr-only)
- `mcp-server` — MCP `intent` + `verify_assertion` tools for Claude / ChatGPT / Cursor agents

If you fork and remove a capability, update the array. Agents that depend on a specific capability filter peers by what's announced.

## Web of trust

Once two or more SatRank-compatible oracles are live :

1. **Both subscribe to kind 30783** — each oracle observes the other's published calibration deltas.
2. **Both subscribe to kind 7402** — agents publish outcomes after consuming endpoints, all oracles ingest with Sybil-resistant weighting.
3. **Cross-attestation** (future PR-8) — each oracle compares its own delta_observed vs the peer's delta_published and publishes a meta-attestation. Agents aggregating multi-oracle responses weight peers by *agreement-with-the-consensus*, not just by self-claimed calibration.

Today the federation is "passive discovery + ingestion". The cross-attestation publishing layer is the next step.

## Operational notes

- **Logs** are JSON-line via `pino`. Default level `info`. Pipe to your log aggregator.
- **Metrics** exposed at `crawler:9091/metrics` (loopback by default — put nginx + auth in front if you want external scraping).
- **Database backups** : `npm run backup:prod` (in the api container) writes a Postgres dump. Set it up as a cron on the host.
- **Schema migrations** apply automatically on boot via `runMigrations()`. The latest version (v56) is logged in `EXPECTED_SCHEMA_VERSION` — if your DB is older the api refuses to start.
- **Channel rotation** : if you run LND, rotate macaroons every 90 days. The probe-pay macaroon is the most sensitive (signs payments).

## Paid probe activation (stages 3-5)

Paid probes are OPT-IN via `PAID_PROBE_ENABLED=true`. Without it, the
oracle ships stages 1 (challenge) + 2 (invoice) only — agents can still
read `bayesian.p_success` and `stage_posteriors` for those two stages,
but the end-to-end `p_e2e` won't include payment / delivery / quality.

To enable :

```bash
# 1. Bake + chown the probe-pay macaroon (offchain scope only)
lncli bakemacaroon offchain:read offchain:write --save_to /root/satrank/probe-pay.macaroon
chown 1001:1001 /root/satrank/probe-pay.macaroon
chmod 600 /root/satrank/probe-pay.macaroon

# 2. Add to .env.production:
PAID_PROBE_ENABLED=true
PAID_PROBE_INTERVAL_HOURS=6                 # cycles per day = 24/this value
PAID_PROBE_MAX_PER_PROBE_SATS=50            # per-invoice cap (median catalogue ~21 sats)
PAID_PROBE_TOTAL_BUDGET_SATS=150            # absolute cap per cycle
PAID_PROBE_MAX_PER_CYCLE=10                 # max endpoints probed per cycle

# 3. Recreate the crawler — the cron schedules at boot
docker compose up -d --force-recreate crawler

# 4. Confirm the cron is armed (logs at info level on boot)
docker logs satrank-crawler 2>&1 | grep "Paid probe cron scheduled"
```

The runner uses `findPaidProbeCandidates` to pick the
Pareto-80 of agent demand : recently queried via `/api/intent`, alive at
the challenge stage, not already well-sampled, under the price cap. It
self-pay-skips invoices destined to its own LND.

For the bootstrap phase only, it's reasonable to crank the caps up :
`INTERVAL_HOURS=1` (24 cycles/day) + `MAX_PER_CYCLE=20` +
`TOTAL_BUDGET_SATS=300` accumulates n_obs=5 across 80 priority
endpoints in ~1 day, then revert to cruise. Use `at` or `cron` on the
host to schedule the revert.

## Cost summary

Conservative monthly :
- Hetzner cx21 (api + crawler) : €4
- Hetzner cpx21 (Postgres) : €7
- LN routing fees with paid probes at default cruise caps (4 cycles/day
  × 10 probes × ~21 sats median + LN fees) : ~6000-12000 sats/month
  (~$2-5)
- Total : ~€12/month + capital costs (LND channels) + paid-probe budget

Self-funding break-even : the active paid-probe configuration determines
the steady-state break-even. With cruise caps (~600 sats/day spending),
~300 paid `/api/intent?fresh=true` queries/day covers it. The live
`coverage_ratio` exposed by `GET /api/oracle/budget` is the source of
truth — not a fixed estimate.

## Support

- Reference repo: https://github.com/proofoftrust21/satrank
- Reference instance: https://satrank.dev
- Nostr handler info (NIP-89): kind 31990 events tagged `d=satrank-dvm`
- Issues: https://github.com/proofoftrust21/satrank/issues

The federation grows when N≥3 independent oracles are live. If you're considering running one, the dev cost is low and the strategic upside (sovereignty + cross-attestation) is high.
