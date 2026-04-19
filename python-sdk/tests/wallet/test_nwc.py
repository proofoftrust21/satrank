"""NwcWallet tests — URI parsing + NIP-47/NIP-04 round-trip against fake relay.

Mirrors TS NwcWallet.test.ts: we can't easily stand up a real Nostr relay in
unit tests, so we smoke-test parse_nwc_uri and the NIP-04 crypto primitives,
and simulate the relay with a patched websockets.connect that returns a scripted
sequence of frames.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest

from satrank.errors import WalletError
from satrank.wallet._nip04 import (
    derive_public_key_x_only,
    nip04_decrypt,
    nip04_encrypt,
)
from satrank.wallet.nwc import NwcConfig, NwcWallet, parse_nwc_uri

# Two random secp256k1 secrets (32 bytes hex) — deterministic for tests.
CLIENT_SECRET = "11" * 32
WALLET_SECRET = "22" * 32


def _wallet_pubkey() -> str:
    return derive_public_key_x_only(WALLET_SECRET)


# ---- URI parsing ---------------------------------------------------------

def test_parse_nwc_uri_valid() -> None:
    pk = "ab" * 32  # 64 hex chars
    uri = f"nostr+walletconnect://{pk}?relay=wss://relay.test&secret={CLIENT_SECRET}"
    parsed = parse_nwc_uri(uri)
    assert parsed["wallet_pubkey"] == pk
    assert parsed["relay"] == "wss://relay.test"
    assert parsed["secret"] == CLIENT_SECRET


def test_parse_nwc_uri_rejects_wrong_scheme() -> None:
    with pytest.raises(ValueError, match="scheme"):
        parse_nwc_uri("https://example.com")


def test_parse_nwc_uri_rejects_short_pubkey() -> None:
    with pytest.raises(ValueError, match="wallet pubkey"):
        parse_nwc_uri("nostr+walletconnect://abc?relay=wss://r&secret=x")


def test_parse_nwc_uri_rejects_missing_relay() -> None:
    pk = "ab" * 32
    with pytest.raises(ValueError, match="relay or secret"):
        parse_nwc_uri(f"nostr+walletconnect://{pk}?secret={CLIENT_SECRET}")


def test_parse_nwc_uri_rejects_missing_secret() -> None:
    pk = "ab" * 32
    with pytest.raises(ValueError, match="relay or secret"):
        parse_nwc_uri(f"nostr+walletconnect://{pk}?relay=wss://r")


# ---- NIP-04 round trip ---------------------------------------------------

def test_nip04_roundtrip() -> None:
    wallet_pub = _wallet_pubkey()
    client_pub = derive_public_key_x_only(CLIENT_SECRET)
    # client → wallet
    ct = nip04_encrypt("hello world", CLIENT_SECRET, wallet_pub)
    assert "?iv=" in ct
    # wallet decrypts
    plain = nip04_decrypt(ct, WALLET_SECRET, client_pub)
    assert plain == "hello world"


def test_nip04_decrypt_rejects_malformed() -> None:
    with pytest.raises(ValueError, match="iv"):
        nip04_decrypt("no_separator", CLIENT_SECRET, _wallet_pubkey())


# ---- NwcWallet end-to-end with fake websocket ----------------------------

class _FakeWS:
    """Tiny async context-manager fake for websockets.connect()."""

    def __init__(self, frames: list[str]) -> None:
        self._in = list(frames)
        self.sent: list[str] = []

    async def __aenter__(self) -> _FakeWS:
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def send(self, frame: str) -> None:
        self.sent.append(frame)

    async def recv(self) -> str:
        if not self._in:
            import asyncio

            await asyncio.sleep(3600)  # block indefinitely
            raise RuntimeError("unreachable")
        return self._in.pop(0)


class _StubSigner:
    async def sign(self, event_id_hex: str, private_key_hex: str) -> str:
        return "ff" * 64


def _uri() -> str:
    return (
        f"nostr+walletconnect://{_wallet_pubkey()}"
        f"?relay=wss://relay.test&secret={CLIENT_SECRET}"
    )


def _make_response_frame(
    request_event_id: str,
    payload: dict[str, Any],
    *,
    client_pubkey: str | None = None,
) -> str:
    """Encrypt `payload` as the wallet would, and wrap in an EVENT frame."""
    if client_pubkey is None:
        client_pubkey = derive_public_key_x_only(CLIENT_SECRET)
    ct = nip04_encrypt(json.dumps(payload), WALLET_SECRET, client_pubkey)
    evt = {
        "kind": 23195,
        "content": ct,
        "tags": [["e", request_event_id]],
        "pubkey": _wallet_pubkey(),
    }
    return json.dumps(["EVENT", "subid", evt])


async def test_pay_invoice_happy_path() -> None:
    preimage = "b" * 64

    # We don't know the event_id until the wallet sends it — intercept.
    captured: dict[str, str] = {}

    class _WithSniff(_FakeWS):
        async def send(self, frame: str) -> None:
            self.sent.append(frame)
            parsed = json.loads(frame)
            if parsed[0] == "EVENT":
                captured["event_id"] = parsed[1]["id"]
                # Now preload the response frame now that we know the id.
                self._in.append(
                    _make_response_frame(
                        captured["event_id"],
                        {"result": {"preimage": preimage, "fees_paid": 3000}},
                    )
                )

        async def recv(self) -> str:
            # Wait until _in is populated by the send() sniff.
            import asyncio

            while not self._in:
                await asyncio.sleep(0)
            return self._in.pop(0)

    def _connect(*_a: Any, **_kw: Any) -> _WithSniff:
        return _WithSniff([])

    with patch("websockets.connect", _connect):
        w = NwcWallet(NwcConfig(uri=_uri(), signer=_StubSigner(), timeout_ms=5_000))
        res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
    assert res["preimage"] == preimage
    assert res["fee_paid_sats"] == 3  # 3000 msat / 1000


async def test_pay_invoice_error_insufficient() -> None:
    class _WithSniff(_FakeWS):
        async def send(self, frame: str) -> None:
            self.sent.append(frame)
            parsed = json.loads(frame)
            if parsed[0] == "EVENT":
                eid = parsed[1]["id"]
                self._in.append(
                    _make_response_frame(
                        eid,
                        {"error": {"code": "INSUFFICIENT_BALANCE", "message": "broke"}},
                    )
                )

        async def recv(self) -> str:
            import asyncio

            while not self._in:
                await asyncio.sleep(0)
            return self._in.pop(0)

    def _connect(*_a: Any, **_kw: Any) -> _WithSniff:
        return _WithSniff([])

    with patch("websockets.connect", _connect):
        w = NwcWallet(NwcConfig(uri=_uri(), signer=_StubSigner(), timeout_ms=5_000))
        with pytest.raises(WalletError) as exc:
            await w.pay_invoice("lnbc10n1", max_fee_sats=10)
        assert exc.value.code == "INSUFFICIENT_BALANCE"


async def test_pay_invoice_error_rate_limited() -> None:
    class _WithSniff(_FakeWS):
        async def send(self, frame: str) -> None:
            self.sent.append(frame)
            parsed = json.loads(frame)
            if parsed[0] == "EVENT":
                eid = parsed[1]["id"]
                self._in.append(
                    _make_response_frame(
                        eid, {"error": {"code": "QUOTA_EXCEEDED", "message": "slow"}}
                    )
                )

        async def recv(self) -> str:
            import asyncio

            while not self._in:
                await asyncio.sleep(0)
            return self._in.pop(0)

    def _connect(*_a: Any, **_kw: Any) -> _WithSniff:
        return _WithSniff([])

    with patch("websockets.connect", _connect):
        w = NwcWallet(NwcConfig(uri=_uri(), signer=_StubSigner(), timeout_ms=5_000))
        with pytest.raises(WalletError) as exc:
            await w.pay_invoice("lnbc10n1", max_fee_sats=10)
        assert exc.value.code == "RATE_LIMITED"


async def test_pay_invoice_ignores_unrelated_events() -> None:
    """Wallet must skip OK/NOTICE frames and events with wrong e-tag."""
    preimage = "c" * 64
    other_id = "9" * 64  # not our request

    class _WithSniff(_FakeWS):
        async def send(self, frame: str) -> None:
            self.sent.append(frame)
            parsed = json.loads(frame)
            if parsed[0] == "EVENT":
                eid = parsed[1]["id"]
                # Inject noise first, then the real response.
                self._in.extend(
                    [
                        json.dumps(["OK", eid, True, ""]),
                        json.dumps(["NOTICE", "just saying hi"]),
                        _make_response_frame(
                            other_id, {"result": {"preimage": "a" * 64}}
                        ),  # wrong e-tag
                        _make_response_frame(
                            eid, {"result": {"preimage": preimage, "fees_paid": 0}}
                        ),
                    ]
                )

        async def recv(self) -> str:
            import asyncio

            while not self._in:
                await asyncio.sleep(0)
            return self._in.pop(0)

    def _connect(*_a: Any, **_kw: Any) -> _WithSniff:
        return _WithSniff([])

    with patch("websockets.connect", _connect):
        w = NwcWallet(NwcConfig(uri=_uri(), signer=_StubSigner(), timeout_ms=5_000))
        res = await w.pay_invoice("lnbc10n1", max_fee_sats=10)
        assert res["preimage"] == preimage


async def test_pay_invoice_relay_rejection() -> None:
    """An OK frame with accepted=False must raise RELAY_REJECTED."""

    class _WithSniff(_FakeWS):
        async def send(self, frame: str) -> None:
            self.sent.append(frame)
            parsed = json.loads(frame)
            if parsed[0] == "EVENT":
                eid = parsed[1]["id"]
                self._in.append(json.dumps(["OK", eid, False, "blocked: pow"]))

        async def recv(self) -> str:
            import asyncio

            while not self._in:
                await asyncio.sleep(0)
            return self._in.pop(0)

    def _connect(*_a: Any, **_kw: Any) -> _WithSniff:
        return _WithSniff([])

    with patch("websockets.connect", _connect):
        w = NwcWallet(NwcConfig(uri=_uri(), signer=_StubSigner(), timeout_ms=2_000))
        with pytest.raises(WalletError) as exc:
            await w.pay_invoice("lnbc10n1", max_fee_sats=10)
        assert exc.value.code == "RELAY_REJECTED"
