# Quickstart — Python

The `satrank` Python SDK mirrors `@satrank/sdk` 1-for-1: same method names,
same result shape, same budget guarantee. Fully async via `asyncio` + `httpx`.

## Install

```bash
pip install satrank            # core (discovery + fulfill + LND/LNURL)
pip install "satrank[nwc]"     # adds NwcWallet (websockets + cryptography)
```

Requires **Python 3.10+**.

## 10-line fulfill()

```python
import asyncio, os
from satrank import SatRank
from satrank.wallet.lnd import LndWallet

async def main() -> None:
    wallet = LndWallet(rest_url="https://127.0.0.1:8080", macaroon_hex=os.environ["LND_MACAROON"])
    async with SatRank(api_base="https://satrank.dev", wallet=wallet, caller="my-agent") as sr:
        result = await sr.fulfill(intent={"category": "data/weather"}, budget_sats=50)
        print(result["success"], result["response_body"], result["cost_sats"])
    await wallet.aclose()

asyncio.run(main())
```

`SatRank` is an async context manager — it owns its `httpx.AsyncClient` and
closes it on `__aexit__`. Pass `http_client=your_client` if you want to manage
the HTTP pool yourself.

## Result shape

`FulfillResult` is a `TypedDict` with the same fields as TS:

```python
{
    "success": bool,
    "response_body": Any | None,
    "response_code": int | None,
    "response_latency_ms": int | None,
    "cost_sats": int,                # always ≤ budget_sats
    "preimage": str | None,          # hex
    "endpoint_used": {"url": str, "service_name": str | None, "operator_pubkey": str} | None,
    "candidates_tried": list[{
        "url": str,
        "verdict": str,
        "outcome": "paid_success" | "paid_failure" | "skipped"
                   | "abort_budget" | "abort_timeout"
                   | "pay_failed" | "no_invoice" | "network_error",
        "cost_sats": int | None,
        "response_code": int | None,
        "error": str | None,
    }],
    "report_submitted": bool | None,
    "error": {"code": str, "message": str} | None,
}
```

## Discovery without a wallet

```python
async with SatRank(api_base="https://satrank.dev") as sr:
    cats = await sr.list_categories()
    for c in cats["categories"]:
        print(c["name"], c["endpoint_count"], c["active_count"])

    res = await sr.resolve_intent(
        category="bitcoin",
        max_latency_ms=2000,
        budget_sats=10,
        limit=5,
    )
    for cand in res["candidates"]:
        print(cand["rank"], cand["endpoint_url"], cand["price_sats"])
```

## Using the NLP helper

```python
from satrank.nlp import parse_intent

cats = await sr.list_categories()
names = [c["name"] for c in cats["categories"]]

parsed = parse_intent(
    "give me bitcoin price under 10 sats within 3 seconds",
    {"categories": names},
)
# parsed["intent"] == {"category": "bitcoin", "budget_sats": 10, "max_latency_ms": 3000}

result = await sr.fulfill(
    intent=parsed["intent"],
    budget_sats=parsed["intent"].get("budget_sats", 50),
)
```

See [nlp-helper.md](./nlp-helper.md) for when to use the helper.

## Wallet drivers

- `satrank.wallet.lnd.LndWallet(rest_url=..., macaroon_hex=..., verify=False, client=None)`
- `satrank.wallet.lnurl.LnurlWallet(LnurlConfig(base_url=..., auth_token=..., ...))`
- `satrank.wallet.nwc.NwcWallet(NwcConfig(uri=..., signer=..., timeout_ms=30_000))`

See [wallet-drivers.md](./wallet-drivers.md).

## Constructor options

| Option | Type | Default | Notes |
|---|---|---|---|
| `api_base` | `str` | — | Required. Usually `https://satrank.dev`. |
| `wallet` | `Wallet` | `None` | Required for `fulfill()`. |
| `caller` | `str \| None` | `None` | Overridable per-call via `fulfill(..., caller=...)`. |
| `deposit_token` | `str \| None` | `None` | `"L402 deposit:<preimage>"` — required to auto-report. |
| `http_client` | `httpx.AsyncClient \| None` | Owned internally | Pass yours to share a pool / inject transport. |
| `request_timeout_ms` | `int` | `10_000` | Per-call API timeout. |

## Typing

The package ships `py.typed` — `mypy --strict` passes through the SDK. Import
the type aliases directly:

```python
from satrank import FulfillResult, CandidateAttempt, Intent, Wallet
```

See [migration-0.2-to-1.0.md](./migration-0.2-to-1.0.md) if upgrading.
