# Changelog — @satrank/sdk

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
