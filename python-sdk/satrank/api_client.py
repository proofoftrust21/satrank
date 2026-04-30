"""ApiClient — thin httpx.AsyncClient wrapper that speaks SatRank JSON.

Handles: base URL, timeout, optional L402 deposit token, typed error mapping.
Mirrors @satrank/sdk/client/apiClient.ts.
"""

from __future__ import annotations

from typing import Any

import httpx

from satrank.errors import NetworkError, error_from_response
from satrank.errors import TimeoutError as SatRankTimeout
from satrank.types import IntentCategoriesResponse, IntentResponse


class ApiClient:
    """Typed HTTP client for /api/intent, /api/intent/categories, /api/report."""

    def __init__(
        self,
        *,
        api_base: str,
        client: httpx.AsyncClient | None = None,
        request_timeout_ms: int = 10_000,
        deposit_token: str | None = None,
    ) -> None:
        self._api_base = api_base.rstrip("/")
        self._deposit_token = deposit_token
        self._timeout = request_timeout_ms / 1000.0
        self._client: httpx.AsyncClient = client or httpx.AsyncClient(
            timeout=self._timeout
        )
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> ApiClient:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()

    # ---- public endpoints ------------------------------------------------

    async def get_intent_categories(self) -> IntentCategoriesResponse:
        payload = await self._request("GET", "/api/intent/categories")
        return payload  # type: ignore[return-value]

    async def post_intent(
        self,
        *,
        category: str,
        keywords: list[str] | None = None,
        budget_sats: int | None = None,
        max_latency_ms: int | None = None,
        caller: str | None = None,
        limit: int | None = None,
    ) -> IntentResponse:
        body: dict[str, Any] = {"category": category}
        if keywords is not None:
            body["keywords"] = keywords
        if budget_sats is not None:
            body["budget_sats"] = budget_sats
        if max_latency_ms is not None:
            body["max_latency_ms"] = max_latency_ms
        if caller is not None:
            body["caller"] = caller
        if limit is not None:
            body["limit"] = limit
        payload = await self._request("POST", "/api/intent", json=body)
        return payload  # type: ignore[return-value]

    async def post_report(
        self,
        *,
        target: str,
        outcome: str,
        preimage: str | None = None,
        bolt11_raw: str | None = None,
        amount_bucket: str | None = None,
    ) -> dict[str, Any]:
        if not self._deposit_token:
            # Parity with TS — auth required for /api/report.
            raise ValueError(
                "post_report requires deposit_token on SatRank() constructor"
            )
        body: dict[str, Any] = {"target": target, "outcome": outcome}
        if preimage is not None:
            body["preimage"] = preimage
        if bolt11_raw is not None:
            body["bolt11Raw"] = bolt11_raw
        if amount_bucket is not None:
            body["amountBucket"] = amount_bucket
        return await self._request(
            "POST",
            "/api/report",
            json=body,
            extra_headers={"Authorization": self._deposit_token},
        )

    async def post_services_register(
        self,
        *,
        url: str,
        authorization: str,
        name: str | None = None,
        description: str | None = None,
        category: str | None = None,
        provider: str | None = None,
    ) -> dict[str, Any]:
        """SDK 1.2.0 — operator self-listing via NIP-98.

        The Authorization header MUST be pre-signed by the caller (a kind
        27235 NIP-98 event base64-encoded as `Nostr <b64>`). The SDK is
        zero-runtime-dep in the TS sibling and likewise minimal here — we
        do not bundle a Nostr signer; use any of the standard tools
        (e.g. `nostr-tools` / `pynostr`) to produce the envelope.

        Errors raised:
        - Nip98InvalidError (401, NIP98_INVALID): signature missing /
          malformed / expired / replayed.
        - OwnershipMismatchError (403, OWNERSHIP_MISMATCH): the endpoint
          declares a different `nostr-pubkey` in WWW-Authenticate
          (audit Tier 4N — cryptographic ownership proof).
        - AlreadyClaimedError (409, ALREADY_CLAIMED): the URL was already
          claimed by another npub under first-claim semantics.
        """
        body: dict[str, Any] = {"url": url}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if category is not None:
            body["category"] = category
        if provider is not None:
            body["provider"] = provider
        return await self._request(
            "POST",
            "/api/services/register",
            json=body,
            extra_headers={"Authorization": authorization},
        )

    # ---- internals -------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        url = self._api_base + path
        headers: dict[str, str] = {"Accept": "application/json"}
        if json is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        try:
            res = await self._client.request(
                method,
                url,
                headers=headers,
                json=json,
                timeout=self._timeout,
            )
        except httpx.TimeoutException as exc:
            raise SatRankTimeout(f"request to {url} timed out") from exc
        except httpx.RequestError as exc:
            raise NetworkError(f"network error calling {url}: {exc}") from exc

        body: dict[str, Any] | None = None
        if res.content:
            ct = res.headers.get("content-type", "")
            if "application/json" in ct:
                try:
                    body = res.json()
                except ValueError:
                    body = None
            else:
                body = None

        if res.status_code >= 400:
            raise error_from_response(res.status_code, body)

        # Some endpoints (legacy) wrap in { "data": {...} }. Unwrap only when
        # that's the only top-level key and "error" is absent.
        if isinstance(body, dict) and set(body.keys()) == {"data"}:
            inner = body["data"]
            if isinstance(inner, dict):
                return inner
        return body or {}
