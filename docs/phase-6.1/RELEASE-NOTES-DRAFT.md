# SatRank SDK 1.0.0 — Release Notes (draft)

> **Draft for manual publication.** Do NOT publish automatically.

Two SDKs promoted from `1.0.0-rc.1` / `1.0.0rc1` to stable `1.0.0`:
- `@satrank/sdk` (TypeScript, npm) — `sdk/satrank-sdk-1.0.0.tgz`
- `satrank` (Python, PyPI) — `python-sdk/dist/satrank-1.0.0-py3-none-any.whl` + `satrank-1.0.0.tar.gz`

## Highlights

- **One verb, hard budget.** `sr.fulfill({ intent, budget_sats })` / `await sr.fulfill(intent=..., budget_sats=...)` runs the full L402 flow: discover, pay, retry, report. Budget is a hard cap across attempts.
- **Three wallet drivers.** `LndWallet` (REST + macaroon), `NwcWallet` (NIP-47 encrypted over Nostr), `LnurlWallet` (LNbits-style HTTP). The driver contract is a two-method protocol: `payInvoice(bolt11, maxFeeSats)` + `isAvailable()`.
- **Typed error hierarchy.** `SatRankError` subclasses map to HTTP statuses (`ValidationSatRankError`, `PaymentRequiredError`, `BalanceExhaustedError`, `RateLimitedError`, …). `isRetryable()` (TS) tags 429/503/504/network/timeout for agent-side backoff.
- **NLP helper (EN).** `parseIntent('find me a cheap weather API for Paris under 50 sats')` → `{ category, keywords, budget_sats }`. Drop-in for `fulfill()`.

## Changes from RC

- Added `"consider_alternative"` to `AdvisoryBlock.recommendation` union (both SDKs). Server has always emitted four values; SDKs had three. This is **additive** and non-breaking for consumers pattern-matching on the existing three.
- Removed internal `ApiClient.getAgentVerdict()` in the TS SDK (never wired to the public surface).
- Narrative: "AI agents" → "autonomous agents on Bitcoin Lightning" in descriptions.
- TS README rewritten for the narrow 1.0 `SatRank` class (prior README still documented the 0.x `SatRankClient`).

## Phase 12C note

The `AgentSource 'observer_protocol' → 'attestation'` enum rename and the retirement of `BucketSource 'observer'` (Phase 12C, PR #14, currently unmerged) are **transparent to the SDK**. Neither SDK references these enums in its typed surface, so SDK consumers are unaffected whether Phase 12C ships before or after this SDK 1.0.

## Known issue (not blocking)

`error.code` differs between SDKs for known HTTP statuses:
- Python preserves the server's upstream `code` (e.g. `INVALID_CATEGORY`).
- TypeScript substitutes the class default (e.g. `VALIDATION_ERROR`).

Reconciling this is a breaking change for whichever side we adjust and is **deferred to a post-1.0 follow-up**. Consumers pattern-matching on `instanceof` (the recommended path) are unaffected.

## Verification

- 116 Python tests ✅, 125 TS tests ✅
- TS build ✅, Python mypy strict ✅, ruff ✅
- Live smoke against https://satrank.dev ✅ (`listCategories`, `resolveIntent` invalid path) — see `docs/phase-6.1/SDK-INTEGRATION-TEST.md`

## Publication checklist (manual — Romain)

- [ ] `cd sdk && npm publish` (requires npm login with 2FA)
- [ ] `cd python-sdk && twine upload dist/satrank-1.0.0*` (requires PyPI token)
- [ ] `git tag v1.0.0 && git push origin v1.0.0`
- [ ] `gh release create v1.0.0 --draft --notes-file docs/phase-6.1/RELEASE-NOTES-DRAFT.md`
- [ ] Announce on Nostr (SatRank npub)

None of the above is run by the automated loop. The GATE is explicit and enforced.
