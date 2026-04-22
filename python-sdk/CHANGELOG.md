# Changelog — satrank (Python)

## 1.0.0 — 2026-04-22

First stable release, promoted from `1.0.0rc1`.

### Added
- `AdvisoryBlock.recommendation` Literal now includes `"consider_alternative"` to match the four values emitted by the server (previously three).

### Changed
- Description updated from "for AI agents" to "for autonomous agents on Bitcoin Lightning" in `pyproject.toml`.
- `__version__` bumped from `"1.0.0rc1"` to `"1.0.0"`.

### Notes
- Phase 12C enum sunset (`AgentSource 'observer_protocol' → 'attestation'`, `BucketSource` without `'observer'`) is transparent to the SDK: neither enum was referenced in SDK types.
- Public surface (`SatRank`, `fulfill`, `list_categories`, `resolve_intent`, wallet drivers, `parse_intent`) and error hierarchy unchanged from `1.0.0rc1`.
- 116 unit tests green. Live smoke against https://satrank.dev passes (see `docs/phase-6.1/SDK-INTEGRATION-TEST.md`).
- Known pre-existing cross-SDK divergence on `error.code`: Python preserves the server's `error.code` verbatim; TypeScript overrides it with a class default for known HTTP statuses. Flagged for a post-1.0 follow-up; not blocking.
