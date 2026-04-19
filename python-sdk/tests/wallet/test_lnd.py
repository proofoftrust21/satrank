"""LndWallet tests — mirrors TS LndWallet.test.ts."""

from __future__ import annotations

import base64

import httpx
import pytest
import respx

from satrank.errors import WalletError
from satrank.wallet.lnd import LndWallet

REST = "https://lnd.test:8080"
MACAROON = "aabbccdd"
PREIMAGE_BYTES = bytes.fromhex("a" * 64)
PREIMAGE_B64 = base64.b64encode(PREIMAGE_BYTES).decode()


def _ok_response(fee_msat: int | None = 0, fee_sat: int | None = 0) -> dict:
    route: dict[str, int] = {}
    if fee_msat is not None:
        route["total_fees_msat"] = fee_msat
    if fee_sat is not None:
        route["total_fees"] = fee_sat
    return {
        "payment_preimage": PREIMAGE_B64,
        "payment_error": "",
        "payment_route": route,
    }


def test_ctor_requires_rest_url() -> None:
    with pytest.raises(ValueError, match="rest_url"):
        LndWallet(rest_url="", macaroon_hex=MACAROON)


def test_ctor_requires_macaroon() -> None:
    with pytest.raises(ValueError, match="macaroon_hex"):
        LndWallet(rest_url=REST, macaroon_hex="")


@respx.mock
async def test_pay_invoice_happy_path() -> None:
    route = respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(200, json=_ok_response(fee_msat=1500))
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert res["preimage"] == "a" * 64
    assert res["fee_paid_sats"] == 1
    assert route.called
    req = route.calls[0].request
    assert req.headers["Grpc-Metadata-macaroon"] == MACAROON


@respx.mock
async def test_pay_invoice_forwards_fee_limit_and_bolt11() -> None:
    route = respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(200, json=_ok_response(fee_msat=0, fee_sat=0))
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    await w.pay_invoice("lnbc20n1abc", max_fee_sats=42)
    await w.aclose()
    import json

    body = json.loads(route.calls[0].request.read())
    assert body == {
        "payment_request": "lnbc20n1abc",
        "fee_limit": {"fixed": 42},
    }


@respx.mock
async def test_pay_invoice_maps_payment_error_no_route() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(
            200,
            json={"payment_error": "unable to find a path to destination"},
        )
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "NO_ROUTE"


@respx.mock
async def test_pay_invoice_maps_payment_error_insufficient() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(
            200, json={"payment_error": "insufficient local balance"}
        )
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "INSUFFICIENT_BALANCE"


@respx.mock
async def test_pay_invoice_maps_payment_error_fee_limit() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(
            200, json={"payment_error": "fee exceeds limit"}
        )
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=1)
    await w.aclose()
    assert exc.value.code == "FEE_LIMIT_EXCEEDED"


@respx.mock
async def test_pay_invoice_http_401_unauthorized() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(401, json={"error": "bad macaroon"})
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "UNAUTHORIZED"


@respx.mock
async def test_pay_invoice_http_500_node_error() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(500, json={"error": "internal"})
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "NODE_ERROR"


@respx.mock
async def test_pay_invoice_network_error() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        side_effect=httpx.ConnectError("boom")
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "NETWORK_ERROR"


@respx.mock
async def test_pay_invoice_timeout() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        side_effect=httpx.TimeoutException("slow")
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "TIMEOUT"


async def test_pay_invoice_rejects_empty_bolt11() -> None:
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    with pytest.raises(WalletError) as exc:
        await w.pay_invoice("", max_fee_sats=10)
    await w.aclose()
    assert exc.value.code == "INVALID_INVOICE"


@respx.mock
async def test_pay_invoice_fee_from_total_fees_sat_when_msat_zero() -> None:
    respx.post(f"{REST}/v1/channels/transactions").mock(
        return_value=httpx.Response(
            200, json=_ok_response(fee_msat=0, fee_sat=7)
        )
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    await w.aclose()
    assert res["fee_paid_sats"] == 7


@respx.mock
async def test_is_available_true_on_getinfo_200() -> None:
    respx.get(f"{REST}/v1/getinfo").mock(
        return_value=httpx.Response(200, json={"identity_pubkey": "abc"})
    )
    w = LndWallet(rest_url=REST, macaroon_hex=MACAROON, verify=False)
    assert await w.is_available() is True
    await w.aclose()
