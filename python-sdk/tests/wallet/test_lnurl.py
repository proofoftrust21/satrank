"""LnurlWallet tests — mirrors TS LnurlWallet.test.ts."""

from __future__ import annotations

import httpx
import pytest
import respx

from satrank.errors import WalletError
from satrank.wallet.lnurl import LnurlConfig, LnurlWallet

BASE = "https://lnbits.test"
TOKEN = "testkey"
PREIMAGE = "a" * 64


def _cfg() -> LnurlConfig:
    return LnurlConfig(
        base_url=BASE,
        auth_token=TOKEN,
        poll_interval_ms=1,
        poll_timeout_ms=500,
    )


def test_ctor_requires_base_url() -> None:
    with pytest.raises(ValueError, match="base_url"):
        LnurlWallet(LnurlConfig(base_url="", auth_token=TOKEN))


def test_ctor_requires_auth_token() -> None:
    with pytest.raises(ValueError, match="auth_token"):
        LnurlWallet(LnurlConfig(base_url=BASE, auth_token=""))


@respx.mock
async def test_pay_invoice_happy_path() -> None:
    pay = respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(
            200, json={"payment_hash": "abc"}
        )
    )
    status = respx.get(f"{BASE}/api/v1/payments/abc").mock(
        return_value=httpx.Response(
            200, json={"paid": True, "preimage": PREIMAGE, "fee": 2}
        )
    )
    w = LnurlWallet(_cfg())
    res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert res["preimage"] == PREIMAGE
    assert res["fee_paid_sats"] == 2
    assert pay.called
    assert status.called
    # Auth header propagated:
    pay_req = pay.calls[0].request
    assert pay_req.headers["X-Api-Key"] == TOKEN


@respx.mock
async def test_pay_invoice_auth_prefix_bearer() -> None:
    pay = respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"payment_hash": "abc"})
    )
    respx.get(f"{BASE}/api/v1/payments/abc").mock(
        return_value=httpx.Response(
            200, json={"paid": True, "preimage": PREIMAGE, "fee": 0}
        )
    )
    cfg = LnurlConfig(
        base_url=BASE,
        auth_token=TOKEN,
        auth_header="Authorization",
        auth_prefix="Bearer",
        poll_interval_ms=1,
        poll_timeout_ms=500,
    )
    w = LnurlWallet(cfg)
    await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert pay.calls[0].request.headers["Authorization"] == f"Bearer {TOKEN}"


@respx.mock
async def test_pay_invoice_fee_cap_exceeded() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"payment_hash": "abc"})
    )
    respx.get(f"{BASE}/api/v1/payments/abc").mock(
        return_value=httpx.Response(
            200, json={"paid": True, "preimage": PREIMAGE, "fee": 99}
        )
    )
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "FEE_LIMIT_EXCEEDED"


@respx.mock
async def test_pay_invoice_401_unauthorized() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(401, json={"detail": "nope"})
    )
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "UNAUTHORIZED"


@respx.mock
async def test_pay_invoice_402_insufficient_balance() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(402, json={"detail": "broke"})
    )
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "INSUFFICIENT_BALANCE"


@respx.mock
async def test_pay_invoice_polls_until_paid() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"payment_hash": "abc"})
    )
    status = respx.get(f"{BASE}/api/v1/payments/abc")
    status.side_effect = [
        httpx.Response(200, json={"paid": False}),
        httpx.Response(200, json={"paid": False}),
        httpx.Response(200, json={"paid": True, "preimage": PREIMAGE, "fee": 0}),
    ]
    w = LnurlWallet(_cfg())
    res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert res["preimage"] == PREIMAGE
    assert status.call_count == 3


@respx.mock
async def test_pay_invoice_failure_status() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"payment_hash": "abc"})
    )
    respx.get(f"{BASE}/api/v1/payments/abc").mock(
        return_value=httpx.Response(
            200,
            json={"paid": False, "status": "failed", "failure_reason": "no_route"},
        )
    )
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "PAYMENT_FAILED"


@respx.mock
async def test_pay_invoice_pay_response_missing_hash() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"something_else": True})
    )
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "INVALID_RESPONSE"


async def test_pay_invoice_rejects_empty_bolt11() -> None:
    w = LnurlWallet(_cfg())
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "INVALID_INVOICE"


@respx.mock
async def test_pay_invoice_poll_timeout() -> None:
    respx.post(f"{BASE}/api/v1/payments").mock(
        return_value=httpx.Response(200, json={"payment_hash": "abc"})
    )
    respx.get(f"{BASE}/api/v1/payments/abc").mock(
        return_value=httpx.Response(200, json={"paid": False})
    )
    cfg = LnurlConfig(
        base_url=BASE,
        auth_token=TOKEN,
        poll_interval_ms=10,
        poll_timeout_ms=30,
    )
    w = LnurlWallet(cfg)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "TIMEOUT"
