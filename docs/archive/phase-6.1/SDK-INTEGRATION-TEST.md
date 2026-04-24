# Phase 6.1 — SDK Integration Test Report

**Date:** 2026-04-22
**Target:** https://satrank.dev (prod)
**SDKs:** `@satrank/sdk@1.0.0` (TS), `satrank@1.0.0` (Python)

## Endpoint health

| Endpoint | Status | Notes |
|---|---|---|
| `GET /api/health` | 200 | `schemaVersion=41`, `agentsIndexed=8186`, `dbStatus=ok`, `lndStatus=ok` |
| `GET /api/intent/categories` | 200 | `{ "categories": [] }` — registry currently empty, shape matches SDK contract |
| `POST /api/intent` (unknown category) | 400 | `code=INVALID_CATEGORY` — correctly rejected |
| `GET /api/agents/top` | 200 | Not in SDK surface (removed in Phase 6 narrowing); verified wire shape for later reference |

Prod is healthy. No STOP condition triggered.

## TypeScript SDK smoke

Ran `@satrank/sdk@1.0.0` from freshly-built `dist/` against prod:

```json
{
  "ts_sdk_version": "1.0.0",
  "steps": [
    { "name": "listCategories", "ok": true, "category_count": 0, "shape_ok": true },
    {
      "name": "resolveIntent(invalid)",
      "ok": true,
      "threw": "ValidationSatRankError",
      "code": "VALIDATION_ERROR",
      "statusCode": 400,
      "message": "Unknown category \"does/not/exist\". Call GET /api/intent/categories for the current list."
    }
  ]
}
```

## Python SDK smoke

Ran `satrank@1.0.0` (installed from `python-sdk/` editable) against prod:

```json
{
  "py_sdk_version": "1.0.0",
  "steps": [
    { "name": "list_categories", "ok": true, "category_count": 0, "shape_ok": true },
    {
      "name": "resolve_intent(invalid)",
      "ok": true,
      "threw": "ValidationSatRankError",
      "code": "INVALID_CATEGORY",
      "message": "Unknown category \"does/not/exist\". Call GET /api/intent/categories for the current list."
    }
  ]
}
```

## Observations

1. **Shape parity OK.** Both SDKs deserialize `/api/intent/categories` into the documented shape. Empty list is handled without exceptions.
2. **Error-class parity OK.** Both SDKs surface `ValidationSatRankError` for HTTP 400.
3. **Known pre-existing cross-SDK divergence on `error.code`:**
   - TS SDK discards the server's `error.code` for known HTTP statuses and uses the class default (`VALIDATION_ERROR`).
   - Python SDK preserves the server's `error.code` verbatim (`INVALID_CATEGORY`).
   - This is not new drift from Phase 6.1 — it's how both SDKs shipped in Phase 6. Reconciling would be a BREAKING change in whichever we adjust. Flagged for a post-1.0 follow-up; not blocking for this release.
4. **Fulfill path not exercised.** No wallet configured (intentional — no LN ops without approval). The L402 flow is covered by the 116 Python tests + 125 TS tests, both green locally.

## Verdict

Integration smoke **GREEN** for both SDKs against prod. Ready to proceed to S5 (local build artifacts).
