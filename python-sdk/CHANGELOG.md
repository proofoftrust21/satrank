# Changelog — satrank (Python)

## 1.6.0 — 2026-05-08

AEPS §10 dispute parity with @satrank/sdk 1.6.0. Backwards-compatible
additive release. No new dependencies (`httpx>=0.27` already required).

### Added

- `SatRank.open_dispute(*, respondent_pubkey, dispute_type, oracle_pubkeys,
  oracle_threshold, receipt_id?, fork_event_id?, ttl_sec?, dispute_reason?,
  authorization)` — open a dispute. NIP-98-gated. Returns dict with
  `dispute_id` + `outcome_messages`.
- `SatRank.submit_attestation(*, dispute_id, outcome, signature_hex,
  authorization)` — submit oracle Schnorr attestation.
- `SatRank.get_dispute(dispute_id)` — public state read.
- `SatRank.dispute_endpoint()` / `SatRank.attestation_endpoint(dispute_id)` —
  canonical URLs for NIP-98 `u` tag.
- Pure helpers (no crypto deps) :
  - `build_outcome_message(dispute_id, outcome)` — canonical UTF-8.
  - `build_outcome_message_hash(...)` — `{ canonical, hash_hex, hash_bytes }`.
  - `build_nip98_event_template(*, url, method, body?, created_at?)` —
    kind 27235 unsigned event template.
  - `encode_nip98_auth_header(signed)` — `Nostr <base64-json>`.
- Typed error subclasses :
  - `AepsDisputeNotFoundError` (404 dispute_not_found)
  - `AepsDisputeNotOpenError` (409 dispute_not_open)
  - `AepsOracleNotInSetError` (403 oracle_not_in_set)
  - `AepsSignatureInvalidError` (400 signature_invalid)
- TypedDicts : `AepsDisputeType`, `AepsAttestationOutcome`,
  `AepsDisputeState`, `AepsDisputeOpenInput/Result`,
  `AepsAttestationInput/Result`, `AepsDisputeView`.

### Cross-impl

- All canonical-byte helpers verified byte-for-byte against
  `spec/test-vectors/dispute_outcome.json` — the same fixture the
  server, the Rust reference impl, and the TypeScript SDK 1.6.0 read.

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
