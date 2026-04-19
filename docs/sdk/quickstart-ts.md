# Quickstart — TypeScript

`@satrank/sdk` turns any Lightning-native (L402) HTTP service into a typed async
call. Give the SDK an `intent` and a `budget_sats`, and it handles discovery
(`POST /api/intent`), payment (BOLT11 via your wallet), retry, and outcome
reporting.

## Install

```bash
npm install @satrank/sdk
```

Requires **Node 18+** (`globalThis.fetch` must exist or be polyfilled).

## 10-line fulfill()

```typescript
import { SatRank } from '@satrank/sdk';
import { LndWallet } from '@satrank/sdk/wallet';

const sr = new SatRank({
  apiBase: 'https://satrank.dev',
  wallet: new LndWallet({ restEndpoint: 'https://127.0.0.1:8080', macaroonHex: process.env.LND_MACAROON! }),
  caller: 'my-agent',
});

const result = await sr.fulfill({ intent: { category: 'data/weather' }, budget_sats: 50 });
console.log(result.success, result.response_body, result.cost_sats);
```

That's it. The SDK:

1. Calls `POST /api/intent` with the intent + budget → gets ranked candidates.
2. `GET`s the top candidate → receives `402 + WWW-Authenticate: L402 macaroon=..., invoice=lnbc...`.
3. Decodes the invoice, checks it fits the remaining budget.
4. Asks the wallet to pay the BOLT11 (capped at `max_fee_sats`, default 10).
5. Retries the `GET` with `Authorization: L402 <token>:<preimage>` → returns the body.
6. If `auto_report` is on (default) and a `depositToken` is set, posts the outcome
   to `POST /api/report`.

## Result shape

```typescript
type FulfillResult = {
  success: boolean;
  response_body?: unknown;          // parsed JSON from the candidate, if any
  response_code?: number;           // 2xx on success
  response_latency_ms?: number;
  cost_sats: number;                // total spent — always ≤ budget_sats
  preimage?: string;                // hex preimage of the winning payment
  endpoint_used?: { url; service_name; operator_pubkey };
  candidates_tried: Array<{
    url; verdict; outcome:
      | 'paid_success' | 'paid_failure' | 'skipped'
      | 'abort_budget' | 'abort_timeout'
      | 'pay_failed' | 'no_invoice' | 'network_error';
    cost_sats?; response_code?; error?;
  }>;
  report_submitted?: boolean;
  error?: { code; message };
};
```

## Without a wallet (discovery only)

```typescript
const sr = new SatRank({ apiBase: 'https://satrank.dev' });

// List all intent categories live on SatRank.
const { categories } = await sr.listCategories();

// Ranked candidates without paying anything.
const { candidates } = await sr.resolveIntent({
  category: 'bitcoin',
  max_latency_ms: 2000,
  budget_sats: 10,
  limit: 5,
});
```

`listCategories()` and `resolveIntent()` are unauthenticated discovery calls
(no L402 required).

## Using the NLP helper

When the agent receives natural-language input, let `parseIntent` extract the
structured intent:

```typescript
import { parseIntent } from '@satrank/sdk/nlp';

const { categories } = await sr.listCategories();
const cats = categories.map((c) => c.name);

const parsed = parseIntent('give me bitcoin price under 10 sats within 3 seconds', {
  categories: cats,
});
// parsed.intent → { category: 'bitcoin', budget_sats: 10, max_latency_ms: 3000 }

const result = await sr.fulfill({
  intent: parsed.intent,
  budget_sats: parsed.intent.budget_sats ?? 50,
});
```

See [nlp-helper.md](./nlp-helper.md) for when NLP is appropriate and when you
should produce a structured intent directly.

## Wallet drivers

See [wallet-drivers.md](./wallet-drivers.md) to choose between `LndWallet`,
`NwcWallet`, and `LnurlWallet`.

## Constructor options

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiBase` | `string` | — | Required. Usually `https://satrank.dev`. |
| `wallet` | `Wallet` | `undefined` | Required for `fulfill()`. Not needed for discovery. |
| `caller` | `string` | `undefined` | Piped into `/api/intent` logs. Overridable per-call. |
| `depositToken` | `string` | `undefined` | `"L402 deposit:<preimage>"` — required to auto-report outcomes. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | DI hook for tests / TLS / undici agents. |
| `request_timeout_ms` | `number` | `10_000` | Per-call API timeout. |

See [migration-0.2-to-1.0.md](./migration-0.2-to-1.0.md) if upgrading from the
0.2.x SDK.
