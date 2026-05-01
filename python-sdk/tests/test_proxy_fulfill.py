"""SDK 1.3.0 — proxy_fulfill / proxy_fulfill_quote tests.

Mirror the TS proxyFulfill.test.ts: cover every typed business outcome
(success/refunded/insufficient_balance/daily_cap_reached/circuit_breaker_open)
plus the throw-on-genuine-error path. respx fetch mock, no network.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from satrank import SatRank
from satrank.errors import SatRankError


SAMPLE = {
    "intent": {"category": "data"},
    "max_sats": 50,
    "max_latency_ms": 5000,
    "authorization": "Nostr xxx",
}


@respx.mock
async def test_proxy_fulfill_success() -> None:
    route = respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            200,
            json={
                "status": "success",
                "job_id": "j1",
                "body": "hello",
                "preimage": "p" * 64,
                "candidate_url": "https://x.example/api",
                "attempts": [],
                "sats_spent": 5,
                "premium_sats": 1,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**SAMPLE)
    assert result["status"] == "success"
    assert result["body"] == "hello"
    assert result["sats_spent"] == 5
    # Authorization header forwarded.
    sent = route.calls[0].request
    assert sent.headers.get("authorization") == "Nostr xxx"


@respx.mock
async def test_proxy_fulfill_refunded() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            502,
            json={
                "status": "refunded",
                "job_id": "j2",
                "attempts": [{"candidate_url": "x", "rank": 1, "payment_outcome": "pay_ok", "delivery_outcome": "delivery_5xx"}],
                "reason": "all_candidates_failed",
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**SAMPLE)
    assert result["status"] == "refunded"
    assert result["reason"] == "all_candidates_failed"


@respx.mock
async def test_proxy_fulfill_insufficient_balance() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            402,
            json={
                "error": "insufficient_balance",
                "required_sats": 51,
                "available_sats": 3,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**SAMPLE)
    assert result["status"] == "insufficient_balance"
    assert result["required_sats"] == 51
    assert result["available_sats"] == 3


@respx.mock
async def test_proxy_fulfill_daily_cap_reached() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            429,
            json={
                "error": "daily_cap_reached",
                "cap_sats": 100,
                "used_24h_sats": 95,
                "agent_age_bucket": "fresh",
                "retry_after_sec": 86400,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**SAMPLE)
    assert result["status"] == "daily_cap_reached"
    assert result["cap_sats"] == 100
    assert result["agent_age_bucket"] == "fresh"


@respx.mock
async def test_proxy_fulfill_circuit_breaker_open_returns_typed_status() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            503,
            json={
                "error": "circuit_breaker_open",
                "pool_balance_sats": -100,
                "min_pool_sats": 10000,
                "retry_after_sec": 300,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**SAMPLE)
    assert result["status"] == "circuit_breaker_open"
    assert result["pool_balance_sats"] == -100


@respx.mock
async def test_proxy_fulfill_disabled_503_raises() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            503,
            json={"error": "fulfill_disabled", "message": "feature flag off"},
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        with pytest.raises(SatRankError):
            await sr.proxy_fulfill(**SAMPLE)


@respx.mock
async def test_proxy_fulfill_quote_returns_data_block() -> None:
    route = respx.post("https://api.test/api/fulfill/quote").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "candidates": [
                        {
                            "rank": 1,
                            "endpoint_url": "https://x.example/a",
                            "operator_pubkey": "02" + "a" * 64,
                            "invoice_sats_estimate": 7,
                            "premium_estimate": 1,
                            "total_estimate": 8,
                            "p_e2e": 0.7,
                            "p_e2e_pessimistic": 0.5,
                            "median_latency_ms": 50,
                        }
                    ],
                    "reserve_sats_max": 11,
                    "circuit_breaker_open": False,
                }
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        q = await sr.proxy_fulfill_quote(intent={"category": "data"}, max_sats=10)
    # No Authorization header on quote (read-only).
    sent = route.calls[0].request
    assert sent.headers.get("authorization") is None
    assert len(q["candidates"]) == 1
    assert q["candidates"][0]["invoice_sats_estimate"] == 7
    assert q["reserve_sats_max"] == 11
    assert q["circuit_breaker_open"] is False


def test_fulfill_endpoint_returns_canonical_url() -> None:
    sr = SatRank(api_base="https://api.test")
    assert sr.fulfill_endpoint() == "https://api.test/api/fulfill"


# ---- SDK 1.4.0 — Phase 6 hold-invoice mode ------------------------------


HOLD_SAMPLE = {
    "intent": {"category": "data"},
    "max_sats": 50,
    "max_latency_ms": 5000,
    "authorization": "Nostr xxx",
    "mode": "hold",
}


@respx.mock
async def test_proxy_fulfill_hold_invoice_required_returns_typed_status() -> None:
    route = respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            402,
            json={
                "status": "hold_invoice_required",
                "job_id": "h1",
                "payment_request": "lnbc1...",
                "payment_hash": "a" * 64,
                "invoice_amount_sats": 12,
                "expires_at": 1714500000,
                "execute_endpoint": "/api/fulfill/h1/execute",
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**HOLD_SAMPLE)
    # mode=hold forwarded in body
    import json as _json
    sent_body = _json.loads(route.calls[0].request.content)
    assert sent_body["mode"] == "hold"
    assert result["status"] == "hold_invoice_required"
    assert result["payment_request"] == "lnbc1..."
    assert result["payment_hash"] == "a" * 64
    assert result["invoice_amount_sats"] == 12
    assert result["job_id"] == "h1"


@respx.mock
async def test_proxy_fulfill_402_insufficient_balance_still_routes_correctly_with_mode_hold() -> None:
    # Regression — the 402 dispatch must distinguish insufficient_balance
    # from hold_invoice_required by the body's `status` field, not the code.
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            402,
            json={
                "error": "insufficient_balance",
                "required_sats": 51,
                "available_sats": 3,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**HOLD_SAMPLE)
    assert result["status"] == "insufficient_balance"
    assert result["required_sats"] == 51


@respx.mock
async def test_proxy_fulfill_hold_mode_unavailable_returns_typed_status() -> None:
    respx.post("https://api.test/api/fulfill").mock(
        return_value=httpx.Response(
            503,
            json={"error": "hold_mode_unavailable", "reason": "lnd_invoicesrpc_offline"},
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill(**HOLD_SAMPLE)
    assert result["status"] == "hold_mode_unavailable"


@respx.mock
async def test_proxy_fulfill_execute_success() -> None:
    route = respx.post("https://api.test/api/fulfill/h1/execute").mock(
        return_value=httpx.Response(
            200,
            json={
                "status": "success",
                "job_id": "h1",
                "body": "world",
                "preimage": "p" * 64,
                "candidate_url": "https://x.example/api",
                "attempts": [],
                "sats_spent": 11,
                "premium_sats": 1,
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        result = await sr.proxy_fulfill_execute(
            job_id="h1",
            intent={"category": "data"},
            authorization="Nostr yyy",
        )
    sent = route.calls[0].request
    assert sent.headers.get("authorization") == "Nostr yyy"
    import json as _json
    sent_body = _json.loads(sent.content)
    assert sent_body == {"intent": {"category": "data"}}
    assert result["status"] == "success"
    assert result["body"] == "world"


def test_fulfill_execute_endpoint_returns_canonical_url() -> None:
    sr = SatRank(api_base="https://api.test")
    assert (
        sr.fulfill_execute_endpoint("h1")
        == "https://api.test/api/fulfill/h1/execute"
    )
