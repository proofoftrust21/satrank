# Migration — `@satrank/sdk` 0.2.x → 1.0

SDK 1.0 is a near-complete rewrite around a single verb: **`fulfill()`**.
Previous versions exposed every individual SatRank endpoint as a method. 1.0
replaces that surface with the `POST /api/intent` intent-based discovery flow
plus a wallet-backed L402 payment dance.

> If you're calling SatRank endpoints directly from scripts or non-JS clients,
> the HTTP API is unchanged. Migration below is only for SDK consumers.

## TL;DR

```diff
- import { SatRankClient } from '@satrank/sdk';
- const client = new SatRankClient('https://satrank.dev', { depositToken: '...' });
- const decision = await client.decide({ target: 'hash', caller: '...' });

+ import { SatRank } from '@satrank/sdk';
+ import { LndWallet } from '@satrank/sdk/wallet';
+ const sr = new SatRank({
+   apiBase: 'https://satrank.dev',
+   wallet: new LndWallet({ restEndpoint, macaroonHex }),
+   caller: 'my-agent',
+ });
+ const result = await sr.fulfill({ intent: { category: 'data' }, budget_sats: 50 });
```

## Breaking changes

### 1. Class renamed: `SatRankClient` → `SatRank`

```diff
- import { SatRankClient } from '@satrank/sdk';
- const c = new SatRankClient('https://satrank.dev');
+ import { SatRank } from '@satrank/sdk';
+ const sr = new SatRank({ apiBase: 'https://satrank.dev' });
```

The old positional `baseUrl` argument is gone. All options now live on a single
object, with `apiBase` required.

### 2. Per-endpoint methods removed

The 0.2.x client exposed ~25 methods (`getScore`, `getTopAgents`, `decide`,
`bestRoute`, `report`, `getVerdict`, `getBatchVerdicts`, `submitAttestation`,
`getMovers`, `transact`, `searchServices`, …). 1.0 removes them all.

```diff
- await client.decide({ target, caller });
- await client.bestRoute({ targets, caller, amountSats });
- await client.report({ target, outcome });
- await client.transact({ target, bolt11 });
+ await sr.fulfill({
+   intent: { category: 'data', keywords: ['weather'] },
+   budget_sats: 50,
+ });
```

Why: agents don't want to orchestrate three separate round-trips (score →
route → decide → pay → report). `fulfill()` bundles discovery, payment, and
reporting into one call with a single budget guarantee.

### 3. `decide` and `bestRoute` are deprecated server-side

Phase 5 (2026-04-18) deprecated both endpoints on `satrank.dev`. They still
respond but return a `Sunset: ...` header and a deprecation notice. The SDK
1.0 stops wrapping them entirely — migrate to `fulfill()` or call them via raw
HTTP if you must.

### 4. Wallet layer is new (and required for `fulfill()`)

0.2.x had no wallet abstraction — `transact()` expected a pre-paid preimage.
1.0 introduces three drivers:

```diff
+ import { LndWallet }   from '@satrank/sdk/wallet';
+ import { NwcWallet }   from '@satrank/sdk/wallet';
+ import { LnurlWallet } from '@satrank/sdk/wallet';
```

See [wallet-drivers.md](./wallet-drivers.md). `sr.listCategories()` and
`sr.resolveIntent()` still work without a wallet — only `fulfill()` requires
one.

### 5. Reports are automatic

`auto_report: true` (default on `fulfill()`) posts outcomes to
`POST /api/report` when you've supplied a `depositToken`. The old explicit
`client.report(...)` call is gone from the public API.

```diff
- const r = await client.decide({ target, caller });
- // ... agent uses service ...
- await client.report({ target, outcome: 'success', preimage });
+ const r = await sr.fulfill({
+   intent: { category: 'data' }, budget_sats: 50,
+ });
+ // Report is auto-submitted. r.report_submitted tells you if it landed.
```

Set `auto_report: false` to opt out, or omit `depositToken` — reports need it.

### 6. Subpath imports

1.0 uses Node's `exports` map. Import wallet drivers and the NLP helper from
subpaths:

```diff
- import { LndWallet, parseIntent } from '@satrank/sdk';    // ← never existed
+ import { LndWallet } from '@satrank/sdk/wallet';
+ import { parseIntent } from '@satrank/sdk/nlp';
```

The main `@satrank/sdk` barrel stays tight: `SatRank` + all error classes +
public TypedDicts.

### 7. Error classes — unchanged, still importable

All typed errors from 0.2.3+ ship unchanged in 1.0:

```typescript
import {
  SatRankError,
  ValidationSatRankError,
  UnauthorizedError,
  PaymentRequiredError,
  BalanceExhaustedError,
  PaymentPendingError,
  NotFoundSatRankError,
  DuplicateReportError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
  NetworkError,
  WalletError,     // new in 1.0 — thrown by wallet drivers
} from '@satrank/sdk';
```

`WalletError` is the only net-new entry, and it is **not** a subclass of
`SatRankError` — wallet failures are local/transport, not protocol-level.

### 8. Result envelope

0.2.x returned raw response bodies. 1.0 returns a `FulfillResult` envelope:

```typescript
{
  success: boolean;
  response_body?: unknown;
  response_code?: number;
  response_latency_ms?: number;
  cost_sats: number;
  preimage?: string;
  endpoint_used?: { url; service_name; operator_pubkey };
  candidates_tried: CandidateAttempt[];
  report_submitted?: boolean;
  error?: { code; message };
}
```

Migration: look at `result.response_body` where you used to look at the raw
response, and check `result.success` before reading it.

### 9. Python SDK is new in 1.0

There was no Python client in 0.2.x. If you were shelling out to `curl` or
using raw `httpx`, the new `satrank` PyPI package gives you the same API:

```python
from satrank import SatRank
async with SatRank(api_base="https://satrank.dev", wallet=wallet) as sr:
    result = await sr.fulfill(intent={"category": "data"}, budget_sats=50)
```

See [quickstart-python.md](./quickstart-python.md).

## Non-breaking — unchanged in 1.0

- `POST /api/intent` shape (snake_case on the wire).
- Bayesian / Advisory / Health blocks on candidates — identical fields.
- L402 flow semantics (`402 + WWW-Authenticate: L402 macaroon=..., invoice=...`).
- `POST /api/report` wire format (only the call site moves, server shape stays).
- `POST /api/deposit` — not wrapped by SDK 1.0 yet; call via `fetch` if needed.
- Node 18+ requirement.
- License: AGPL-3.0.

## Upgrade script

If your codebase uses `SatRankClient` aggressively, these sed rules get you
most of the way there (audit manually afterwards):

```bash
# Class + import rename
sed -i '' 's/SatRankClient/SatRank/g' src/**/*.ts
sed -i '' "s/import { SatRank } from '@satrank\/sdk';/import { SatRank } from '@satrank\/sdk';\nimport { LndWallet } from '@satrank\/sdk\/wallet';/" src/**/*.ts

# Compile — the type checker will now flag every removed method for you to
# rewrite into a fulfill() call.
tsc --noEmit
```

The compiler is your friend here — removed methods become type errors, each
one is a single-call-site rewrite.

## Still on 0.2.x?

The 0.2.x line is in maintenance mode (bug fixes only). No new features will
land there. Plan a cutover before the server-side deprecation window on
`/api/decide` and `/api/best-route` closes (see
[docs/PHASE-5-REPORT.md](../PHASE-5-REPORT.md) for the timeline).
