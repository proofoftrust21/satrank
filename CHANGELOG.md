# Changelog

All notable changes to the SatRank HTTP API (`satrank.dev`) and the SatRank
SDKs (`@satrank/sdk` and `satrank`) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/). The HTTP
API and each SDK are versioned independently; entries are prefixed with
`API`, `SDK-TS`, or `SDK-PY` when scope is not obvious.

## [API + SDK-TS + Federation] - 2026-04-28

Major non-breaking expansion of the oracle surface. PR-1 → PR-7 cumulative.

### Added (API)

- 5-stage L402 contract decomposition (Phase 5.10A → 5.14). Each candidate in `POST /api/intent` carries an optional `stage_posteriors` block decomposing the request into 5 independent Beta posteriors (challenge / invoice / payment / delivery / quality). Composed `p_e2e = ∏ p_i` over meaningful stages. `IntentCandidate.http_method` (`'GET' | 'POST'`) persisted from the upstream registry.
- Calibration moat (Phase 5.15). Weekly cron publishes a kind 30783 Nostr event signed by the oracle, carrying `delta_mean` / `delta_median` / `delta_p95` between predicted and observed success rates over a rolling 7-day window. Top 20 per-endpoint deltas embedded in event content.
- Transferable trust assertions (Phase 6.2 + 6.3). Per-endpoint kind 30782 NIP-33 addressable replaceable events published weekly. New endpoint `GET /api/oracle/assertion/:url_hash` returns the metadata + BOLT12 TLV embedding hint (type 65537 = event_id, type 65538 = oracle_pubkey).
- Self-funding loop tracking (Phase 6.4). New endpoint `GET /api/oracle/budget` exposes lifetime + 30d + 7d snapshots of revenue vs spending with `coverage_ratio`. Anti-double-revenue dedup via partial UNIQUE index on payment_hash.
- Idempotent intent cache (Phase 6.5). LRU + TTL 60s in front of `/api/intent`. fresh=true bypasses.
- Federation discovery (Phase 7.0 → 8.0). Daily kind 30784 announcement (`oracle_pubkey`, `lnd_pubkey`, `catalogue_size`, `calibration_event_id`, `capabilities`). Permanent subscribe ingests other oracles. New endpoint `GET /api/oracle/peers`.
- Cross-oracle calibration ingestion (Phase 9.1). Permanent subscribe to kind 30783 from peers. New endpoint `GET /api/oracle/peers/:pubkey/calibrations`.
- Crowd outcome reports (Phase 8.1 + 8.2 + 9.0). Kind 7402 events from any agent. Sybil-resistant ingestion: `weight = base × pow_factor × identity_age_factor × preimage_factor` (max ~2.4, ≈ paid probe weight). 1h anti-spam delay before consolidation.
- Agent-native MCP server tools (Phase 6.0). `intent` (proxies POST /api/intent) + `verify_assertion` (offline Schnorr + valid_until + calibration_proof verification of kind 30782 / 30783). For Claude / ChatGPT / Cursor / Alby integrations.
- DVM intent-resolve (Phase 6.1). Extended NIP-90 DVM (kind 5900/6900) to handle `j: intent-resolve` jobs. Sovereign agents publish intent JSON via Nostr, oracle replies kind 6900.

### Added (SDK-TS 1.1.0)

- `IntentCandidate.http_method` and `IntentCandidate.stage_posteriors` exposed on the candidate type. `fulfill()` defaults to `candidate.http_method` when `opts.request.method` is not set, eliminating the silent 405-fallback round-trip on POST-only endpoints.
- `aggregateOracles({ baseUrl, maxStaleSec, minCatalogueSize, requireCalibration, minAgeSec })` — federation aggregation primitive. Discovers peers via `GET /api/oracle/peers`, filters by agent's trust criteria.
- Backwards-compatible: 1.0.x consumers keep behavior unchanged.

### Security

Audit fixes (security-reviewer agent + manual targeted audit) :
- C1 SSRF via `SATRANK_API_BASE` → centralized validation in `config.ts` (https-only sauf localhost)
- C2 PoW bypass via short hex → `countLeadingZeroBits` enforce strict 64-char
- C3 memory exhaustion via unbounded `resp.text()` → streaming reader with cap (1MB MCP, 64KB paid probe)
- H1 revenue double-logging race → migration v56 partial UNIQUE index on payment_hash
- H2 `onPaidCallSettled` DB pool starvation → `Promise.race` 3s timeout
- H3 `onboarding_url` phishing → https-only validation, javascript:/data:/http: rejected
- H4 consolidation cron double-write → `FOR UPDATE SKIP LOCKED` + transaction
- H5 `latency_ms` overflow → clamp [0, 300_000ms]
- H6 `catalogue_size` overflow → clamp [0, 1_000_000]
- M3 dedup Map unbounded → 50k FIFO eviction cap
- M5 `selfPubkey` case bypass → lowercase compare both sides
- 11 new regression tests labelled `Security X#`

### Operator quickstart

`docs/OPERATOR_QUICKSTART.md` — bootstrap guide for any operator joining the federation. Hardware tiers, Postgres + LND macaroons, Nostr identity generation, env vars, federation timeline (Day 0 → Day 30+), economic break-even (~17 fresh queries/day).

### Migrations

9 new schema migrations (v48 → v56) :
- v48 `http_method` on service_endpoints
- v49 `endpoint_stage_posteriors` hub
- v50 outcomes log + `oracle_calibration_runs`
- v51 `oracle_revenue_log`
- v52 `trust_assertions_published`
- v53 `oracle_announcements_published` + `oracle_peers`
- v54 `crowd_outcome_reports` + `nostr_identity_first_seen`
- v55 `consolidated_at` + `peer_calibration_observations`
- v56 anti-double-revenue `payment_hash` UNIQUE

### Tests

- 1451/1451 server tests green (TypeScript strict + tsconfig.tests strict typecheck both clean)
- 139/139 SDK tests green
- 11 new regression tests on security audit findings

## [Maintenance] - 2026-04-26

### Fixed

- Server `package-lock.json`: `postcss` bumped from 8.5.8 to 8.5.10 (closes [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), CVE-2026-41305, dev-only via `vitest@3.2.4 -> vite@6.4.2 -> postcss`). Lockfile-only change, zero source diff.

### Known dev/runtime debt (audited, non-exploitable in our usage)

After explicit review of the four remaining open Dependabot alerts:

- **GHSA-w5hq-g745-h8pq (uuid <14.0.0, server runtime, direct, medium)**. CVE triggers only when callers pass an external `buf` argument to `v3/v5/v6`. SatRank uses `import { v4 as uuid } from 'uuid'` in 17 files (3 src, 14 tests/scripts) and always calls the default form `uuid()` with no buffer. Not reachable. Bumping to v14 is a semver-major change deferred to a focused dependency phase post-announce.
- **GHSA-848j-6mx2-7j84 (elliptic <=6.6.1, server runtime, transitive, low)**. Pulled in only via `bolt11@1.4.1 -> secp256k1@4.0.4 -> elliptic`. The `bolt11` package is used in `src/` exclusively for invoice **decoding** (read-only parsing); all production payment signing happens inside LND (Go binary, `btcd/btcec`), not in JS. `bolt11.sign` only appears in test fixtures with throwaway keys. The CVE requires the attacker to obtain both a faulty and a correct ECDSA signature for the same input under the same private key, which our code path never produces. **No patched version exists upstream.**
- **GHSA-4w7w-66w2-5vf9 (vite <=6.4.1, sdk dev, transitive via vitest@1.6.1, medium)**. dev-only on the SDK package. Path-traversal in vite dev server `.map` handling, only exploitable when running `vitest --ui` or `vite dev` with `--host` exposing the server to the network. SatRank CI / local dev uses `vitest run` (no dev server, no `--host`). The published `@satrank/sdk` tarball ships only `dist/`, `README.md`, and `LICENSE` — vite is never installed by SDK consumers.
- **GHSA-67mh-4wv8-2f99 (esbuild <=0.24.2, sdk dev, transitive via vitest@1.6.1, medium)**. Same chain as vite. esbuild dev-server CORS issue, never invoked in our test pipeline (`vitest run` doesn't start an esbuild dev server). Same shipping argument: not in the consumer tarball.

For the SDK consumer surface, `cd sdk && npm audit --omit=dev` reports **0 vulnerabilities**.

For the server runtime, `npm audit --omit=dev` reports 4 (1 medium uuid + 3 low elliptic chain). Both are documented above as not reachable in the executed code paths.

A focused dependency-bump phase will land post-announce to upgrade vitest 1.x -> latest on the SDK and uuid 11 -> 14 on the server (both behind major-bump risk; deserve their own PR + soak time, not a metadata patch release).

## [SDK] - 2026-04-26

### Fixed

- `@satrank/sdk` v1.0.2 published: removed em-dash from npm `description` (publishable metadata polish, no code change).
- `satrank` v1.0.2 published: removed em-dash from PyPI `description`. Republishing also fixes the stale `Repository` URL in PyPI sidebar (1.0.1 was published before the URL fix landed in `pyproject.toml`); 1.0.2 now points to `github.com/proofoftrust21/satrank`.
- Em-dash and en-dash characters scrubbed from `docs/MIGRATION-TO-1.0.md`, `docs/sdk/quickstart-ts.md`, `docs/sdk/quickstart-python.md`, and the `vitest` debt note in this file.
- Stale `[1.0.0-rc.1]` link target corrected from `github.com/orsonio/satrank` to `github.com/proofoftrust21/satrank`.

## [Infrastructure] - 2026-04-24

### Removed

- `apertureGateAuth` middleware and every remaining Aperture reference across source code, tests, config, nginx, and docs. Aperture L402 reverse proxy was sunset 2026-04-23 (Phase 14D.3.0); the L402 gate has run natively in Express (`src/middleware/l402Native.ts`) for 9 days without regression.
- `APERTURE_SHARED_SECRET` environment variable (schema, prod validation, dev guard, `.env.example`, `docs/env.example.md`, `DEPLOY.md` secrets table). `OPERATOR_BYPASS_SECRET` is the only remaining operator bypass secret.
- `PaymentRequiredError` error class (unused after `apertureGateAuth` removal).
- `infra/nginx/satrank.conf.l402-native` (promoted to the canonical `infra/nginx/satrank.conf`).
- `scripts/cutover-l402-native.sh` and `scripts/rollback-l402-native.sh` archived to `docs/archive/phase-14d/` (one-shot migration scripts, no longer runnable).
- On VM1: `aperture.service` systemd unit, `/usr/local/bin/aperture` Go binary (75 MB), `/root/.aperture/` data directory (`aperture.db` 612 KB + `aperture.log` 9 MB), and `/root/aperture-sunset-backup-20260423-194945/` snapshot (644 KB).

### Changed

- Route factory defaults (`src/routes/{agent,attestation,v2}.ts`) use `noopMiddleware` instead of `apertureGateAuth`. `app.ts` always passes `createL402Native` explicitly; the default only affects test fixtures.
- `infra/nginx/satrank.conf` is now the single canonical nginx config (L402 native gate). Deploy command updated.
- `infra/nginx/README.md` rewritten to describe nginx as a simple reverse proxy.
- Comments and test descriptions across `src/middleware/`, `src/utils/`, `src/controllers/`, and `src/tests/` scrubbed of Aperture vocabulary; `X-Aperture-Token` header references replaced by `X-Operator-Token`.

## [Maintenance] - 2026-04-24

### Removed

- `sdk/satrank-sdk-1.0.0-rc.1.tgz` artifact. Superseded by npm publish 1.0.0+1.0.1; fetch from npm now.

### Fixed

- `python-sdk/pyproject.toml` `Repository` URL corrected to `github.com/proofoftrust21/satrank`.

### Known debt

- `vitest` 1.x moderate severity audit warnings on TS SDK devDependencies (vite/vite-node/esbuild transitive chain). Runtime consumer bundle unaffected: `npm audit --production` reports 0 vulnerabilities, and `files: [dist/, README.md, LICENSE]` excludes dev deps from the published tarball. `vitest` v2 upgrade planned separately (breaking config refactor).

## [SDK] - 2026-04-24

### Added

- `@satrank/sdk` v1.0.1 published to the npm registry (https://www.npmjs.com/package/@satrank/sdk).
- `satrank` v1.0.1 published to PyPI (https://pypi.org/project/satrank/1.0.1/).

Both SDKs provide the high-level `sr.fulfill(intent, budget)` interface along with lower-level access to all public endpoints. See `docs/MIGRATION-TO-1.0.md` for usage. Patch bump from 1.0.0 to avoid a version clash with the existing registry entries; no behavioral change relative to the 1.0.0 tarballs shipped in-tree.

## [API 1.1.0] - 2026-04-23

### Added

- `GET /api/deposit/tiers`: public tier catalog. Five tiers, rates 1.0 / 0.5 / 0.2 / 0.1 / 0.05 sat/request, minimum deposits 21 / 1,000 / 10,000 / 100,000 / 1,000,000 sats.
- `POST /api/probe`: paid on-demand L402 endpoint probe with full telemetry, 5 credits per call.
- `POST /api/operator/register`: NIP-98 authenticated operator claim.
- `GET /api/operators` and `GET /api/operator/:id`: public operator directory.
- Phase-1 deposit response surfaces `tierId`, `rateSatsPerRequest`, `discountPct`, and `quotaGranted`, so agents do not need a second round-trip to learn their tier.
- Tiered pricing for deposits: `amount >= 21` maps to tier 1 (1.0 sat/req), `>= 1000` to tier 2 (0.5), `>= 10000` to tier 3 (0.2), `>= 100000` to tier 4 (0.1), `>= 1000000` to tier 5 (0.05). The rate is locked into the macaroon when the invoice settles.

### Changed

- `POST /api/deposit`: cap raised from 10,000 to 1,000,000 sats to support tiers 4 and 5.
- OpenAPI `BayesianScoreBlock` schema descriptions translated to English for consistency.
- OpenAPI `reputation` component replaced legacy `lnplusRank` / `hubnessRank` / `betweennessRank` fields with `pageRank` as the primary centrality signal.
- OpenAPI `securityScheme` description rewritten to reflect the tiered L402 model.

### Removed

- `POST /api/attestation` legacy alias. Use `POST /api/attestations` instead.
- `GET /api/top` legacy redirect. Use `GET /api/agents/top` instead.
- `SurvivalResult` schema and the `survival` field on `/api/agent/:hash` responses (Phase 12C sunset).
- LN+ centrality signals from the reputation decomposition. Replaced by sovereign PageRank.

### Fixed

- Registry crawler: bug where `service_price_sats` was never populated on newly discovered L402 endpoints (Phase 13D). 139 of 172 endpoints now carry a price after backfill; the remaining 33 are classified as provider-side outages and auto-recover via cron.
- LND circuit breaker: narrow carve-out so malformed BOLT11 strings emitted by providers do not trip the breaker and cause collateral skips on unrelated graph queries.
- Per-host rate limiter in crawlers: 500 ms minimum interval per distinct host prevents collateral damage when one provider is slow.

### Documentation

- Corrected misleading references in README.md and IMPACT-STATEMENT.md that implied a server-side `POST /api/fulfill` endpoint. `sr.fulfill()` is a client-side SDK helper. The server exposes `POST /api/intent`, and the L402 flow happens directly against the selected provider's endpoint. SatRank never custodies sats and never sees the preimage.

## [SDK-TS 1.0.0] - 2026-04-22

### Added

- Zero-dependency TypeScript SDK published on npm as `@satrank/sdk@1.0.0` (41 KB unpacked).
- `sr.fulfill(intent, budget)`: one-call convenience over `POST /api/intent` plus the client-side L402 payment flow against the selected provider.
- Wallet abstraction: any object exposing `pay(invoice) -> { preimage, paymentHash }` works. LND gRPC, NWC, and LNURL-pay adapters included.
- MIT license.

## [SDK-PY 1.0.0] - 2026-04-22

### Added

- Python SDK published on PyPI as `satrank==1.0.0`.
- `sr.fulfill(intent, budget)` with the same client-side flow as the TypeScript SDK.
- Production / Stable classifier, Python >= 3.10, MIT license.

## [Infrastructure] - 2026-04-23

### Changed

- L402 gate middleware is now served natively by Express (`src/middleware/l402Native.ts`). The Aperture reverse proxy (lightninglabs/aperture) that previously handled 402 challenges has been retired.
- nginx configuration simplified: paid routes proxy directly to Express on 127.0.0.1:3000 instead of routing through Aperture on 127.0.0.1:8082.
- Macaroon format changed from Aperture native to HMAC-SHA256 with v1 JSON payload. Macaroons issued by Aperture before this date are no longer accepted; clients retry and receive a fresh 402 challenge.
- Operator admin bypass header renamed from `X-Aperture-Token` to `X-Operator-Token`. Same functional behavior.

### Removed

- Aperture systemd service on the production VM.
- Aperture SQLite database. Token state already lived in Postgres after the Phase 12B migration.

### Rationale

- Simpler stack, fewer dependencies, better alignment with mechanical neutrality: the L402 gate is now fully AGPL and forkable, with no external Go binary in the critical path.

## [Infrastructure] - 2026-04-22

### Changed

- Database migrated from SQLite to Postgres 16 on a dedicated Hetzner VM (Phase 12B). Schema v41 frozen as the Postgres baseline.
- Observer Protocol integration sunset (Phase 12C). All related code paths, schemas, event types, and documentation references removed.
- Service endpoint discovery repopulated via the 402index registry crawler after migration (Phase 13C). 172 endpoints classified.

### Fixed

- SSRF hardening (Phase 11bis): all external fetch operations route through `fetchSafeExternal` with connect-time DNS validation.
- Security audit findings F-01 through F-08 closed. No open Critical or High vulnerabilities as of 2026-04-22.

## [Documentation] - 2026-04-22 to 2026-04-23 (Phase 14)

### Changed

- Landing page at satrank.dev rewritten to reflect the current product: intent then fulfill, tiered pricing, Bayesian posterior.
- Methodology at satrank.dev/methodology rewritten as a technical reference in 11 sections.
- README.md rewritten.
- IMPACT-STATEMENT.md rewritten for the post-competition context.
- All em dash and en dash characters removed from public-facing prose.
- Retired references to the WoT-a-thon competition, now that the event has concluded.

## [API 1.0.0] - 2026-04-20

First stable release of the HTTP API. Phase 10 retired the last legacy
surfaces so the external contract is narrow and settled. Callers pinned to
1.x will not see breaking endpoint removals, response envelope changes, or
incompatible schema bumps until 2.0.

See [docs/MIGRATION-TO-1.0.md](docs/MIGRATION-TO-1.0.md) for a step-by-step
migration from 0.x.

### Removed (BREAKING)

- **`POST /api/decide`** now returns **410 Gone**. Use `POST /api/intent`
  for neutral discovery or `GET /api/agent/:hash/verdict` for trust checks.
- **`POST /api/best-route`** now returns **410 Gone**. Use
  `GET /api/services/best?serviceUrl=...` for a known URL, or
  `POST /api/intent` for goal-based discovery with composite ranking.
- `src/utils/deprecation.ts` helpers and the `DeprecationAwareV2Controller`
  sunset fields were removed (orphan cleanup - no consumers remained after
  the two endpoints above were deleted).

### Changed

- Database: `decide_log` → `token_query_log` via migration **v41**
  (schema version 40 → 41). Table structure unchanged; only the name and
  the supporting index were renamed. Down migration supported. External
  tooling reading this table directly (unusual) must update the name.
- OpenAPI `info.version` and MCP `server.version` bumped to `1.0.0`.
- `package.json` `version` bumped to `1.0.0` (the rate-limited
  `/api/version` endpoint now reports 1.0.0).

### Intentionally not changed

- **`GET /api/agent/:hash`** response fields remain camelCase (audited in
  C6). Probe, deposit, and intent responses are also camelCase.
- `snake_case` fields on operator / endpoint / intent / stats endpoints
  (e.g. `url_hash`, `verification_score`, `n_obs`, `p_success`,
  `lnp_rank`, `hubness_rank`) are part of the stable contract and will
  not be renamed in 1.x.

## [1.0.0-rc.1] - 2026-04-19

First release candidate of SDK 1.0. A near-complete rewrite centered on one
verb - **`fulfill()`** - that bundles discovery, L402 payment, and outcome
reporting into a single call with a hard budget guarantee. Python SDK ships
at parity with the TypeScript SDK.

### Added

- **`sr.fulfill()`** - intent-based end-to-end flow: `POST /api/intent` →
  candidate iteration → L402 invoice payment via pluggable wallet → automatic
  `POST /api/report` → `FulfillResult` envelope.
- **Wallet drivers** (subpath `@satrank/sdk/wallet` / `satrank.wallet`):
  - `LndWallet` - LND REST (`/v1/channels/transactions`), macaroon auth.
  - `NwcWallet` - NIP-47 Nostr Wallet Connect (NIP-04 encryption, pluggable
    BIP-340 signer, arbitrary relay).
  - `LnurlWallet` - LNbits-style HTTP wallets with poll-until-paid.
- **NLP helper** (subpath `@satrank/sdk/nlp` / `satrank.nlp`):
  - `parseIntent` / `parse_intent` - English free-text → `{intent, category_confidence, ambiguous_categories}`.
  - Deterministic, zero runtime deps, sub-ms, identical output TS ↔ Python.
- **Python SDK** (`pip install satrank`) - `asyncio` + `httpx`, `py.typed`,
  mypy `--strict` clean, TypedDict wire format, async context manager.
- **`WalletError`** - new error class for wallet-layer failures (transport,
  auth, payment_failed). Not a subclass of `SatRankError`.
- **Auto-report** - `fulfill({ auto_report: true })` (default) posts outcomes
  when `depositToken` is set; `report_submitted` boolean surfaced on result.
- **Examples**:
  - `sdk/examples/simple-weather.ts` - 10-line fulfill.
  - `sdk/examples/langchain-agent.ts` - LangChain agent wiring fulfill() as a
    `DynamicStructuredTool`.
  - `python-sdk/examples/pricing_comparison.py` - discovery-only price table
    across live categories.
- **Documentation** under `docs/sdk/`: quickstart-ts, quickstart-python,
  wallet-drivers, nlp-helper, migration-0.2-to-1.0.

### Changed (BREAKING vs 0.2.x)

1. **Class renamed**: `SatRankClient` → `SatRank`. All options now live on a
   single options object with `apiBase` required.
2. **~25 per-endpoint methods removed** (`decide`, `bestRoute`, `report`,
   `transact`, `getScore`, `getProfile`, `getVerdict`, `getMovers`,
   `searchServices`, `getBatchVerdicts`, `submitAttestation`, …). Replaced by
   `listCategories` / `resolveIntent` / `fulfill`.
3. **`decide` + `bestRoute` are server-deprecated** (Phase 5, 2026-04-18).
   They still respond with `Sunset:` headers but SDK 1.0 no longer wraps them.
4. **Wallet layer is new and required for `fulfill()`**. 0.2.x `transact()`
   expected a pre-paid preimage - this is replaced by the driver protocol.
5. **Explicit `client.report(...)` removed** from the public API. Reports are
   auto-posted by `fulfill()` when a deposit token is configured.
6. **Subpath imports** via Node's `exports` map - wallet drivers and the NLP
   helper do not live in the main barrel (`@satrank/sdk/wallet`,
   `@satrank/sdk/nlp`).
7. **`FulfillResult` envelope** replaces raw response bodies. Check
   `result.success` and read `result.response_body`.
8. **Python SDK is net-new** - no `satrank` PyPI package existed in 0.2.x.
9. **`WalletError` added** - new error class, not a subclass of `SatRankError`.

Error classes from 0.2.3+ (`SatRankError`, `ValidationSatRankError`,
`UnauthorizedError`, `PaymentRequiredError`, `BalanceExhaustedError`,
`PaymentPendingError`, `NotFoundSatRankError`, `DuplicateReportError`,
`RateLimitedError`, `ServiceUnavailableError`, `TimeoutError`, `NetworkError`)
ship unchanged.

### Non-breaking - unchanged in 1.0

- `POST /api/intent`, `POST /api/report`, `POST /api/deposit` wire formats.
- Bayesian / Advisory / Health blocks on candidates.
- L402 flow semantics (`402 + WWW-Authenticate: L402 macaroon=..., invoice=...`).
- Node 18+ requirement, Python 3.10+.
- License: AGPL-3.0.

### Migration

See [docs/sdk/migration-0.2-to-1.0.md](docs/sdk/migration-0.2-to-1.0.md) for
exhaustive before/after examples and a sed upgrade script.

### Deprecated

- `SatRankClient`, `client.decide`, `client.bestRoute`, `client.report`,
  `client.transact`, `client.getProfile`, `client.getVerdict`, and all other
  0.2.x per-endpoint methods - removed, not deprecated (hard break at 1.0).
- The 0.2.x npm line stays in maintenance mode (bug fixes only).

## [0.2.x]

Pre-1.0 per-endpoint client. See git history on the `sdk/` directory for
changes before this changelog was introduced.

[1.0.0-rc.1]: https://github.com/proofoftrust21/satrank/releases/tag/v1.0.0-rc.1
