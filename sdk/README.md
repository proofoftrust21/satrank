# @satrank/sdk

TypeScript client for [SatRank](https://satrank.dev). One verb — `sr.fulfill()` — that discovers, pays, and reports a Lightning-native HTTP service in a single call with a hard budget guarantee.

Built for autonomous agents on Bitcoin Lightning. Zero runtime dependencies (uses native `fetch()` on Node 18+).

## Install

```bash
npm install @satrank/sdk
```

Node 18+ required (native `fetch`). In older runtimes, polyfill `globalThis.fetch` or pass a `fetch` implementation in the constructor.

## Quickstart

```typescript
import { SatRank } from '@satrank/sdk';
import { LndWallet } from '@satrank/sdk/wallet';

const sr = new SatRank({
  apiBase: 'https://satrank.dev',
  wallet: new LndWallet({
    restUrl: 'https://127.0.0.1:8080',
    macaroonHex: '...', // admin macaroon (hex)
  }),
  caller: 'my-agent',
});

const result = await sr.fulfill({
  intent: { category: 'data/weather', keywords: ['paris'] },
  budget_sats: 50,
});

if (result.success) {
  console.log(result.response_body);
  console.log(`Paid ${result.cost_sats} sats to ${result.endpoint_used?.url}`);
} else {
  console.log('Failed:', result.error?.code, result.error?.message);
}
```

`fulfill()` handles the full L402 flow: calls `/api/intent` to rank candidates, attempts each in rank order, pays BOLT11 invoices via your wallet driver, retries the request with the L402 token, and optionally reports the outcome to `/api/report`.

## Discovery only (no wallet)

```typescript
const sr = new SatRank({ apiBase: 'https://satrank.dev', caller: 'explorer' });

const cats = await sr.listCategories();
// { categories: [{ name: 'data/weather', endpoint_count: 12, active_count: 8 }, ...] }

const res = await sr.resolveIntent({ category: 'data/weather', limit: 10 });
for (const c of res.candidates) {
  console.log(c.rank, c.price_sats, c.service_name, c.bayesian.verdict);
}
```

## Wallet drivers

Import from the `@satrank/sdk/wallet` subpath:

```typescript
import { LndWallet, NwcWallet, parseNwcUri, LnurlWallet } from '@satrank/sdk/wallet';
```

| Driver        | Transport                                 | Notes                                                     |
|---------------|-------------------------------------------|-----------------------------------------------------------|
| `LndWallet`   | LND REST, macaroon auth                   | Host your own node.                                       |
| `NwcWallet`   | Nostr Wallet Connect (NIP-47, encrypted)  | Connects to any NWC-compatible wallet over Nostr relays.  |
| `LnurlWallet` | LNURL-pay / LNbits-style HTTP             | Simplest drop-in for custodial setups.                    |

Any object that implements `{ payInvoice(bolt11, maxFeeSats), isAvailable() }` works — the `Wallet` interface is intentionally narrow.

## NLP helper

```typescript
import { parseIntent } from '@satrank/sdk/nlp';

const intent = parseIntent('find me a cheap weather API for Paris under 50 sats');
// { category: 'data/weather', keywords: ['paris'], budget_sats: 50 }
```

EN-only in 1.0. Passes the result straight into `sr.fulfill({ intent, budget_sats })`.

## Options

### `new SatRank(opts)`

| Option                | Type                    | Default      | Description                                          |
|-----------------------|-------------------------|--------------|------------------------------------------------------|
| `apiBase`             | `string`                | —            | Required. e.g. `https://satrank.dev`                 |
| `wallet`              | `Wallet`                | —            | Required for paid candidates. See drivers above.     |
| `caller`              | `string`                | —            | Free-form identifier piped into `/api/intent` logs.  |
| `depositToken`        | `string`                | —            | `L402 deposit:<preimage>` token. Required for `auto_report`. |
| `request_timeout_ms`  | `number`                | `10000`      | Per-API-call timeout.                                |
| `fetch`               | `typeof fetch`          | `globalThis.fetch` | DI point for Node <18 / tests.                 |

### `sr.fulfill(opts)`

| Option          | Type                                  | Default          | Description                                           |
|-----------------|---------------------------------------|------------------|-------------------------------------------------------|
| `intent`        | `Intent` (`{category, keywords?, budget_sats?, max_latency_ms?}`) | — | Required.          |
| `budget_sats`   | `number`                              | —                | Hard cap on total sats across all attempts.           |
| `timeout_ms`    | `number`                              | `30000`          | Wall-clock cap across candidates.                     |
| `retry_policy`  | `'next_candidate' \| 'none'`          | `'next_candidate'` | Whether to try subsequent candidates on failure.    |
| `auto_report`   | `boolean`                             | `true`           | Auto-submit outcome to `/api/report` (needs `depositToken`). |
| `caller`        | `string`                              | constructor      | Per-call override.                                    |
| `limit`         | `number`                              | `5`              | Max candidates from `/api/intent` (server caps at 20).|
| `request`       | `FulfillRequest` (`{method?, path?, query?, headers?, body?}`) | `GET` | Shape the downstream call.  |
| `max_fee_sats`  | `number`                              | `10`             | Per-candidate fee cap handed to the wallet driver.    |

Returns a `FulfillResult` with `success`, `response_body`, `cost_sats`, `preimage`, `endpoint_used`, `candidates_tried[]`, and on failure a typed `error.code`.

## Error handling

```typescript
import {
  SatRankError,
  BalanceExhaustedError,
  PaymentRequiredError,
  PaymentPendingError,
  DuplicateReportError,
  RateLimitedError,
  TimeoutError,
  NetworkError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationSatRankError,
  WalletError,
} from '@satrank/sdk';

try {
  await sr.fulfill({ intent, budget_sats: 100 });
} catch (err) {
  if (err instanceof RateLimitedError || err instanceof TimeoutError) {
    // retryable
  } else if (err instanceof SatRankError) {
    console.error(err.statusCode, err.code, err.message);
  }
}
```

`SatRankError.isRetryable()` returns true for 429/503/504/network/timeout. Most `fulfill()` failures do **not** throw — they surface in `result.error` so the candidate loop can continue cleanly.

## Documentation

- [Quickstart (TypeScript)](../docs/sdk/quickstart-ts.md)
- [Wallet drivers](../docs/sdk/wallet-drivers.md)
- [NLP helper](../docs/sdk/nlp-helper.md)
- [Migration 0.2.x → 1.0](../docs/sdk/migration-0.2-to-1.0.md)

## License

MIT
