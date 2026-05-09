# SatRank

Lightning trust oracle for AI agents on L402. Bitcoin-pure.

## What this does

- **Crawls** the L402 ecosystem (l402.directory + RSS + DNS) to build a catalogue of paid endpoints.
- **Probes** each endpoint, classifying outcomes across 5 stages: challenge / invoice / payment / delivery / quality.
- **Scores** every (endpoint, stage) pair as a streaming Beta(α, β) posterior. The end-to-end success probability is the product of stage means.
- **Ranks** candidates on `POST /api/intent` (paid 2 sats via L402): an agent passes a category + budget + SLA, gets back the top-K endpoints with full Bayesian breakdown.
- **Publishes** signed Nostr trust assertions (kind 30782) so any agent can cache / verify SatRank's output offline.

## Public endpoints

```
GET  /                                 landing page (static HTML)
POST /api/intent                       paid, 2 sats via L402
POST /api/deposit                      free, mint a multi-use deposit macaroon (10–10000 sats, 30-day TTL)
GET  /api/deposit/:macaroon_id         free, read remaining balance
GET  /api/services/:url_hash           free, per-endpoint score snapshot
GET  /api/services/categories          free, list of catalogue categories
GET  /api/services/best                free, top-3 per category
GET  /api/oracle/budget                free, last 24h revenue + paid-probe spend
GET  /health
GET  /.well-known/satrank-key          oracle pubkey for offline verify
```

Deposit macaroons let an agent pre-pay N sats once and use the bearer
preimage across many `/api/intent` calls without a Lightning round-trip
per call. `Authorization: L402 deposit_<id>:<preimage_hex>`.

## MCP

Three tools for any MCP-compatible AI runtime (Claude Code, Cursor, Codex, n8n):

```
intent              forwards POST /api/intent (paid)
get_endpoint_score  forwards GET /api/services/:url_hash (free)
verify_assertion    offline Schnorr verification of kind 30782 (no network)
```

Install in Claude Code:

```bash
claude mcp add satrank -- npx -y satrank-mcp
```

Self-hosters point `SATRANK_API_BASE` at their own deployment.

## Architecture

14 source files + 1 HTML landing. Read top-to-bottom in 30 minutes.

```
src/
├── types.ts        Stage, Posterior, Endpoint, Observation
├── config.ts       zod env schema, parsed once at boot
├── logger.ts       JSON-line stdout
├── db.ts           pg Pool + idempotent schema bootstrap
├── schema.sql      9 tables in ONE file (no migrations folder)
├── lnd.ts          minimal LND REST client (addInvoice + payInvoice)
├── ssrf.ts         RFC1918 + link-local + IPv6 ULA URL guard
├── nostr.ts        kind 30782 sign + publish + offline verify
├── scoring.ts      Beta(α,β) per stage, Wilson CI95, ranker
├── probe.ts        HTTP probe with optional L402 pay
├── crawler.ts      l402.directory + RSS + DNS + cron
├── api.ts          Express, 9 routes, native L402 paid gate, deposit credits
├── mcp.ts          MCP server, 3 tools, ships verbatim to npm
├── landing.html    static landing served at GET /
└── index.ts        boot + shutdown
```

## Run it

```bash
cp .env.example .env
# minimum: set DATABASE_URL

npm install
npm run build
npm start
```

For paid probes + paid `/api/intent` gate, set `LND_REST_URL` + `LND_MACAROON_HEX` + `L402_MACAROON_SECRET`. For Nostr trust assertions, set `NOSTR_PRIVATE_KEY`.

## Scoring math

For each (endpoint, stage), maintain a Beta(α, β) posterior with α₀ = β₀ = 1 (uniform prior). On every observation:

- success → α += 1
- failure → β += 1

Stage mean: α / (α+β). 95% credible interval via Wilson (closed-form). End-to-end success: ∏ stage_means across the 5 stages, assuming stage independence.

`is_meaningful` is true iff the **challenge** stage has at least `MEANINGFUL_N_OBS_MIN` observations. The challenge stage is observed on every probe (free or paid), so its n_obs converges fastest. p_e2e remains the honest end-to-end product separately.

## License

AGPL-3.0
