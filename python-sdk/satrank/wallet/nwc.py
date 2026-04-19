"""NwcWallet — Nostr Wallet Connect (NIP-47) driver. Mirrors TS src/wallet/NwcWallet.ts.

NIP-47 dance:
  1. Open WebSocket to relay from NWC URI
  2. Send REQ subscription filtered on kind=23195, #e=<request_id>
  3. Build kind=23194 event (NIP-04 encrypted payload with method=pay_invoice),
     sign via pluggable NwcSigner
  4. Publish via EVENT frame
  5. Await the kind=23195 response; decrypt; surface preimage or typed error

We don't pull in nostr libs — signing is pluggable (NwcSigner protocol) so
integrators can bring their own schnorr implementation. Encryption (NIP-04)
uses the Python stdlib via satrank.wallet._nip04.

Requires: websockets (listed in [project.optional-dependencies.nwc]).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import parse_qs, urlparse

from satrank.errors import WalletError
from satrank.types import PayInvoiceResult
from satrank.wallet._nip04 import (
    derive_public_key_x_only,
    nip04_decrypt,
    nip04_encrypt,
)


class NwcSigner(Protocol):
    """Pluggable BIP-340 schnorr signer. `sig_hex` is 64-byte hex."""

    async def sign(self, event_id_hex: str, private_key_hex: str) -> str: ...


@dataclass
class NwcConfig:
    uri: str
    signer: NwcSigner
    timeout_ms: int = 30_000


class NwcWallet:
    def __init__(self, config: NwcConfig) -> None:
        self._cfg = config
        self._parsed = parse_nwc_uri(config.uri)

    async def is_available(self) -> bool:
        try:
            import websockets
        except ImportError:
            return False
        try:
            async with websockets.connect(
                self._parsed["relay"], open_timeout=5
            ):
                return True
        except Exception:
            return False

    async def pay_invoice(self, bolt11: str, max_fee_sats: int) -> PayInvoiceResult:
        try:
            import websockets
        except ImportError as exc:
            raise WalletError(
                "NwcWallet requires 'websockets' — install satrank[nwc]",
                "DEP_MISSING",
            ) from exc

        pubkey = derive_public_key_x_only(self._parsed["secret"])
        request_payload = {
            "method": "pay_invoice",
            "params": {"invoice": bolt11, "max_fee": max_fee_sats * 1000},
        }
        content = nip04_encrypt(
            json.dumps(request_payload),
            self._parsed["secret"],
            self._parsed["wallet_pubkey"],
        )
        created_at = int(time.time())
        tags = [["p", self._parsed["wallet_pubkey"]]]
        event = {
            "kind": 23194,
            "created_at": created_at,
            "tags": tags,
            "content": content,
            "pubkey": pubkey,
        }
        event_id = _event_id(event)
        sig = await self._cfg.signer.sign(event_id, self._parsed["secret"])
        signed_event = {**event, "id": event_id, "sig": sig}

        sub_id = secrets.token_hex(8)
        req_frame = json.dumps(
            ["REQ", sub_id, {"kinds": [23195], "#e": [event_id], "limit": 1}]
        )
        event_frame = json.dumps(["EVENT", signed_event])

        async with websockets.connect(self._parsed["relay"], open_timeout=10) as ws:
            await ws.send(req_frame)
            await ws.send(event_frame)
            return await self._await_response(ws, event_id)

    async def _await_response(
        self, ws: Any, request_event_id: str
    ) -> PayInvoiceResult:
        deadline = asyncio.get_running_loop().time() + (
            self._cfg.timeout_ms / 1000.0
        )
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise WalletError("NWC response timeout", "TIMEOUT")
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError as exc:
                raise WalletError("NWC response timeout", "TIMEOUT") from exc
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(frame, list) or len(frame) < 2:
                continue
            kind = frame[0]
            if kind == "OK":
                accepted = bool(frame[2]) if len(frame) >= 3 else True
                reason = frame[3] if len(frame) >= 4 else ""
                if not accepted:
                    raise WalletError(
                        f"relay rejected event: {reason}", "RELAY_REJECTED"
                    )
                continue
            if kind == "NOTICE":
                continue
            if kind != "EVENT":
                continue
            evt = frame[2] if len(frame) >= 3 else None
            if not isinstance(evt, dict) or evt.get("kind") != 23195:
                continue
            if not any(
                isinstance(t, list)
                and len(t) >= 2
                and t[0] == "e"
                and t[1] == request_event_id
                for t in evt.get("tags", [])
            ):
                continue
            # Decrypt and parse.
            try:
                plaintext = nip04_decrypt(
                    evt["content"],
                    self._parsed["secret"],
                    self._parsed["wallet_pubkey"],
                )
                payload = json.loads(plaintext)
            except Exception as exc:
                raise WalletError(
                    f"failed to decode NWC response: {exc}", "INVALID_RESPONSE"
                ) from exc
            if payload.get("error"):
                err_code = payload["error"].get("code", "UNKNOWN")
                err_msg = payload["error"].get("message", "NWC error")
                raise WalletError(err_msg, _map_nwc_error(err_code))
            result = payload.get("result") or {}
            preimage = result.get("preimage") or ""
            if not preimage or len(preimage) != 64:
                raise WalletError(
                    f"invalid preimage from NWC: {preimage!r}", "INVALID_RESPONSE"
                )
            fees_paid = int(result.get("fees_paid", 0) or 0)
            fee_paid_sats = fees_paid // 1000  # msat → sat
            return {"preimage": preimage, "fee_paid_sats": fee_paid_sats}


def parse_nwc_uri(uri: str) -> dict[str, str]:
    """Parse `nostr+walletconnect://<wallet_pubkey>?relay=...&secret=...`."""
    u = urlparse(uri)
    if u.scheme != "nostr+walletconnect":
        raise ValueError(f"invalid NWC URI scheme: {u.scheme!r}")
    wallet_pubkey = u.netloc or u.path.lstrip("/")
    if not wallet_pubkey or len(wallet_pubkey) != 64:
        raise ValueError(f"NWC URI: invalid wallet pubkey {wallet_pubkey!r}")
    qs = parse_qs(u.query)
    relay_vals = qs.get("relay") or []
    secret_vals = qs.get("secret") or []
    if not relay_vals or not secret_vals:
        raise ValueError("NWC URI missing relay or secret query parameter")
    return {
        "wallet_pubkey": wallet_pubkey,
        "relay": relay_vals[0],
        "secret": secret_vals[0],
    }


def _event_id(event: dict[str, Any]) -> str:
    # Nostr canonical serialization for id computation.
    serial = json.dumps(
        [
            0,
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(serial.encode("utf-8")).hexdigest()


def _map_nwc_error(code: str) -> str:
    c = (code or "").upper()
    if "INSUFFICIENT" in c:
        return "INSUFFICIENT_BALANCE"
    if "QUOTA" in c or "RATE" in c:
        return "RATE_LIMITED"
    if "NOT_IMPLEMENTED" in c:
        return "NOT_IMPLEMENTED"
    if "PAYMENT_FAILED" in c or "PAYMENT" in c:
        return "PAYMENT_FAILED"
    return "UNKNOWN"
