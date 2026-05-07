"""SDK 1.6 AEPS helpers — canonical-bytes builders.

Mirrors @satrank/sdk/aeps.ts byte-for-byte. Pure functions ; agents
plug in their own BIP-340 Schnorr signer (coincurve, secp256k1, etc.)
for the actual signing. The SDK ships the scaffolding so the byte
formats match what the server validates.

Two surfaces :

 1. AEPS §10 outcome message — the canonical bytes BIP-340 oracles
    attest. ``build_outcome_message`` returns the UTF-8 canonical JSON ;
    ``build_outcome_message_hash`` returns the 32-byte SHA-256 hash that
    BIP-340 actually signs.

 2. NIP-98 (kind 27235) event template + Authorization header encoding.
    ``build_nip98_event_template`` returns the unsigned event ready to
    pass to a Nostr signer ; ``encode_nip98_auth_header`` wraps the
    finalized event as ``Nostr <base64-json>``.

Both formats are conformance-vector tested against
``spec/test-vectors/dispute_outcome.json``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Literal, TypedDict

# ============================================================
# AEPS §10 — Outcome message
# ============================================================

AepsOutcome = Literal["disputant_wins", "respondent_wins"]


def build_outcome_message(dispute_id: str, outcome: AepsOutcome) -> str:
    """Canonical-JSON sorted-keys, no whitespace.

    Output : ``{"dispute_id":"<id>","outcome":"<o>","v":"AEPS-§10"}``.
    """
    # Manual canonical build — keys sort alphabetically :
    # dispute_id < outcome < v.
    return (
        "{"
        f'"dispute_id":{json.dumps(dispute_id, ensure_ascii=False)},'
        f'"outcome":{json.dumps(outcome, ensure_ascii=False)},'
        f'"v":{json.dumps("AEPS-§10", ensure_ascii=False)}'
        "}"
    )


class OutcomeMessageHash(TypedDict):
    canonical: str
    hash_hex: str
    hash_bytes: bytes


def build_outcome_message_hash(dispute_id: str, outcome: AepsOutcome) -> OutcomeMessageHash:
    """SHA-256 of the canonical bytes — the 32 bytes BIP-340 signs."""
    canonical = build_outcome_message(dispute_id, outcome)
    h = hashlib.sha256(canonical.encode("utf-8")).digest()
    return {
        "canonical": canonical,
        "hash_hex": h.hex(),
        "hash_bytes": h,
    }


# ============================================================
# NIP-98 (kind 27235) — HTTP authentication
# ============================================================


class Nip98Template(TypedDict):
    kind: int
    created_at: int
    tags: list[list[str]]
    content: str


class Nip98SignedEvent(TypedDict):
    id: str
    pubkey: str
    kind: int
    created_at: int
    tags: list[list[str]]
    content: str
    sig: str


def build_nip98_event_template(
    *,
    url: str,
    method: str,
    body: str | bytes | None = None,
    created_at: int | None = None,
) -> Nip98Template:
    """Build a kind 27235 NIP-98 event template ready to sign.

    Args :
      url : canonical URL — must equal ``req.originalUrl`` server-side.
            Use ``sr.dispute_endpoint()``, ``sr.attestation_endpoint(id)``,
            etc. so the value matches.
      method : HTTP method ("GET", "POST", ...).
      body : request body bytes EXACTLY as serialized on the wire. The
             SDK serializes via ``json.dumps()`` — agents computing the
             payload hash must use the SAME body string.
      created_at : override epoch sec. Defaults to ``time.time()``.
                   Useful when re-signing the same body — replay cache
                   needs distinct event ids ; bumping ``created_at`` is
                   the standard workaround.
    """
    tags: list[list[str]] = [
        ["u", url],
        ["method", method.upper()],
    ]
    if body is not None:
        if isinstance(body, str):
            body_bytes = body.encode("utf-8")
        else:
            body_bytes = body
        if len(body_bytes) > 0:
            payload_hash = hashlib.sha256(body_bytes).hexdigest()
            tags.append(["payload", payload_hash])
    return {
        "kind": 27235,
        "created_at": created_at if created_at is not None else int(time.time()),
        "tags": tags,
        "content": "",
    }


def encode_nip98_auth_header(signed: Nip98SignedEvent | dict[str, Any]) -> str:
    """Encode a finalized NIP-98 event as the Authorization header value :
    ``Nostr <base64-of-JSON-event>``."""
    json_bytes = json.dumps(dict(signed), separators=(",", ":")).encode("utf-8")
    return f"Nostr {base64.b64encode(json_bytes).decode('ascii')}"
