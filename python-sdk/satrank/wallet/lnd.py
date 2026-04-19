"""LndWallet — REST driver for lnd/lnrpc. Mirrors TS src/wallet/LndWallet.ts.

Uses LND's POST /v1/channels/transactions (SendPaymentSync) with the
Grpc-Metadata-macaroon header. Zero extra deps (httpx only; already pulled in).
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

import httpx

from satrank.errors import WalletError
from satrank.types import PayInvoiceResult


class LndWallet:
    """LND REST wallet driver.

    Args:
      rest_url: base URL of LND REST (e.g. "https://127.0.0.1:8080").
      macaroon_hex: admin or custom-baked macaroon as hex.
      verify: TLS verify — pass False or a path to the lnd tls.cert.
      client: pre-configured httpx.AsyncClient (overrides verify).
    """

    def __init__(
        self,
        *,
        rest_url: str,
        macaroon_hex: str,
        verify: bool | str = True,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not rest_url:
            raise ValueError("LndWallet: rest_url is required")
        if not macaroon_hex:
            raise ValueError("LndWallet: macaroon_hex is required")
        self._rest_url = rest_url.rstrip("/")
        self._macaroon = macaroon_hex
        self._client: httpx.AsyncClient = client or httpx.AsyncClient(verify=verify)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def is_available(self) -> bool:
        try:
            res = await self._client.get(
                f"{self._rest_url}/v1/getinfo",
                headers={"Grpc-Metadata-macaroon": self._macaroon},
                timeout=5.0,
            )
            return res.status_code == 200
        except Exception:
            return False

    async def pay_invoice(self, bolt11: str, max_fee_sats: int) -> PayInvoiceResult:
        if not bolt11:
            raise WalletError("empty invoice", "INVALID_INVOICE")

        payload: dict[str, Any] = {
            "payment_request": bolt11,
            "fee_limit": {"fixed": max_fee_sats},
        }
        try:
            res = await self._client.post(
                f"{self._rest_url}/v1/channels/transactions",
                headers={
                    "Grpc-Metadata-macaroon": self._macaroon,
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60.0,
            )
        except httpx.TimeoutException as exc:
            raise WalletError(f"LND timeout: {exc}", "TIMEOUT") from exc
        except httpx.RequestError as exc:
            raise WalletError(f"LND request failed: {exc}", "NETWORK_ERROR") from exc

        if res.status_code != 200:
            try:
                body = res.json()
            except ValueError:
                body = {}
            msg = body.get("error") or body.get("message") or f"HTTP {res.status_code}"
            raise WalletError(f"LND REST error: {msg}", _lnd_http_code(res.status_code))

        body = res.json()
        # LND returns payment_error as non-empty string on failure (payment hop).
        err = body.get("payment_error") or ""
        if err:
            raise WalletError(f"LND payment_error: {err}", _lnd_payment_error_code(err))

        preimage_b64 = body.get("payment_preimage") or ""
        try:
            preimage_bytes = base64.b64decode(preimage_b64)
        except (binascii.Error, ValueError) as exc:
            raise WalletError(
                f"malformed preimage from LND: {preimage_b64!r}", "INVALID_RESPONSE"
            ) from exc
        preimage_hex = preimage_bytes.hex()
        if len(preimage_hex) != 64:
            raise WalletError(
                f"unexpected preimage length {len(preimage_hex)}", "INVALID_RESPONSE"
            )

        route = body.get("payment_route") or {}
        fee_msat = int(route.get("total_fees_msat", 0) or 0)
        fee_sat = int(route.get("total_fees", 0) or 0)
        fee_paid_sats = fee_sat if fee_msat == 0 else fee_msat // 1000

        return {"preimage": preimage_hex, "fee_paid_sats": fee_paid_sats}


def _lnd_http_code(status: int) -> str:
    if status == 401:
        return "UNAUTHORIZED"
    if status == 402:
        return "INSUFFICIENT_BALANCE"
    if status == 404:
        return "NOT_FOUND"
    if status >= 500:
        return "NODE_ERROR"
    return "NODE_ERROR"


def _lnd_payment_error_code(err: str) -> str:
    e = err.lower()
    if "insufficient" in e or "not enough" in e:
        return "INSUFFICIENT_BALANCE"
    if "no_route" in e or "no route" in e or "unable to find" in e:
        return "NO_ROUTE"
    if "fee" in e and "limit" in e:
        return "FEE_LIMIT_EXCEEDED"
    if "already" in e and "paid" in e:
        return "ALREADY_PAID"
    return "PAYMENT_FAILED"
