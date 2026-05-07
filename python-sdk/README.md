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

## AEPS §10 disputes (SDK 1.6.0+)

[AEPS](../spec/AEPS-whitepaper.md) is the open standard SatRank
implements. SDK 1.6.0 adds typed methods + zero-dep canonical-byte
helpers so agents drive disputes without re-deriving wire formats.

```python
import asyncio
import json
import hashlib
from coincurve import PrivateKey  # any BIP-340 lib works
from satrank import (
    SatRank,
    AepsDisputeNotFoundError,
    build_outcome_message_hash,
    build_nip98_event_template,
    encode_nip98_auth_header,
)

async def main():
    async with SatRank(api_base="https://satrank.dev") as sr:
        # 1. Open a dispute (NIP-98 auth = disputant pubkey)
        body_dict = {
            "respondent_pubkey": "<operator-pubkey-hex>",
            "dispute_type": "content_correctness",
            "receipt_id": 42,
            "oracle_pubkeys": [oracle1_pk, oracle2_pk, oracle3_pk],
            "oracle_threshold": 2,
        }
        body = json.dumps(body_dict, separators=(",", ":"))
        tmpl = build_nip98_event_template(
            url=sr.dispute_endpoint(),
            method="POST",
            body=body,
        )
        signed = sign_nip98_event(tmpl, agent_sk)  # agent's signer
        auth = encode_nip98_auth_header(signed)
        dispute = await sr.open_dispute(**body_dict, authorization=auth)

        # 2. Each oracle signs the canonical outcome message hash
        hash_bytes = build_outcome_message_hash(
            dispute["dispute_id"], "disputant_wins"
        )["hash_bytes"]
        sig = oracle_pk.sign_schnorr(hash_bytes).hex()

        # 3. Submit attestation (NIP-98 auth = oracle pubkey)
        attest_body = json.dumps(
            {"outcome": "disputant_wins", "signature_hex": sig},
            separators=(",", ":"),
        )
        attest_tmpl = build_nip98_event_template(
            url=sr.attestation_endpoint(dispute["dispute_id"]),
            method="POST",
            body=attest_body,
        )
        attest_auth = encode_nip98_auth_header(
            sign_nip98_event(attest_tmpl, oracle_sk)
        )
        try:
            r = await sr.submit_attestation(
                dispute_id=dispute["dispute_id"],
                outcome="disputant_wins",
                signature_hex=sig,
                authorization=attest_auth,
            )
            if r["dispute_state"] == "resolved_disputant":
                print("Slashing claim opens against operator bond")
        except AepsDisputeNotFoundError:
            ...

        # 4. Public read of dispute state (no auth)
        view = await sr.get_dispute(dispute["dispute_id"])
        print(view["attestation_counts"], view["state"])

asyncio.run(main())
```

Typed errors : `AepsDisputeNotFoundError` (404), `AepsDisputeNotOpenError`
(409), `AepsOracleNotInSetError` (403), `AepsSignatureInvalidError` (400).

The SDK depends only on `httpx`. BIP-340 Schnorr signing + Nostr event
finalization are the agent's responsibility — pick `coincurve`,
`secp256k1`, or any conformant lib.

## License

MIT.
