# Changelog — @satrank/sdk

## 1.1.0 — 2026-04-28

Federation-aware SDK. Backwards-compatible additive release that exposes
the new agentic primitives shipped server-side in PR-1 → PR-7.

### Added
- `IntentCandidate.http_method` — optional `'GET' | 'POST'`. Server now persists the
  HTTP method advertised by 402index per endpoint (Phase 5.10A). `fulfill()`
  defaults to `candidate.http_method` when `opts.request.method` is unset, eliminating
  the silent 405-fallback round-trip on POST-only endpoints (e.g. the 444-entry
  llm402.ai catalog).
- `StagePosteriorEntry`, `StagePosteriorsBlock`, `IntentCandidate.stage_posteriors` —
  optional 5-stage L402 contract decomposition (challenge / invoice / payment /
  delivery / quality). Each stage carries its own Beta posterior + CI95 + n_obs +
  is_meaningful flag. Composed `p_e2e = ∏ p_i` over meaningful stages with chain rule
  multiplicative composition. Phase 5.14.
- `aggregateOracles`, `fetchOraclePeers`, `filterByCalibrationError` — federation
  primitives for SDK consumers. Discovers SatRank-compatible peers via
  `GET /api/oracle/peers`, filters by the agent's trust criteria (max staleness,
  minimum catalogue size, calibration history required, minimum identity age).
  Phase 7.2.

### Changed
- `fulfill()` resolution order for HTTP method:
  1. `opts.request.method` (agent override) — wins always
  2. `candidate.http_method` (oracle-persisted, NEW)
  3. Fallback `'GET'` (legacy / pre-1.1 oracle compat)

### Notes
- All additions are non-breaking: existing 1.0.x consumers keep behavior unchanged.
- 139/139 SDK tests green (incl. 9 new aggregate tests + 3 new fulfill tests).
- Server compatibility: requires SatRank server schema v48+ for `http_method`,
  v49+ for `stage_posteriors`, v53+ for federation peers. Older servers omit
  the new fields and SDK falls back gracefully.

## 1.0.0 — 2026-04-22

First stable release, promoted from `1.0.0-rc.1`.

### Added
- `AdvisoryBlock.recommendation` now includes `"consider_alternative"` to match the four values emitted by the server (previously three).

### Changed
- Description updated from "for AI agents on Bitcoin Lightning" to "for autonomous agents on Bitcoin Lightning".
- README rewritten for the narrow 1.0 surface (`SatRank` class, `fulfill()`, `listCategories()`, `resolveIntent()`, wallet drivers, `parseIntent()`). The prior README still documented the deprecated SDK 0.x `SatRankClient` surface.

### Removed
- Internal `ApiClient.getAgentVerdict()` (dead code — never wired to the public `SatRank` class; corresponding server route is not part of the narrow 1.0 surface).

### Notes
- Phase 12C enum sunset (`AgentSource 'observer_protocol' → 'attestation'`, `BucketSource` without `'observer'`) is transparent to the SDK: neither enum was referenced in SDK types, so no code changes are required here.
- Public surface, wallet driver contract, and error hierarchy unchanged from `1.0.0-rc.1`.
- 125 unit/integration tests green. Live smoke against https://satrank.dev passes (see `docs/phase-6.1/SDK-INTEGRATION-TEST.md`).
