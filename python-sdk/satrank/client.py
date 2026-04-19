"""SatRank client — public face of the SDK. Mirrors TS src/SatRank.ts."""

from __future__ import annotations

from typing import Any, cast

import httpx

from satrank.api_client import ApiClient
from satrank.fulfill import fulfill_intent
from satrank.types import (
    FulfillOptions,
    FulfillResult,
    IntentCategoriesResponse,
    IntentResponse,
    Wallet,
)


class SatRank:
    """Entry point for the SatRank SDK.

    Typical use:

        async with SatRank(api_base="https://satrank.dev", wallet=my_wallet) as sr:
            result = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
    """

    def __init__(
        self,
        *,
        api_base: str,
        wallet: Wallet | None = None,
        caller: str | None = None,
        deposit_token: str | None = None,
        request_timeout_ms: int = 10_000,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_base:
            raise ValueError("SatRank: api_base is required")
        self._api_base = api_base.rstrip("/")
        self._wallet = wallet
        self._caller = caller
        self._deposit_token = deposit_token
        self._request_timeout_ms = request_timeout_ms

        self._http: httpx.AsyncClient = http_client or httpx.AsyncClient(
            timeout=request_timeout_ms / 1000.0
        )
        self._owns_http = http_client is None
        self._api = ApiClient(
            api_base=self._api_base,
            client=self._http,
            request_timeout_ms=request_timeout_ms,
            deposit_token=deposit_token,
        )

    async def __aenter__(self) -> SatRank:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    # ---- public API -----------------------------------------------------

    async def list_categories(self) -> IntentCategoriesResponse:
        return await self._api.get_intent_categories()

    async def resolve_intent(
        self,
        *,
        category: str,
        keywords: list[str] | None = None,
        budget_sats: int | None = None,
        max_latency_ms: int | None = None,
        caller: str | None = None,
        limit: int | None = None,
    ) -> IntentResponse:
        return await self._api.post_intent(
            category=category,
            keywords=keywords,
            budget_sats=budget_sats,
            max_latency_ms=max_latency_ms,
            caller=caller or self._caller,
            limit=limit,
        )

    async def fulfill(
        self,
        *,
        intent: dict[str, Any] | None = None,
        budget_sats: int | None = None,
        **kwargs: Any,
    ) -> FulfillResult:
        """Discover, pay, and deliver a Lightning-native service call.

        Accepts kwargs mirroring FulfillOptions:
          intent, budget_sats, timeout_ms, retry_policy, auto_report, caller,
          limit, request, max_fee_sats.
        """
        if intent is None or budget_sats is None:
            raise ValueError("fulfill: intent and budget_sats are required")
        merged: dict[str, Any] = {
            "intent": intent,
            "budget_sats": budget_sats,
            **kwargs,
        }
        opts = cast(FulfillOptions, merged)
        return await fulfill_intent(
            api=self._api,
            http=self._http,
            wallet=self._wallet,
            opts=opts,
            default_caller=self._caller,
            deposit_token=self._deposit_token,
        )

    # Escape hatches for tests / advanced users.
    def _api_client(self) -> ApiClient:
        return self._api

    def _http_client(self) -> httpx.AsyncClient:
        return self._http
