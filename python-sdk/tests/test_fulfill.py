"""fulfill_intent() end-to-end — mirrors TS fulfill.test.ts.

Uses respx to mock /api/intent + the candidate endpoint + /api/report.
"""

from __future__ import annotations

from typing import Any

import httpx
import respx

from satrank import SatRank
from satrank.errors import WalletError
from satrank.fulfill import parse_l402_challenge
from satrank.types import PayInvoiceResult


def make_intent_payload(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "intent": {"category": "data", "keywords": [], "resolved_at": 1},
        "candidates": [
            {
                "rank": i + 1,
                "endpoint_url": c["endpoint_url"],
                "endpoint_hash": c.get("endpoint_hash", "h" * 64),
                "operator_pubkey": c.get("operator_pubkey", "0" * 66),
                "service_name": c.get("service_name"),
                "price_sats": c.get("price_sats"),
                "median_latency_ms": None,
                "bayesian": {
                    "p_success": 0.9,
                    "ci95_low": 0.8,
                    "ci95_high": 0.95,
                    "n_obs": 50,
                    "verdict": c.get("verdict", "SAFE"),
                    "risk_profile": "low",
                    "time_constant_days": 30,
                    "last_update": 1,
                },
                "advisory": {
                    "advisory_level": "green",
                    "risk_score": 10,
                    "recommendation": "proceed",
                    "advisories": [],
                },
                "health": {
                    "reachability": 1,
                    "http_health_score": 1,
                    "health_freshness": 1,
                    "last_probe_age_sec": 5,
                },
            }
            for i, c in enumerate(candidates)
        ],
        "meta": {
            "total_matched": len(candidates),
            "returned": len(candidates),
            "strictness": "strict",
            "warnings": [],
        },
    }


class StubWallet:
    def __init__(
        self,
        *,
        preimage: str = "be" * 32,
        fee_paid_sats: int = 1,
        side_effect: type[BaseException] | None = None,
    ) -> None:
        self._preimage = preimage
        self._fee = fee_paid_sats
        self._side_effect = side_effect
        self.calls: list[tuple[str, int]] = []

    async def pay_invoice(self, bolt11: str, max_fee_sats: int) -> PayInvoiceResult:
        self.calls.append((bolt11, max_fee_sats))
        if self._side_effect:
            raise self._side_effect("failed", "NO_ROUTE")  # type: ignore[call-arg]
        return {"preimage": self._preimage, "fee_paid_sats": self._fee}

    async def is_available(self) -> bool:
        return True


# ---- parse_l402_challenge -----------------------------------------------

def test_parse_l402_canonical() -> None:
    h = 'L402 token="abc", invoice="lnbc100n1"'
    assert parse_l402_challenge(h) == ("abc", "lnbc100n1")


def test_parse_lsat_legacy() -> None:
    h = 'LSAT macaroon="MDA=", invoice="lnbc1u"'
    assert parse_l402_challenge(h) == ("MDA=", "lnbc1u")


def test_parse_l402_unquoted() -> None:
    h = "L402 token=abc, invoice=lnbc1u1pp"
    assert parse_l402_challenge(h) == ("abc", "lnbc1u1pp")


def test_parse_l402_malformed_returns_none() -> None:
    assert parse_l402_challenge("Bearer tok") is None
    assert parse_l402_challenge("L402 nope") is None
    assert parse_l402_challenge("") is None


# ---- happy path ----------------------------------------------------------

@respx.mock
async def test_happy_path_402_pay_retry() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [{"endpoint_url": "https://svc.test/x", "service_name": "WeatherCo"}]
            ),
        )
    )
    calls: list[str | None] = []

    def svc(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization")
        calls.append(auth)
        if auth is None:
            return httpx.Response(
                402,
                headers={"www-authenticate": 'L402 token="tok", invoice="lnbc100n1ok"'},
            )
        return httpx.Response(
            200,
            json={"temp_c": 14},
            headers={"content-type": "application/json"},
        )

    respx.get("https://svc.test/x").mock(side_effect=svc)

    wallet = StubWallet()
    async with SatRank(api_base="https://api.test", wallet=wallet) as sr:
        res = await sr.fulfill(intent={"category": "weather"}, budget_sats=100)
    assert res["success"] is True
    assert res["response_body"] == {"temp_c": 14}
    assert res["preimage"] == "be" * 32
    assert res["cost_sats"] == 11  # 10 sats invoice + 1 sat fee
    assert calls[0] is None
    assert calls[1] == f"L402 tok:{'be' * 32}"
    assert res["candidates_tried"][0]["outcome"] == "paid_success"


# ---- budget enforcement -------------------------------------------------

@respx.mock
async def test_abort_budget_when_invoice_too_expensive() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload([{"endpoint_url": "https://svc.test/premium"}]),
        )
    )
    respx.get("https://svc.test/premium").mock(
        return_value=httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t", invoice="lnbc1m1test"'},
        )
    )
    wallet = StubWallet()
    async with SatRank(api_base="https://api.test", wallet=wallet) as sr:
        res = await sr.fulfill(intent={"category": "premium"}, budget_sats=50)
    assert res["success"] is False
    assert len(wallet.calls) == 0
    assert res["candidates_tried"][0]["outcome"] == "abort_budget"


@respx.mock
async def test_pre_skip_when_registry_price_over_budget() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [
                    {"endpoint_url": "https://svc.test/expensive", "price_sats": 500},
                    {"endpoint_url": "https://svc.test/cheap", "price_sats": 5},
                ]
            ),
        )
    )
    hit_cheap = 0

    def cheap(_req: httpx.Request) -> httpx.Response:
        nonlocal hit_cheap
        hit_cheap += 1
        return httpx.Response(200, json={"ok": True})

    respx.get("https://svc.test/cheap").mock(side_effect=cheap)
    respx.get("https://svc.test/expensive").mock(
        return_value=httpx.Response(200, json={})
    )

    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=50)
    assert res["success"] is True
    assert res["candidates_tried"][0]["outcome"] == "abort_budget"
    assert res["candidates_tried"][1]["outcome"] == "paid_success"
    assert hit_cheap == 1


# ---- retry_policy --------------------------------------------------------

@respx.mock
async def test_next_candidate_falls_through_to_success() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [
                    {"endpoint_url": "https://fail.test/svc"},
                    {"endpoint_url": "https://ok.test/svc"},
                ]
            ),
        )
    )

    def fail_endpoint(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t1", invoice="lnbc10n1fail"'},
        )

    def ok_endpoint(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization"):
            return httpx.Response(
                200,
                json={"ok": "yes"},
                headers={"content-type": "application/json"},
            )
        return httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t2", invoice="lnbc10n1ok"'},
        )

    respx.get("https://fail.test/svc").mock(side_effect=fail_endpoint)
    respx.get("https://ok.test/svc").mock(side_effect=ok_endpoint)

    call_count = {"n": 0}

    class FlakyWallet:
        async def pay_invoice(self, bolt11: str, max_fee: int) -> PayInvoiceResult:
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise WalletError("no route", "NO_ROUTE")
            return {"preimage": "cd" * 32, "fee_paid_sats": 0}

        async def is_available(self) -> bool:
            return True

    async with SatRank(api_base="https://api.test", wallet=FlakyWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    assert res["success"] is True
    assert res["endpoint_used"]["url"] == "https://ok.test/svc"  # type: ignore[typeddict-item]
    assert [c["outcome"] for c in res["candidates_tried"]] == [
        "pay_failed",
        "paid_success",
    ]


@respx.mock
async def test_retry_policy_none_stops_after_first() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [
                    {"endpoint_url": "https://fail.test/svc"},
                    {"endpoint_url": "https://ok.test/svc"},
                ]
            ),
        )
    )
    respx.get("https://fail.test/svc").mock(
        return_value=httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t1", invoice="lnbc10n1fail"'},
        )
    )
    hits = {"c2": 0}

    def c2(_req: httpx.Request) -> httpx.Response:
        hits["c2"] += 1
        return httpx.Response(200, json={})

    respx.get("https://ok.test/svc").mock(side_effect=c2)

    wallet = StubWallet(side_effect=WalletError)
    async with SatRank(api_base="https://api.test", wallet=wallet) as sr:
        res = await sr.fulfill(
            intent={"category": "data"}, budget_sats=100, retry_policy="none"
        )
    assert res["success"] is False
    assert hits["c2"] == 0
    assert len(res["candidates_tried"]) == 1
    assert res["candidates_tried"][0]["outcome"] == "pay_failed"


# ---- auto_report ---------------------------------------------------------

@respx.mock
async def test_auto_report_posts_on_paid_success() -> None:
    endpoint_hash = "a1b2" * 16
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [{"endpoint_url": "https://svc.test/x", "endpoint_hash": endpoint_hash}]
            ),
        )
    )

    def svc(req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization"):
            return httpx.Response(
                200, json={"ok": True}, headers={"content-type": "application/json"}
            )
        return httpx.Response(
            402, headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1ok"'}
        )

    respx.get("https://svc.test/x").mock(side_effect=svc)

    report_route = respx.post("https://api.test/api/report").mock(
        return_value=httpx.Response(200, json={"data": {"ok": True}})
    )
    async with SatRank(
        api_base="https://api.test",
        wallet=StubWallet(),
        deposit_token="L402 deposit:feed",
    ) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    assert res["success"] is True
    assert res["report_submitted"] is True
    import json

    body = json.loads(report_route.calls[0].request.read())
    assert body == {
        "target": endpoint_hash,
        "outcome": "success",
        "preimage": "be" * 32,
        "bolt11Raw": "lnbc10n1ok",
        "amountBucket": "micro",
    }


@respx.mock
async def test_auto_report_skipped_without_deposit_token() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/x"}])
        )
    )

    def svc(req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization"):
            return httpx.Response(200, json={})
        return httpx.Response(
            402, headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1ok"'}
        )

    respx.get("https://svc.test/x").mock(side_effect=svc)
    report_route = respx.post("https://api.test/api/report").mock(
        return_value=httpx.Response(200, json={})
    )
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    assert res["success"] is True
    assert res["report_submitted"] is False
    assert not report_route.called


@respx.mock
async def test_auto_report_false_disables() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/x"}])
        )
    )

    def svc(req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization"):
            return httpx.Response(200, json={})
        return httpx.Response(
            402, headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1ok"'}
        )

    respx.get("https://svc.test/x").mock(side_effect=svc)
    report_route = respx.post("https://api.test/api/report").mock(
        return_value=httpx.Response(200, json={})
    )
    async with SatRank(
        api_base="https://api.test",
        wallet=StubWallet(),
        deposit_token="L402 deposit:feed",
    ) as sr:
        res = await sr.fulfill(
            intent={"category": "data"}, budget_sats=100, auto_report=False
        )
    assert res["success"] is True
    assert res["report_submitted"] is False
    assert not report_route.called


# ---- failure surfaces ----------------------------------------------------

@respx.mock
async def test_no_candidates() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(200, json=make_intent_payload([]))
    )
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "nowhere"}, budget_sats=10)
    assert res["success"] is False
    assert res["error"]["code"] == "NO_CANDIDATES"


@respx.mock
async def test_intent_failed_mapped() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            400, json={"error": {"code": "VALIDATION_ERROR", "message": "bad"}}
        )
    )
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "bad"}, budget_sats=10)
    assert res["success"] is False
    assert res["error"]["code"] == "VALIDATION_ERROR"


@respx.mock
async def test_no_invoice_on_402_without_wwwauth() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/bad"}])
        )
    )
    respx.get("https://svc.test/bad").mock(return_value=httpx.Response(402))
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    assert res["candidates_tried"][0]["outcome"] == "no_invoice"


@respx.mock
async def test_pay_failed_without_wallet() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/x"}])
        )
    )
    respx.get("https://svc.test/x").mock(
        return_value=httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t", invoice="lnbc1u1p"'},
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    assert res["candidates_tried"][0]["outcome"] == "pay_failed"
    assert "no wallet" in res["candidates_tried"][0].get("error", "")


@respx.mock
async def test_paid_failure_on_5xx() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload([{"endpoint_url": "https://svc.test/broken"}]),
        )
    )

    def broken(req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization"):
            return httpx.Response(503, text="oops")
        return httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1test"'},
        )

    respx.get("https://svc.test/broken").mock(side_effect=broken)
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(
            intent={"category": "data"}, budget_sats=100, retry_policy="none"
        )
    assert res["success"] is False
    assert res["candidates_tried"][0]["outcome"] == "paid_failure"
    assert res["candidates_tried"][0]["response_code"] == 503
    assert res["cost_sats"] == 2


# ---- edge behaviour ------------------------------------------------------

@respx.mock
async def test_max_fee_sats_forwarded_to_wallet() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/x"}])
        )
    )

    def svc(req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization"):
            return httpx.Response(200, json={})
        return httpx.Response(
            402, headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1ok"'}
        )

    respx.get("https://svc.test/x").mock(side_effect=svc)
    wallet = StubWallet()
    async with SatRank(api_base="https://api.test", wallet=wallet) as sr:
        await sr.fulfill(
            intent={"category": "data"}, budget_sats=100, max_fee_sats=42
        )
    assert wallet.calls[0][1] == 42


@respx.mock
async def test_request_method_body_headers_query_propagated() -> None:
    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200, json=make_intent_payload([{"endpoint_url": "https://svc.test/act"}])
        )
    )
    seen: list[dict[str, Any]] = []

    def svc(req: httpx.Request) -> httpx.Response:
        import json as jsonm

        body = jsonm.loads(req.read()) if req.read() else None
        seen.append(
            {
                "method": req.method,
                "url": str(req.url),
                "headers": dict(req.headers),
                "body": body,
            }
        )
        if req.headers.get("authorization"):
            return httpx.Response(
                200,
                json={"done": True},
                headers={"content-type": "application/json"},
            )
        return httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t", invoice="lnbc10n1ok"'},
        )

    respx.route(host="svc.test").mock(side_effect=svc)
    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(
            intent={"category": "data"},
            budget_sats=100,
            request={
                "method": "POST",
                "body": {"prompt": "hello"},
                "headers": {"X-Agent-Id": "agent-42"},
                "query": {"lang": "en"},
            },
        )
    assert res["success"] is True
    assert len(seen) == 2
    assert seen[0]["method"] == "POST"
    assert seen[0]["body"] == {"prompt": "hello"}
    assert seen[0]["headers"]["x-agent-id"] == "agent-42"
    assert "lang=en" in seen[0]["url"]
    assert seen[1]["headers"]["authorization"].startswith("L402 t:")


@respx.mock
async def test_ctor_caller_forwarded_to_intent() -> None:
    captured: dict[str, Any] = {}

    def intent_capture(req: httpx.Request) -> httpx.Response:
        import json as jsonm

        captured.update(jsonm.loads(req.read()))
        return httpx.Response(200, json=make_intent_payload([]))

    respx.post("https://api.test/api/intent").mock(side_effect=intent_capture)
    async with SatRank(
        api_base="https://api.test", wallet=StubWallet(), caller="agent-from-ctor"
    ) as sr:
        await sr.fulfill(intent={"category": "data"}, budget_sats=10)
    assert captured["caller"] == "agent-from-ctor"


@respx.mock
async def test_per_call_caller_overrides_ctor() -> None:
    captured: dict[str, Any] = {}

    def intent_capture(req: httpx.Request) -> httpx.Response:
        import json as jsonm

        captured.update(jsonm.loads(req.read()))
        return httpx.Response(200, json=make_intent_payload([]))

    respx.post("https://api.test/api/intent").mock(side_effect=intent_capture)
    async with SatRank(
        api_base="https://api.test", wallet=StubWallet(), caller="agent-from-ctor"
    ) as sr:
        await sr.fulfill(
            intent={"category": "data"}, budget_sats=10, caller="agent-from-call"
        )
    assert captured["caller"] == "agent-from-call"


# ---- selection_explanation (1.0.3) --------------------------------------

@respx.mock
async def test_selection_explanation_success_with_budget_alternative() -> None:
    """On success, attaches chosen + alternatives with rejection reasons."""
    cheap_url = "https://svc.test/cheap"      # rank 1, registry price > budget
    winner_url = "https://svc.test/winner"    # rank 2, succeeds

    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload(
                [
                    {"endpoint_url": cheap_url, "price_sats": 9999},
                    {"endpoint_url": winner_url, "price_sats": None, "service_name": "win"},
                ]
            ),
        )
    )

    def winner_handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization"):
            return httpx.Response(
                200,
                json={"ok": True},
                headers={"content-type": "application/json"},
            )
        return httpx.Response(
            402,
            headers={"www-authenticate": 'L402 token="t", invoice="lnbc100n1ok"'},
        )

    respx.get(winner_url).mock(side_effect=winner_handler)

    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)

    assert res["success"] is True
    sel = res.get("selection_explanation")
    assert sel is not None
    assert sel["chosen_endpoint"] == winner_url
    assert sel["chosen_score"] == 0.9
    assert sel["candidates_evaluated"] == 2
    assert len(sel["alternatives_considered"]) == 1
    assert sel["alternatives_considered"][0]["endpoint"] == cheap_url
    assert "budget" in sel["alternatives_considered"][0]["rejected_reason"]
    assert "p_success" in sel["selection_strategy"]


@respx.mock
async def test_selection_explanation_total_failure_chosen_null() -> None:
    """On total failure, chosen_* are null and all attempts appear as alternatives."""
    down_url = "https://svc.test/down"

    respx.post("https://api.test/api/intent").mock(
        return_value=httpx.Response(
            200,
            json=make_intent_payload([{"endpoint_url": down_url}]),
        )
    )
    respx.get(down_url).mock(return_value=httpx.Response(500, text="boom"))

    async with SatRank(api_base="https://api.test", wallet=StubWallet()) as sr:
        res = await sr.fulfill(intent={"category": "data"}, budget_sats=100)

    assert res["success"] is False
    sel = res.get("selection_explanation")
    assert sel is not None
    assert sel["chosen_endpoint"] is None
    assert sel["chosen_reason"] is None
    assert sel["chosen_score"] is None
    assert len(sel["alternatives_considered"]) == 1
    assert sel["alternatives_considered"][0]["endpoint"] == down_url
    assert sel["candidates_evaluated"] == 1
