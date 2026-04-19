# Wallet drivers

`sr.fulfill()` needs a `Wallet` to pay BOLT11 invoices. The SDK ships three
drivers, all implementing the same narrow contract:

| Driver | Backend | Custodial? | Best for |
|---|---|---|---|
| `LndWallet` | Your own LND node via REST | Self-hosted | Operators running their own LN node. Lowest-trust, highest-throughput. |
| `NwcWallet` | Any NWC provider (Alby, Mutiny, CoinOS, Minibits, …) | Depends on provider | Agents that don't run LND, want a portable connection string. |
| `LnurlWallet` | LNbits-compatible HTTP | Custodial | Hobbyists / LNbits hosts / BTCPay Lightning proxy. |

## Contract (all three satisfy this)

**TypeScript**:

```typescript
interface Wallet {
  payInvoice(bolt11: string, maxFeeSats: number): Promise<{
    preimage: string;      // 64 hex chars
    feePaidSats: number;   // sats actually paid in routing fees
  }>;
  isAvailable(): Promise<boolean>;
}
```

**Python** (`satrank.types.Wallet`, `@runtime_checkable` Protocol):

```python
class Wallet(Protocol):
    async def pay_invoice(self, bolt11: str, max_fee_sats: int) -> PayInvoiceResult: ...
    async def is_available(self) -> bool: ...
```

`max_fee_sats` is a **hard ceiling** — the driver must raise `WalletError` with
code `FEE_LIMIT_EXCEEDED` rather than silently overspending.

## Choosing a driver

**Run your own LND?** → `LndWallet`. You get streaming gRPC-on-REST perf, no
third-party trust, and full control over fee/route policy.

**Use Alby / Mutiny / any NWC-enabled wallet?** → `NwcWallet`. One
`nostr+walletconnect://` URI is all the config the agent needs.

**Already have LNbits or BTCPay Lightning?** → `LnurlWallet`. HTTP polling,
adapts to almost any pay-this-invoice-and-poll API via config.

If you want to route the pay call elsewhere (custom custodian, HSM, …),
implement the 2-method `Wallet` interface yourself. The SDK never introspects
beyond `payInvoice` + `isAvailable`.

---

## LndWallet

### TypeScript

```typescript
import { LndWallet } from '@satrank/sdk/wallet';

const wallet = new LndWallet({
  restEndpoint: 'https://127.0.0.1:8080',
  macaroonHex: process.env.LND_MACAROON!,          // xxd -ps -u -c 1000 admin.macaroon
  timeout_ms: 60_000,
  // Self-signed TLS? Pass a custom fetch:
  // fetch: (await import('undici')).fetch,
});
```

### Python

```python
from satrank.wallet.lnd import LndWallet

wallet = LndWallet(
    rest_url="https://127.0.0.1:8080",
    macaroon_hex=os.environ["LND_MACAROON"],
    verify=False,           # or path to tls.cert
)
# Later:
await wallet.aclose()
```

### Which macaroon?

`admin.macaroon` is simplest but has excessive scope. For production agents,
bake a macaroon with only `offchain:write` + `info:read`:

```bash
lncli bakemacaroon offchain:write info:read --save_to=agent.macaroon
xxd -ps -u -c 1000 agent.macaroon
```

### Error codes (`WalletError.code`)

- `INSUFFICIENT_BALANCE`, `NO_ROUTE`, `FEE_LIMIT_EXCEEDED`, `ALREADY_PAID`
- `UNAUTHORIZED` (bad macaroon), `NODE_ERROR` (5xx), `TIMEOUT`, `NETWORK_ERROR`

---

## NwcWallet

Bring your own BIP-340 signer — the SDK stays zero-runtime-deps on the TS side
and NWC-optional (`pip install "satrank[nwc]"`) on the Python side.

### TypeScript

```typescript
import { NwcWallet } from '@satrank/sdk/wallet';
import { WebSocket } from 'ws';                   // Node < 22 needs this
import { schnorr } from '@noble/curves/secp256k1'; // tiny, audited

const wallet = new NwcWallet({
  uri: process.env.NWC_URI!,                      // nostr+walletconnect://...
  webSocket: WebSocket as any,
  signer: {
    schnorrSign: async (msg, privHex) =>
      Buffer.from(schnorr.sign(msg, Buffer.from(privHex, 'hex'))).toString('hex'),
  },
});
```

### Python

```python
from satrank.wallet.nwc import NwcWallet, NwcConfig

class MySigner:
    async def sign(self, event_id_hex: str, private_key_hex: str) -> str:
        # Call out to @noble-equivalent (e.g. coincurve, secp256k1, noble-python…).
        # Must return a 64-byte (128 hex) BIP-340 schnorr signature.
        ...

wallet = NwcWallet(NwcConfig(uri=os.environ["NWC_URI"], signer=MySigner()))
```

### Where to get a URI

- **Alby** → Settings → Connections → Create App → copy URI
- **Mutiny** → Settings → Nostr Wallet Connect → New Connection
- **CoinOS** → Account → NWC → Create

### Error codes

- `INSUFFICIENT_BALANCE`, `RATE_LIMITED`, `PAYMENT_FAILED`, `NOT_IMPLEMENTED`
- `TIMEOUT`, `RELAY_REJECTED`, `INVALID_RESPONSE`
- `DEP_MISSING` (TS: no WebSocket ctor; Python: `pip install "satrank[nwc]"`)

---

## LnurlWallet

Optimised for LNbits but configurable enough to drive BTCPay Lightning, LNDHub,
or any pay-+-poll HTTP API.

### TypeScript

```typescript
import { LnurlWallet } from '@satrank/sdk/wallet';

const wallet = new LnurlWallet({
  baseUrl: 'https://legend.lnbits.com',
  adminKey: process.env.LNBITS_ADMIN!,   // sent as "X-Api-Key" by default
  // Overrides for other backends:
  // authHeader: 'Authorization', authPrefix: 'Bearer ',
  // payPath: '/api/v1/payments',
  // statusPath: '/api/v1/payments/{hash}',
});
```

### Python

```python
from satrank.wallet.lnurl import LnurlWallet, LnurlConfig

wallet = LnurlWallet(LnurlConfig(
    base_url="https://legend.lnbits.com",
    auth_token=os.environ["LNBITS_ADMIN"],
    # Bearer instead of X-Api-Key:
    # auth_header="Authorization", auth_prefix="Bearer",
    poll_interval_ms=500,
    poll_timeout_ms=30_000,
))
```

### Why polling?

LNbits' HTTP API is fire-and-forget — we POST the invoice, then poll
`GET /api/v1/payments/{hash}` until `paid=true`. Configure the two timeouts:
`poll_interval_ms` (default 500/1000ms) and `poll_timeout_ms` (30s/60s). The
driver raises `WalletError(code="TIMEOUT")` if it hasn't observed a confirmed
payment by the deadline.

### Error codes

- `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `NOT_FOUND`, `NODE_ERROR`
- `PAYMENT_FAILED`, `FEE_LIMIT_EXCEEDED`, `TIMEOUT`
- `INVALID_RESPONSE` (non-JSON / missing fields), `NETWORK_ERROR`

---

## Fee budget — how `max_fee_sats` flows

```
sr.fulfill({ budget_sats: 50, max_fee_sats: 5, ... })
  └─▶ candidate #1 invoice = 30 sats
      ├─ amount check: 30 ≤ 50 remaining ✓
      └─ wallet.payInvoice(bolt11, maxFeeSats=5)
          └─ LND fee_limit.fixed = 5
          └─ LNURL polls fee, raises FEE_LIMIT_EXCEEDED if > 5
          └─ NWC sends max_fee=5000 msat in the request payload
```

Every driver respects `max_fee_sats` the same way: if the wallet tries to pay
more, it **must raise** `WalletError(code="FEE_LIMIT_EXCEEDED")` — never
silently overspend.

## Channel-safety rule

If you're developing against a real LN node and want to exercise `fulfill()`
without risking actual sats, see `sdk/scripts/checkpoint1-demo.ts` and
`python-sdk/scripts/checkpoint3-demo.py` — both use a *stub* wallet that
decodes the invoice, logs it, and returns a fake preimage. The server rejects
the fake preimage on the retry but the full L402 dance gets exercised
end-to-end.
