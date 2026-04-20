# Changelog

All notable changes to the SatRank HTTP API (`satrank.dev`) and the SatRank
SDKs (`@satrank/sdk` and `satrank`) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/). The HTTP
API and each SDK are versioned independently; entries are prefixed with
`API`, `SDK-TS`, or `SDK-PY` when scope is not obvious.

## [API 1.0.0] — 2026-04-20

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
  sunset fields were removed (orphan cleanup — no consumers remained after
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

## [1.0.0-rc.1] — 2026-04-19

First release candidate of SDK 1.0. A near-complete rewrite centered on one
verb — **`fulfill()`** — that bundles discovery, L402 payment, and outcome
reporting into a single call with a hard budget guarantee. Python SDK ships
at parity with the TypeScript SDK.

### Added

- **`sr.fulfill()`** — intent-based end-to-end flow: `POST /api/intent` →
  candidate iteration → L402 invoice payment via pluggable wallet → automatic
  `POST /api/report` → `FulfillResult` envelope.
- **Wallet drivers** (subpath `@satrank/sdk/wallet` / `satrank.wallet`):
  - `LndWallet` — LND REST (`/v1/channels/transactions`), macaroon auth.
  - `NwcWallet` — NIP-47 Nostr Wallet Connect (NIP-04 encryption, pluggable
    BIP-340 signer, arbitrary relay).
  - `LnurlWallet` — LNbits-style HTTP wallets with poll-until-paid.
- **NLP helper** (subpath `@satrank/sdk/nlp` / `satrank.nlp`):
  - `parseIntent` / `parse_intent` — English free-text → `{intent, category_confidence, ambiguous_categories}`.
  - Deterministic, zero runtime deps, sub-ms, identical output TS ↔ Python.
- **Python SDK** (`pip install satrank`) — `asyncio` + `httpx`, `py.typed`,
  mypy `--strict` clean, TypedDict wire format, async context manager.
- **`WalletError`** — new error class for wallet-layer failures (transport,
  auth, payment_failed). Not a subclass of `SatRankError`.
- **Auto-report** — `fulfill({ auto_report: true })` (default) posts outcomes
  when `depositToken` is set; `report_submitted` boolean surfaced on result.
- **Examples**:
  - `sdk/examples/simple-weather.ts` — 10-line fulfill.
  - `sdk/examples/langchain-agent.ts` — LangChain agent wiring fulfill() as a
    `DynamicStructuredTool`.
  - `python-sdk/examples/pricing_comparison.py` — discovery-only price table
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
   expected a pre-paid preimage — this is replaced by the driver protocol.
5. **Explicit `client.report(...)` removed** from the public API. Reports are
   auto-posted by `fulfill()` when a deposit token is configured.
6. **Subpath imports** via Node's `exports` map — wallet drivers and the NLP
   helper do not live in the main barrel (`@satrank/sdk/wallet`,
   `@satrank/sdk/nlp`).
7. **`FulfillResult` envelope** replaces raw response bodies. Check
   `result.success` and read `result.response_body`.
8. **Python SDK is net-new** — no `satrank` PyPI package existed in 0.2.x.
9. **`WalletError` added** — new error class, not a subclass of `SatRankError`.

Error classes from 0.2.3+ (`SatRankError`, `ValidationSatRankError`,
`UnauthorizedError`, `PaymentRequiredError`, `BalanceExhaustedError`,
`PaymentPendingError`, `NotFoundSatRankError`, `DuplicateReportError`,
`RateLimitedError`, `ServiceUnavailableError`, `TimeoutError`, `NetworkError`)
ship unchanged.

### Non-breaking — unchanged in 1.0

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
  0.2.x per-endpoint methods — removed, not deprecated (hard break at 1.0).
- The 0.2.x npm line stays in maintenance mode (bug fixes only).

## [0.2.x]

Pre-1.0 per-endpoint client. See git history on the `sdk/` directory for
changes before this changelog was introduced.

[1.0.0-rc.1]: https://github.com/orsonio/satrank/releases/tag/v1.0.0-rc.1
