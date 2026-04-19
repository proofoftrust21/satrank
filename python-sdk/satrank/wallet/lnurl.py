"""LnurlWallet — LNbits-compatible HTTP driver. Mirrors TS src/wallet/LnurlWallet.ts.

Generic enough to drive any "pay-this-invoice-and-poll-for-status" HTTP wallet
(LNbits, BTCPay's Greenfield API with the right config, etc.). The interesting
config surface is:

  auth_header / auth_prefix — how to authenticate (X-Api-Key, Bearer, …)
  pay_path / status_path — how to shape the endpoints
  poll_interval_ms / poll_timeout_ms — payment confirmation polling
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx

from satrank.errors import WalletError
from satrank.types import PayInvoiceResult


@dataclass
class LnurlConfig:
    base_url: str
    auth_token: str
    auth_header: str = "X-Api-Key"
    auth_prefix: str = ""
    pay_path: str = "/api/v1/payments"
    status_path_fmt: str = "/api/v1/payments/{payment_hash}"
    poll_interval_ms: int = 500
    poll_timeout_ms: int = 30_000
    extra_headers: dict[str, str] = field(default_factory=dict)


class LnurlWallet:
    def __init__(
        self,
        config: LnurlConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not config.base_url:
            raise ValueError("LnurlWallet: base_url is required")
        if not config.auth_token:
            raise ValueError("LnurlWallet: auth_token is required")
        self._cfg = config
        self._client: httpx.AsyncClient = client or httpx.AsyncClient()
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _auth_headers(self) -> dict[str, str]:
        value = (
            f"{self._cfg.auth_prefix} {self._cfg.auth_token}"
            if self._cfg.auth_prefix
            else self._cfg.auth_token
        )
        return {self._cfg.auth_header: value, **self._cfg.extra_headers}

    async def is_available(self) -> bool:
        try:
            res = await self._client.get(
                self._cfg.base_url.rstrip("/") + "/api/v1/wallet",
                headers=self._auth_headers(),
                timeout=5.0,
            )
            return res.status_code == 200
        except Exception:
            return False

    async def pay_invoice(self, bolt11: str, max_fee_sats: int) -> PayInvoiceResult:
        if not bolt11:
            raise WalletError("empty invoice", "INVALID_INVOICE")
        base = self._cfg.base_url.rstrip("/")

        try:
            res = await self._client.post(
                base + self._cfg.pay_path,
                headers={**self._auth_headers(), "Content-Type": "application/json"},
                json={"out": True, "bolt11": bolt11},
                timeout=15.0,
            )
        except httpx.RequestError as exc:
            raise WalletError(f"pay request failed: {exc}", "NETWORK_ERROR") from exc

        if res.status_code >= 400:
            raise WalletError(
                f"pay rejected: HTTP {res.status_code}",
                _lnurl_code(res.status_code),
            )
        try:
            body = res.json()
        except ValueError as exc:
            raise WalletError("pay response not JSON", "INVALID_RESPONSE") from exc

        payment_hash = body.get("payment_hash") or body.get("checking_id")
        if not payment_hash:
            raise WalletError("no payment_hash in pay response", "INVALID_RESPONSE")

        return await self._poll_status(payment_hash, max_fee_sats)

    async def _poll_status(
        self, payment_hash: str, max_fee_sats: int
    ) -> PayInvoiceResult:
        base = self._cfg.base_url.rstrip("/")
        path = self._cfg.status_path_fmt.format(payment_hash=payment_hash)
        interval = self._cfg.poll_interval_ms / 1000.0
        deadline = asyncio.get_running_loop().time() + (
            self._cfg.poll_timeout_ms / 1000.0
        )

        while True:
            try:
                res = await self._client.get(
                    base + path,
                    headers=self._auth_headers(),
                    timeout=5.0,
                )
            except httpx.RequestError as exc:
                raise WalletError(
                    f"status poll failed: {exc}", "NETWORK_ERROR"
                ) from exc
            if res.status_code >= 400:
                raise WalletError(
                    f"status check failed: HTTP {res.status_code}",
                    _lnurl_code(res.status_code),
                )
            try:
                body = res.json()
            except ValueError as exc:
                raise WalletError(
                    "status response not JSON", "INVALID_RESPONSE"
                ) from exc

            paid = body.get("paid")
            preimage = body.get("preimage") or body.get("payment_preimage") or ""
            if paid is True or (preimage and paid is None):
                fee_paid_sats = _extract_fee_sats(body)
                if fee_paid_sats > max_fee_sats:
                    raise WalletError(
                        f"fee paid ({fee_paid_sats}) exceeded cap ({max_fee_sats})",
                        "FEE_LIMIT_EXCEEDED",
                    )
                if not preimage or len(preimage) != 64:
                    raise WalletError(
                        f"invalid preimage in status: {preimage!r}", "INVALID_RESPONSE"
                    )
                return {"preimage": preimage, "fee_paid_sats": fee_paid_sats}
            if paid is False and body.get("status") == "failed":
                raise WalletError(
                    f"payment failed: {body.get('failure_reason', 'unknown')}",
                    "PAYMENT_FAILED",
                )

            if asyncio.get_running_loop().time() >= deadline:
                raise WalletError("payment status poll timed out", "TIMEOUT")
            await asyncio.sleep(interval)


def _extract_fee_sats(body: dict[str, Any]) -> int:
    if "fee_msat" in body and body["fee_msat"] is not None:
        return abs(int(body["fee_msat"])) // 1000
    if "fee" in body and body["fee"] is not None:
        return abs(int(body["fee"]))
    return 0


def _lnurl_code(status: int) -> str:
    if status == 401:
        return "UNAUTHORIZED"
    if status == 402 or status == 403:
        return "INSUFFICIENT_BALANCE"
    if status == 404:
        return "NOT_FOUND"
    return "NODE_ERROR"
