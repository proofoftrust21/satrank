"""ApiClient HTTP behaviour — mirrors TS apiClient.test.ts. Uses respx."""

from __future__ import annotations

import httpx
import pytest
import respx

from satrank.api_client import ApiClient
from satrank.errors import (
    BalanceExhaustedError,
    PaymentRequiredError,
    RateLimitedError,
    UnauthorizedError,
    ValidationSatRankError,
)


@respx.mock
async def test_get_intent_categories() -> None:
    respx.get("https://api.test/api/intent/categories").mock(
        return_value=httpx.Response(
            200,
            json={"categories": [{"name": "data", "endpoint_count": 1, "active_count": 1}]},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        res = await api.get_intent_categories()
        assert res["categories"][0]["name"] == "data"


@respx.mock
async def test_post_intent_sends_full_body() -> None:
    route = respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json={
                "intent": {"category": "data", "keywords": [], "resolved_at": 1},
                "candidates": [],
                "meta": {
                    "total_matched": 0,
                    "returned": 0,
                    "strictness": "strict",
                    "warnings": [],
                },
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        await api.post_intent(
            category="data",
            keywords=["weather"],
            budget_sats=100,
            max_latency_ms=2000,
            caller="test",
            limit=5,
        )
    assert route.called
    body = route.calls[0].request.read()
    import json

    parsed = json.loads(body)
    assert parsed == {
        "category": "data",
        "keywords": ["weather"],
        "budget_sats": 100,
        "max_latency_ms": 2000,
        "caller": "test",
        "limit": 5,
    }


@respx.mock
async def test_post_intent_omits_optional_fields() -> None:
    route = respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json={
                "intent": {"category": "data", "resolved_at": 1},
                "candidates": [],
                "meta": {
                    "total_matched": 0,
                    "returned": 0,
                    "strictness": "strict",
                    "warnings": [],
                },
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        await api.post_intent(category="data")
    body = route.calls[0].request.read()
    import json

    assert json.loads(body) == {"category": "data"}


@respx.mock
async def test_error_400_maps_to_validation() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            400, json={"error": {"code": "BAD_CATEGORY", "message": "nope"}}
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(ValidationSatRankError) as exc:
            await api.post_intent(category="")
        assert exc.value.code == "BAD_CATEGORY"


@respx.mock
async def test_error_401_maps_to_unauthorized() -> None:
    respx.post("https://api.test/api/report").mock(
        return_value=httpx.Response(
            401, json={"error": {"code": "UNAUTHORIZED", "message": "no token"}}
        )
    )
    async with ApiClient(api_base="https://api.test", deposit_token="L402 t:p") as api:
        with pytest.raises(UnauthorizedError):
            await api.post_report(target="x", outcome="success")


@respx.mock
async def test_error_402_maps_to_payment_required() -> None:
    respx.get("https://api.test/api/intent/categories").mock(
        return_value=httpx.Response(
            402, json={"error": {"code": "PAYMENT_REQUIRED", "message": "pay up"}}
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(PaymentRequiredError):
            await api.get_intent_categories()


@respx.mock
async def test_error_403_maps_to_balance_exhausted() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "BALANCE_EXHAUSTED", "message": "broke"}}
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(BalanceExhaustedError):
            await api.post_intent(category="data")


@respx.mock
async def test_error_429_maps_to_rate_limited() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            429, json={"error": {"code": "RATE_LIMITED", "message": "slow down"}}
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(RateLimitedError):
            await api.post_intent(category="data")


@respx.mock
async def test_post_report_adds_auth_header() -> None:
    route = respx.post("https://api.test/api/report").mock(
        return_value=httpx.Response(200, json={"data": {"ok": True}})
    )
    async with ApiClient(
        api_base="https://api.test", deposit_token="L402 deposit:preimage"
    ) as api:
        await api.post_report(
            target="t",
            outcome="success",
            preimage="a" * 64,
            bolt11_raw="lnbc10n1",
            amount_bucket="micro",
        )
    auth = route.calls[0].request.headers.get("authorization")
    assert auth == "L402 deposit:preimage"


async def test_post_report_requires_deposit_token() -> None:
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(ValueError, match="deposit_token"):
            await api.post_report(target="t", outcome="success")


@respx.mock
async def test_unwraps_data_envelope() -> None:
    respx.get("https://api.test/api/intent/categories").mock(
        return_value=httpx.Response(
            200,
            json={"data": {"categories": [{"name": "x", "endpoint_count": 0, "active_count": 0}]}},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        res = await api.get_intent_categories()
        assert res["categories"][0]["name"] == "x"


@respx.mock
async def test_timeout_raises_satrank_timeout() -> None:
    from satrank.errors import TimeoutError as SatRankTimeout

    respx.post("https://api.test/api/intent").mock(
        side_effect=httpx.TimeoutException("slow")
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(SatRankTimeout):
            await api.post_intent(category="data")


@respx.mock
async def test_network_error_mapped() -> None:
    from satrank.errors import NetworkError

    respx.post("https://api.test/api/intent").mock(
        side_effect=httpx.ConnectError("boom")
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(NetworkError):
            await api.post_intent(category="data")
