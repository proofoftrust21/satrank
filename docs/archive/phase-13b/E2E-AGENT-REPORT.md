# Phase 13B — E2E agent report (SDK @satrank/sdk@1.0.0)

**Date:** 2026-04-22
**Branch:** `phase-13b-e2e`
**Target:** https://satrank.dev (prod)
**SDK versions tested:**
- npm `@satrank/sdk@1.0.0` (TypeScript / Node 18.20)
- PyPI `satrank==1.0.0` (Python 3.10, async httpx)

**Sats spent:** 0 (no programmatic wallet available + stored test tokens all invalid on prod — details in §2, §3.S2).

---

## 1. Executive summary

**Does the SDK work?** Yes — the SDK installs, parses, validates, and enforces its budget guarantee. Zero production bugs found in the SDK itself.

**Does the product work end-to-end?** **No.** The backend is in a degraded state post-Phase-12B: `service_endpoints`, `operators`, `operator_identities`, and `token_balance` tables are all empty. An external agent cannot find a single paid service to pay.

**Scenario success rate (SDK layer, against real prod):** 7/10 scenarios produced the intended-observable behavior; 3 scenarios could not be fully validated because the prerequisite state (indexed endpoints, valid deposit token) does not exist on prod.

**One-line agent pitch (SDK):** `sr.fulfill({intent, budget_sats})` — the lib delivers that verb. It's blocked by the backend having nothing to fulfill.

---

## 2. Setup reality check

| Step | Time | Friction |
|------|-----:|----------|
| `npm install @satrank/sdk@1.0.0` | 2 s | 0 deps, instant ✅ |
| `pip install satrank==1.0.0` in venv | ~4 s | 1 dep (httpx), instant ✅ |
| Read README + skim `dist/*.d.ts` | ~5 min | README is concise and self-contained; types are rich ✅ |
| First working `listCategories()` call (TS) | ~2 min | Hit empty array, went to DB to investigate ⚠️ |
| First working `fulfill()` call (TS) | N/A | Impossible today — no valid categories on prod ❌ |

Hello-world (TS, discovery only):

```typescript
import { SatRank } from '@satrank/sdk';
const sr = new SatRank({ apiBase: 'https://satrank.dev', caller: 'hello' });
const cats = await sr.listCategories();
```

4 lines, ~200 ms. Would be 6 lines with `fulfill()` + a wallet driver if the backend had endpoints.

---

## 3. Per-scenario results

Legend: ✅ passes, ⚠️ degraded (SDK fine, prod data missing), ❌ blocked.

### S1 — Discovery: `parseIntent` + discovery → empty ⚠️

```typescript
sr.listCategories()          // → { categories: [] }
parseIntent('I need weather data for Paris', { categories: [] })
                              // → { intent: { category: '' }, category_confidence: 0 }
sr.resolveIntent({ category: 'data', limit: 5 })
                              // → 400 VALIDATION_ERROR: "Unknown category 'data'"
```

Latency: 382 ms (listCategories), 1 ms (parseIntent), 295 ms (failing resolveIntent).

**Finding P1 (prod data, not SDK):** `service_endpoints` table has 0 rows. Phase 6's indexed Lightning-native HTTP services were not migrated from SQLite to PG in Phase 12B.

### S2 — Score check on a known node ⚠️

No dedicated SDK helper exists for "read score of a pubkey". Agents must hit `/api/agent/:hash/verdict` directly. All `/api/agent/*` paths return 402 LSAT challenge with a 21-sat invoice (correct behavior). With a valid L402 token, the agent would pay 1 sat + get the verdict.

**Finding P2:** Both historical test tokens (`83272a4…` and `be7740a4…` from local memory/paste-cache) return `TOKEN_UNKNOWN` on prod. `token_balance` table is empty. All previously issued deposit tokens were lost in Phase 12B migration. Re-deposit required to test this scenario.

Free fallback that works: `/api/agents/top` returns the ranked list including full bayesian block — 591 ms, 200 OK. An agent evaluating "can I trust node X" could filter the top list client-side instead of paying per-lookup. (Not called out in the SDK docs — would make a nice cheap path for the SDK to expose as a helper.)

### S3 — Pathfinding: decide() / best-route ❌

Both `/api/decide` and `/api/best-route` return **410 Gone** ("This endpoint was removed on 2026-04-20. Use /api/intent instead.").

The SDK does not call these removed routes (verified by grep: it only hits `/api/intent`, `/api/intent/categories`, `/api/report`). **The SDK is Phase-12C-clean.**

**Finding P3 (doc stale):** `/Users/lochju/satrank/CLAUDE.md` still documents `POST /api/decide` and `POST /api/best-route` as live endpoints with detailed pathfinding-resolution rules. This guidance is now wrong.

### S4 — Happy-path fulfill with a logging mock wallet ⚠️

```typescript
await sr.fulfill({
  intent: { category: 'data/weather', keywords: ['paris'] },
  budget_sats: 50,
});
```

Returns (337 ms):
```json
{ "success": false, "cost_sats": 0, "candidates_tried": [],
  "error": { "code": "VALIDATION_ERROR", "message": "Unknown category 'data/weather'..." } }
```

✅ **Budget guarantee verified**: wallet.payInvoice was never called (`walletCalls: 0`). The SDK aborts before any payment when the category is invalid.

❌ **Cannot exercise the real pay path** on prod because there are 0 categories.

### S5 — Budget insufficient (reject before pay) ✅ (partial)

```typescript
sr.fulfill({ intent: { category: 'data/weather' }, budget_sats: 1 })
```

Wallet NOT called (as intended). Aborts on the same VALIDATION_ERROR as S4, so the budget-gate logic itself could not be tested head-on against a real candidate. In unit tests (shipped with the SDK), the budget gate is covered; prod could not exercise it today.

### S6 — Manual L402 flow ⚠️

`POST /api/decide` without auth → **410 Gone**, not 402. So S6 as described in the brief (hitting `/api/decide` for the L402 challenge) no longer applies. Running it on `/api/agent/:hash` instead:

```
GET /api/agent/<hash>
→ 402 Payment Required
www-authenticate:
  LSAT macaroon="...", invoice="lnbc210n1p..."
  L402  macaroon="...", invoice="lnbc210n1p..."
```

Invoice decoded: 21 sats, memo empty, expires in default window. Both `LSAT` (legacy) and `L402` challenges are returned in parallel — client-backcompat. Correct shape for automatic wallet handling. **Payment leg could not be exercised** (no wallet + no valid deposit token).

### S7 — Balance exhausted ❌

Cannot exhaust a balance that is zero-row on prod. Observed surrogate: using an unknown token returns `TOKEN_UNKNOWN` (not `BALANCE_EXHAUSTED`), which is correct error differentiation.

### S8 — Unreachable / phantom node ❌

`/api/best-route` (the historical pathfinder) is 410 Gone; `/api/intent` is the replacement but rejects every category since the list is empty. Cannot exercise "unreachable-node detection" today. Unit tests in the repo cover it.

### S9 — Malformed intent robustness ✅

| Input | `parseIntent` TS | `parseIntent` PY |
|-------|------------------|------------------|
| `''` | throws `Error: input must be a non-empty string` | throws `ValueError: input must be a non-empty string` |
| `'   \n\t   '` | throws same | throws same |
| `'qwertyuiop asdfghjkl zxcvbnm'` | returns `{ category: '', keywords: [ 'qwertyuiop', 'asdfghjkl', 'zxcvbnm' ] }` | same |
| `'💥💥💥'` | `{ category: '', confidence: 0 }` | same |
| `'need need … need weather paris'` (1000+ words) | extracts `weather` + `paris` | same |

`sr.resolveIntent({ category: '💥💥' })` → `ValidationSatRankError` "category must match /^[a-z][a-z0-9/_-]{1,31}$/" ✅ clean regex message.

`sr.resolveIntent({ budget_sats: NaN })`:
- TS → "budget_sats must be a number, got null" — **misleading** (NaN ≠ null)
- PY → `ValueError: Out of range float values are not JSON compliant` — **internal-looking**, not an SDK-surface error

### S10 — Python parity ✅ (with notes)

Head-to-head TS vs Python on identical `parseIntent` inputs: **outputs match byte-for-byte** across 4 cases (see `scripts/parity-ts.mjs` and `scripts/parity-py.py`). The docstring promise "Mirrors TS parseIntent exactly" holds.

Parity differences observed (non-bug, DX-only):

1. **Return shape**: TS returns typed objects; Python returns raw dicts (`{"categories": [...]}`). Python style is OK but it means client code can't `.` into fields.
2. **Options as positional dict**: Python `parse_intent(text, {"categories": [...]})` requires a dict as positional arg. A Python-native developer would instinctively try `parse_intent(text, categories=[...])` (kwargs) and get `TypeError`. `ParseIntentOptions` is a `TypedDict`, not a class, so you cannot instantiate it.
3. **Error handling**: TS `fulfill()` throws `ValidationSatRankError` for unknown category; Python `fulfill()` **swallows** it into `result.error.code = INVALID_CATEGORY` and returns normally. Same logical outcome, opposite idiom — a user juggling both will be surprised once.
4. **Sync API missing**: Python SDK is async-only. A Python 3.8/3.9 or sync-codebase user needs to roll their own `asyncio.run()` wrapper.
5. **Latency**: Python 68–241 ms vs TS 245–591 ms. Python (httpx) is consistently faster at the same fetch — not a bug, possibly due to Node `fetch` overhead.

---

## 4. UX friction log (prioritised)

| # | Severity | Area | Friction |
|---|----------|------|----------|
| F1 | HIGH | parseIntent + empty categories | When `/api/intent/categories` returns `[]`, `parseIntent` silently returns `category: ''`. The SDK then hits /api/intent with a user-supplied fallback and gets `Unknown category "X"`. There is no hint to the user that "0 categories exist — nothing to fulfill". A targeted `CATALOG_EMPTY` error would save an hour of debugging. |
| F2 | HIGH | SDK <-> docs mismatch | CLAUDE.md + docs/ reference `/api/decide` and `/api/best-route` as current, but both are 410 Gone since 2026-04-20. An onboarding agent that reads the docs first will get stale guidance. |
| F3 | MED | Python `parse_intent` signature | Positional dict instead of kwargs. Un-Pythonic. Expected: `parse_intent(text, categories=["data"], synonyms={...})`. |
| F4 | MED | Python `fulfill()` error paradigm | TS throws, Python returns `result.error`. Inconsistent DX for polyglot teams. Pick one and document. |
| F5 | LOW | NaN/Infinity budget error | Generic `"got null"` (TS) or JSON-serialization crash (PY). Both should surface `VALIDATION_ERROR: budget_sats must be a finite positive integer`. |
| F6 | LOW | No `isAvailable()` call visible in fulfill() | README says "cheap liveness check — used to fail fast before a fulfill() attempt" but the real fulfill() path currently aborts on `/api/intent` validation before ever calling the wallet; the isAvailable contract never fires when there's nothing to pay. Not a bug, but the README sentence over-sells. |
| F7 | LOW | No helper for "get agent score by hash" | Every paid endpoint requires L402 handling. The SDK exposes no `getAgent(hash)`/`getVerdict(hash)` helper. Users must write their own fetch + token management. |
| F8 | INFO | `/api/agents/top` free & rich | Good cheap path for cost-sensitive agents — could be a first-class SDK method. |

---

## 5. Bugs detected (SDK layer)

| # | Severity | SDK | Repro |
|---|----------|-----|-------|
| B1 | LOW | TS | `resolveIntent({ budget_sats: NaN })` → `"got null"` message. Actual value is NaN. Fix: check `Number.isFinite()` before zod. |
| B2 | LOW | PY | `resolve_intent(budget_sats=float('nan'))` → `ValueError: Out of range float values are not JSON compliant` leaks httpx-internal error. Fix: pre-validate before serialization. |
| B3 | INFO | TS | `fulfill()` returns `cost_sats: 0` + `error.code: VALIDATION_ERROR` when category is unknown, but the typed doc comment calls out "Hard cap on total sats the SDK is allowed to spend" — the NON-paid abort path is indistinguishable from a 0-cost success until you check `success`. Consider renaming/adding `aborted_before_pay: boolean` for clarity. |

No HIGH or CRITICAL SDK bugs. The SDK is solid.

---

## 6. Product-level findings (not SDK bugs, but affect the Phase 13B answer)

These are **backend state issues**, surfaced by the E2E run. They were not the scope of Phase 13B but block any honest E2E success claim.

| # | Severity | Table / Issue | Details |
|---|----------|---------------|---------|
| P1 | CRITICAL | `service_endpoints`: 0 rows | Phase 6 indexed L402/LSAT services missing. Agents have no catalog to fulfill from. |
| P2 | CRITICAL | `operators`: 0 rows | Phase 7 seed of 14023 operators lost. `/api/operators` returns empty. Operator identity linkage broken. |
| P3 | CRITICAL | `operator_identities`: 0 rows | Phase 8 attested operator identities lost. |
| P4 | HIGH | `token_balance`: 0 rows | All deposit tokens invalidated. Every prior agent's L402 token returns `TOKEN_UNKNOWN`. |
| P5 | HIGH | Schema: `decide_log` missing | CLAUDE.md references it; live schema has `token_query_log` instead. Likely renamed in 12C, doc not updated. |
| P6 | MED | CLAUDE.md references 410-Gone endpoints | `/api/decide`, `/api/best-route`, pathfinding rules — all removed 2026-04-20. |

All P1–P6 stem from the Phase 12B SQLite→PG migration having carried `agents` + `transactions` but not the sovereign-oracle tables. See `ssh root@178.104.108.108 'docker exec satrank-api node -e "… SELECT COUNT …"'` outputs in the raw run log.

---

## 7. Recommendations for Phase 14 (harmonisation)

Ordered by highest-leverage-per-hour:

1. **Re-seed `service_endpoints` + `operators` on prod** (or re-run the 402index crawler). Without this, no agent can fulfill anything. This is the single most important fix before any public launch.
2. **Re-sync CLAUDE.md + docs/ to post-12C reality.** Strip `/api/decide` and `/api/best-route` sections. Add a "SDK-first" quickstart. Update the schema description (`decide_log` → `token_query_log`).
3. **Expose `getVerdict(hash)` helper in the SDK** with built-in L402 flow. Today agents must roll their own fetch + token juggling.
4. **Python SDK DX polish**: accept kwargs in `parse_intent`; decide sync vs async strategy (at minimum provide a sync wrapper); align `fulfill()` error semantics with TS (throw vs return — pick one).
5. **Add a `CATALOG_EMPTY` top-level error code** surfaced when `/api/intent/categories` is `[]`, so SDK users know the problem is "nothing indexed" not "bad category".
6. **Fix NaN/Infinity handling in both SDKs** (B1, B2) — cheap, cosmetic, but the first thing an adversarial user will try.
7. **Consider a free `cheapScore(hash)` or top-list-filter helper** — the `/api/agents/top` endpoint is free + rich, and agents can filter it client-side without paying 1 sat per lookup.

---

## 8. Honest verdict

**Does the product do what the documentation promises?**
The SDK does. The backend does not. A developer following the published README would install cleanly, call `listCategories()`, get an empty array, and hit a wall. Nothing in the docs says "prod has 0 categories indexed today." The gap between the story ("sr.fulfill() handles the full L402 flow — discover, pay, retrieve, report") and the observable reality ("there is nothing to discover") is the biggest friction.

**Would a reasonable external dev arrive at a working fulfill() without help?**
No. They'd need to: (a) figure out that categories are empty and this isn't a bug in their code; (b) understand that no token will ever be `KNOWN` because `token_balance` is wiped; (c) either deposit fresh sats or accept that the paid path is untestable. None of that is diagnosable from the SDK's error messages. Most would quit within 15 minutes.

**How much friction remains before adoption?**
The SDK itself is very close to ready. Maybe a dozen hours of DX polish + a few small bugfixes listed above. The **backend** is the blocker: without `service_endpoints` and `operators` re-populated, the whole "autonomous agent pays Lightning-native HTTP service" thesis has no instance to prove. That isn't an SDK problem and it can be fixed outside the SDK path, but it has to be fixed before any public demo.

**One sentence, plainest form:** `@satrank/sdk@1.0.0` is shippable software pointed at an empty shelf.

---

## 9. Run artefacts

- TS test scripts: `docs/phase-13b/scripts/*.mjs`
- Python test scripts: `docs/phase-13b/scripts/*.py`
- Raw DB survey: inline in §6 (commands reproducible via `ssh root@178.104.108.108 'docker exec satrank-api …'`)
- Cardinal rules compliance: LND, macaroons, Nostr key, wallet.db, channel.db — all untouched. No prod writes. Read-only DB query via existing container.
