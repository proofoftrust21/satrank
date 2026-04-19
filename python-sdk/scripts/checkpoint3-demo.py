"""Checkpoint 3 demo — sr.fulfill() against real prod (https://satrank.dev).

Mirrors TS sdk/scripts/checkpoint1-demo.ts.

Wallet is stubbed: we capture the real 402 challenge, decode the invoice
locally, and return a fake preimage. The 2nd call will fail (the server won't
accept our fake preimage), and we'll observe a paid_failure outcome in the
candidates_tried log. This is intentional — the goal is to demonstrate the
full L402 dance end-to-end against prod without spending real sats from the
LN node (channel-safety rule).

Run: cd python-sdk && .venv/bin/python scripts/checkpoint3-demo.py
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from satrank import SatRank
from satrank.bolt11 import decode_bolt11_amount
from satrank.types import PayInvoiceResult

PROD = "https://satrank.dev"


def _log_step(step: str, label: str, payload: Any) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    header = f"[{ts}] {step}  {label}"
    print("\n" + "━" * 80)
    print(header)
    print("─" * 80)
    if isinstance(payload, str):
        print(payload)
    else:
        try:
            print(json.dumps(payload, indent=2, default=str))
        except (TypeError, ValueError):
            print(repr(payload))


class _InstrumentedTransport(httpx.AsyncBaseTransport):
    """httpx transport that logs every outbound request + response."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self._inner = inner

    async def handle_async_request(
        self, request: httpx.Request
    ) -> httpx.Response:
        body = None
        if request.content:
            try:
                body = json.loads(request.content)
            except (ValueError, TypeError):
                body = request.content.decode("utf-8", errors="replace")[:200]
        _log_step(
            f"→ {request.method}",
            str(request.url),
            {"headers": dict(request.headers), "body": body},
        )
        t0 = time.monotonic()
        res = await self._inner.handle_async_request(request)
        dt = int((time.monotonic() - t0) * 1000)
        www = res.headers.get("www-authenticate") or res.headers.get(
            "WWW-Authenticate"
        )
        info: dict[str, Any] = {"status": res.status_code}
        if www:
            info["wwwAuth"] = www[:200] + ("…" if len(www) > 200 else "")
        _log_step(f"← {res.status_code}", f"{request.url} ({dt}ms)", info)
        return res


class _DemoWallet:
    """Stub wallet — logs the invoice, decodes amount, returns fake preimage."""

    async def is_available(self) -> bool:
        return True

    async def pay_invoice(
        self, bolt11: str, max_fee_sats: int
    ) -> PayInvoiceResult:
        amt = decode_bolt11_amount(bolt11)
        _log_step(
            "$ wallet.pay_invoice",
            "STUB (no real LN payment)",
            {
                "invoice_prefix": bolt11[:40] + "…",
                "invoice_decoded_sats": amt,
                "max_fee_sats": max_fee_sats,
                "returning": "fake preimage (server will reject auth retry)",
            },
        )
        return {"preimage": "de" * 32, "fee_paid_sats": 0}


async def main() -> None:
    print("Checkpoint 3 — Python sr.fulfill() prod demo")
    print(f"Target: {PROD}")
    print(f"Date:   {datetime.now(timezone.utc).isoformat()}\n")

    transport = _InstrumentedTransport(httpx.AsyncHTTPTransport())
    http = httpx.AsyncClient(transport=transport, timeout=30.0)

    async with SatRank(
        api_base=PROD,
        wallet=_DemoWallet(),
        caller="phase6-checkpoint3-demo-py",
        http_client=http,
    ) as sr:
        result = await sr.fulfill(
            intent={"category": "data"},
            budget_sats=50,
            timeout_ms=15_000,
            max_fee_sats=5,
            retry_policy="none",
        )
    await http.aclose()
    _log_step("✅ FINAL RESULT", "FulfillResult", result)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"Fatal: {exc!r}")
        raise
