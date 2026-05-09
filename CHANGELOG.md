# Changelog

V3 is a from-scratch rewrite (May 2026). Earlier releases (V1 0.x–1.x and the
V2 restructure branch) are archived in git history. The V3 line is the only
thing currently maintained or supported.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [3.0.3] — 2026-05-09

### Added
- `GET /api` — HTTP API reference page (static HTML, no JS).
- `GET /openapi.json` — OpenAPI 3.0.3 machine-readable spec (9 paths, 12 schemas).
- 301 aliases for backlink continuity: `/docs`, `/docs.html`, `/api/docs` → `/api`.

## [3.0.2] — 2026-05-09

### Added
- `GET /methodology` — full technical reference page (16 sections, ~26 KB, no JS).
- 301 alias `/methodology.html` → `/methodology`.

### Removed
- `public/` directory (V1 fossil: index.html, methodology.html, docs.html, swagger-*, logo.png, favicon.png, app.js, styles.css). 12 files, ~1.8 MB.

## [3.0.1] — 2026-05-09

### Added
- `GET /` — static landing page (no JS, ~5 KB) replacing the previous 404.
- `POST /api/deposit` + `GET /api/deposit/:macaroon_id` — multi-use credit primitive: pre-pay 10–10000 sats once, spend across many `/api/intent` calls without a Lightning round-trip per call. 30-day TTL.
- `agent_credits` table (Postgres). Atomic `UPDATE … RETURNING` decrement.
- nginx config simplified (drop 6 V1 dead locations).
- Security audit hardening (`f22235b`): SSRF guard, L402 single-use, timing-safe HMAC, rate limits 120/min global + 30/min on /api/intent, body cap 256 KB on probes, security headers (HSTS, X-Frame-Options DENY, etc.), schema CHECK on http_method.

## [3.0.0] — 2026-05-08

### Added
- Complete rewrite: 14 source files, ~1600 LOC, 9 Postgres tables.
- 9 functional HTTP routes: `POST /api/intent` (paid 2 sats via L402), `GET /api/services/:url_hash`, `GET /api/services/categories`, `GET /api/services/best`, `GET /api/oracle/budget`, `GET /health`, `GET /.well-known/satrank-key`.
- 3 MCP tools: `intent`, `get_endpoint_score`, `verify_assertion`.
- Bayesian Beta(α,β) per (endpoint, stage), 5 stages (challenge / invoice / payment / delivery / quality), Wilson CI95 closed-form.
- Native L402 paid gate (HMAC-signed macaroon, single-use via revenue_log).
- Crawler: l402.directory + RSS + DNS TXT, every 15 min.
- Nostr kind 30782 trust assertions (Schnorr-signed, NIP-33 addressable replaceable).
- npm publish `satrank-mcp@3.0.0`.
- Production deployed at `https://satrank.dev`.

### Removed (vs V2)
- Fulfill proxy (custodial L402 pay-on-behalf).
- AEPS audit chain (Ed25519 evidence receipts, daily L1 anchor, dispute resolution).
- Mini-LLM gateway (proxy-to-Anthropic L402 endpoints).
- Operator hierarchy + claims.
- Federation (kind 30784 announcements, peer-oracle calibration ingest).
- Calibration history publication (kind 30783).
- Crowd outcome reports (kind 7402).
- NIP-90 DVM transport.
- Python and TypeScript SDK packages (`@satrank/sdk`, `satrank` on PyPI).
- 24 of the previous 27 MCP tools (kept the 3 minimal ones above).
- ~63 000 LOC, 30 Postgres tables, schema migration framework.

V3 is a deliberate compression: trust oracle, Bitcoin-pure, nothing more.
