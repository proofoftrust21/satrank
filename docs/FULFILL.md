# Fulfill — server-side execution proxy

`POST /api/fulfill` lets an agent hand SatRank an intent and a budget. SatRank picks the candidate, pays the operator, validates the response, and returns the body — or refunds. The agent never touches Lightning, retries, macaroons, or the upstream pay-gap. This is the indispensability primitive: success-only billing.

## Why

Without fulfill, the typical agent flow is:

1. `POST /api/intent` → list of candidates
2. Agent's wallet pays each invoice as it goes
3. ~25% of paid calls don't deliver (operator returns 4xx after pay, body is junk, recall errors out)
4. Agent absorbs the loss, retries another candidate
5. Compliance audits ask "what did you actually try?" — agent has no signed receipt

With fulfill, the agent sends the intent + budget to SatRank, and gets back either a validated body **with the preimage as a settlement proof** or a refund (no debit). SatRank's pool absorbs the upstream pay-gap and prices it into the premium.

## Pricing model

```
premium_per_call = max(1 sat, ceil(invoice_sats × 0.10 × (1 − p_e2e_pessimistic)))
```

Risk-adjusted: a candidate with strong post-payment posteriors costs nearly nothing extra; a thin/risky candidate costs more. **Success-only billing** — if every candidate fails, the agent is not debited at all.

## End-to-end (TypeScript SDK 1.3.0)

```ts
import { SatRank } from '@satrank/sdk';
import crypto from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure'; // user-supplied signer

const sr = new SatRank({ apiBase: 'https://satrank.dev' });

// 1. Build the request body the SDK will send.
const body = {
  intent: { category: 'data/finance', keywords: ['eth-usd'] },
  max_sats: 50,
  max_latency_ms: 5000,
};

// 2. Sign the NIP-98 envelope binding the URL + method + body hash.
const u = sr.fulfillEndpoint();              // 'https://satrank.dev/api/fulfill'
const payload = crypto.createHash('sha256')
  .update(JSON.stringify(body)).digest('hex');
const event = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['u', u], ['method', 'POST'], ['payload', payload]],
  content: '',
}, secretKey);
const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;

// 3. Call.
const result = await sr.proxyFulfill({ ...body, authorization });

// 4. Switch on the typed status.
switch (result.status) {
  case 'success':
    console.log('body:', result.body, 'preimage:', result.preimage);
    break;
  case 'refunded':
    console.warn('refunded, all candidates failed:', result.reason);
    break;
  case 'insufficient_balance':
    // Top up via /api/deposit, then retry.
    break;
  case 'daily_cap_reached':
    // Wait for retry_after_sec.
    break;
  case 'circuit_breaker_open':
    // SatRank's pool below safe floor — see /api/oracle/fulfill.
    break;
}
```

Five lines of ceremony for sign + call. Zero ceremony to read the result: the discriminated union does the typing.

## End-to-end (Python SDK 1.3.0)

```python
import hashlib
import json
import asyncio
from satrank import SatRank
from nostr_sdk import Keys, finalize_event  # user-supplied signer

async def main() -> None:
    async with SatRank(api_base="https://satrank.dev") as sr:
        body = {
            "intent": {"category": "data/finance", "keywords": ["eth-usd"]},
            "max_sats": 50,
            "max_latency_ms": 5000,
        }
        u = sr.fulfill_endpoint()
        payload_hash = hashlib.sha256(json.dumps(body).encode()).hexdigest()
        # Build kind 27235 with [["u", u], ["method", "POST"], ["payload", payload_hash]]
        # via your preferred signer; result is base64-encoded JSON of the signed event.
        authorization = f"Nostr {build_nip98(secret_key, u, 'POST', payload_hash)}"
        result = await sr.proxy_fulfill(**body, authorization=authorization)
        if result["status"] == "success":
            print(result["body"], result["preimage"])
        else:
            print("non-success:", result["status"], result.get("reason"))

asyncio.run(main())
```

## Quote (preview cost without engagement)

```ts
const q = await sr.proxyFulfillQuote({
  intent: { category: 'data/finance', keywords: ['eth-usd'] },
  max_sats: 50,
});
console.log(q.candidates[0].total_estimate, q.reserve_sats_max);
```

No NIP-98 needed (read-only). Use this to decide whether to top up the deposit before launching the actual fulfill.

## Schema validation (optional)

If the operator has registered a JSON Schema on `POST /api/schemas`, the agent can pin to it:

```ts
const result = await sr.proxyFulfill({
  ...body,
  expected_schema_hash: 'sha256:0123abcd…',
  authorization,
});
```

Bodies that parse but don't match the schema → `delivery_schema_violation` → Tier 2 refund. The operator can dispute via `POST /api/dispute/:ledger_id` (NIP-98) within 24h.

## Observability

`GET /api/oracle/fulfill` (free) exposes:

- `pool` — balance, headroom, circuit_breaker_open, lifetime + 24h premium revenue / sats absorbed
- `counters` — total / success / refunded / aborted / in_flight in the last 24h
- `success_rate`, `refund_rate`
- `pool_24h.by_classification` — Tier 1 vs Tier 2 breakdown

Privacy-first: no agent_pubkey, no body content. Aggregates only.

## Status codes

| Status | HTTP | Meaning |
|---|---|---|
| `success` | 200 | Body delivered + preimage proof |
| `refunded` | 502 | All candidates failed; agent NOT debited |
| `insufficient_balance` | 402 | Top up via `/api/deposit` |
| `daily_cap_reached` | 429 | Drain protection — agent absorbed too many failed sats in 24h |
| `circuit_breaker_open` | 503 with `error: 'circuit_breaker_open'` | SatRank's pool below safe floor |

`fulfill_disabled` (503 with `error: 'fulfill_disabled'`) and `invalid_auth` (401) are genuine errors — the SDK throws.

## Limits

- Per-agent rate limit: 5 req in flight, refill 0.5/s (env-overridable)
- Per-agent daily refund cap: 100 sats for fresh agents (<30d), 10000 for established
- Body size: up to 256 KB
- Schema body cap on register: 256 KB (1MB raw enforced by the orchestrator's read)
