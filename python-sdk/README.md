# satrank — Python SDK

Python client for [SatRank](https://satrank.dev). One verb — `fulfill()` —
that discovers, pays, and reports a Lightning-native HTTP service in a single
call with a hard budget guarantee.

## Install

```bash
pip install satrank                 # core
pip install "satrank[nwc]"          # + Nostr Wallet Connect driver
```

Python 3.10+.

## Quickstart

```python
import asyncio
from satrank import SatRank
from satrank.wallet import LndWallet

async def main() -> None:
    async with SatRank(
        api_base="https://satrank.dev",
        wallet=LndWallet(
            rest_endpoint="https://127.0.0.1:8080",
            macaroon_hex="...",  # admin macaroon (hex)
        ),
        caller="my-agent",
    ) as sr:
        result = await sr.fulfill(
            intent={"category": "data/weather", "keywords": ["paris"]},
            budget_sats=50,
        )
        print(result["response_body"] if result["success"] else result["error"])

asyncio.run(main())
```

## Discovery only (no wallet)

```python
async with SatRank(api_base="https://satrank.dev", caller="explorer") as sr:
    cats = await sr.list_categories()
    res = await sr.resolve_intent(category="data/weather", limit=10)
    for c in res["candidates"]:
        print(c["rank"], c.get("price_sats"), c.get("service_name"))
```

## Wallet drivers

- `LndWallet` — LND REST, macaroon auth.
- `NwcWallet` — NIP-47 Nostr Wallet Connect (needs `satrank[nwc]`).
- `LnurlWallet` — LNbits-style HTTP wallets.

See [docs/sdk/wallet-drivers.md](../docs/sdk/wallet-drivers.md) in the repo.

## Documentation

- [Quickstart (Python)](../docs/sdk/quickstart-python.md)
- [Wallet drivers](../docs/sdk/wallet-drivers.md)
- [NLP helper (`parse_intent`)](../docs/sdk/nlp-helper.md)
- [Migration 0.2.x → 1.0](../docs/sdk/migration-0.2-to-1.0.md)

## License

MIT.
