"""SDK 1.6 AEPS helpers — canonical-bytes builders.

Mirrors sdk/tests/aepsHelpers.test.ts assertion-by-assertion. Both
SDKs read the same fixture (spec/test-vectors/dispute_outcome.json) so
TS + Python agree byte-for-byte on what the server validates.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from satrank import (
    build_nip98_event_template,
    build_outcome_message,
    build_outcome_message_hash,
    encode_nip98_auth_header,
)

VECTORS_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "spec"
    / "test-vectors"
    / "dispute_outcome.json"
)


def test_outcome_message_matches_conformance_vectors() -> None:
    fixture = json.loads(VECTORS_PATH.read_text())
    for v in fixture["vectors"]:
        canonical = build_outcome_message(v["dispute_id"], v["outcome"])
        assert canonical == v["expected_canonical"], v["name"]
        h = build_outcome_message_hash(v["dispute_id"], v["outcome"])
        assert h["hash_hex"] == v["expected_hash_hex"], v["name"]


def test_outcome_hash_is_32_bytes() -> None:
    h = build_outcome_message_hash("dis_test", "disputant_wins")
    assert len(h["hash_bytes"]) == 32


def test_outcome_hash_changes_with_outcome() -> None:
    a = build_outcome_message_hash("dis_x", "disputant_wins")
    b = build_outcome_message_hash("dis_x", "respondent_wins")
    assert a["hash_hex"] != b["hash_hex"]


def test_outcome_hash_changes_with_dispute_id() -> None:
    a = build_outcome_message_hash("dis_a", "disputant_wins")
    b = build_outcome_message_hash("dis_b", "disputant_wins")
    assert a["hash_hex"] != b["hash_hex"]


def test_nip98_template_kind_27235_with_u_method_tags() -> None:
    tmpl = build_nip98_event_template(
        url="https://api.test/api/aeps/dispute",
        method="POST",
        created_at=1700000000,
    )
    assert tmpl["kind"] == 27235
    assert tmpl["created_at"] == 1700000000
    assert tmpl["content"] == ""
    assert ["u", "https://api.test/api/aeps/dispute"] in tmpl["tags"]
    assert ["method", "POST"] in tmpl["tags"]


def test_nip98_template_omits_payload_when_body_empty_or_none() -> None:
    t1 = build_nip98_event_template(url="https://x/y", method="GET", created_at=1)
    t2 = build_nip98_event_template(
        url="https://x/y", method="GET", body="", created_at=1
    )
    assert not any(t[0] == "payload" for t in t1["tags"])
    assert not any(t[0] == "payload" for t in t2["tags"])


def test_nip98_template_payload_tag_sha256_of_body_string() -> None:
    body = '{"hello":"world"}'
    expected = hashlib.sha256(body.encode("utf-8")).hexdigest()
    tmpl = build_nip98_event_template(
        url="https://x/y", method="POST", body=body, created_at=1
    )
    payload_tag = next(t for t in tmpl["tags"] if t[0] == "payload")
    assert payload_tag[1] == expected


def test_nip98_template_payload_tag_sha256_of_body_bytes() -> None:
    body_bytes = b'{"hello":"world"}'
    expected = hashlib.sha256(body_bytes).hexdigest()
    tmpl = build_nip98_event_template(
        url="https://x/y", method="POST", body=body_bytes, created_at=1
    )
    payload_tag = next(t for t in tmpl["tags"] if t[0] == "payload")
    assert payload_tag[1] == expected


def test_nip98_template_method_uppercased() -> None:
    tmpl = build_nip98_event_template(url="https://x", method="post", created_at=1)
    assert ["method", "POST"] in tmpl["tags"]


def test_encode_nip98_auth_header_format() -> None:
    signed = {
        "id": "a" * 64,
        "pubkey": "b" * 64,
        "kind": 27235,
        "created_at": 1700000000,
        "tags": [["u", "https://x"], ["method", "GET"]],
        "content": "",
        "sig": "c" * 128,
    }
    auth = encode_nip98_auth_header(signed)
    assert auth.startswith("Nostr ")
    b64 = auth[len("Nostr ") :]
    decoded = json.loads(base64.b64decode(b64).decode("utf-8"))
    assert decoded == signed


def test_python_ts_outcome_canonical_byte_identical() -> None:
    """Sanity : the canonical message we produce here MUST match what the
    TypeScript SDK produces for the same inputs (verified via shared
    spec/test-vectors/dispute_outcome.json fixture). This test reads the
    canonical strings from the fixture — the TS SDK reads the same — and
    asserts our builder matches. Any divergence ⇒ wire format split."""
    fixture = json.loads(VECTORS_PATH.read_text())
    # The canonical strings are byte-for-byte UTF-8 equal between TS and Python.
    for v in fixture["vectors"]:
        py_canonical = build_outcome_message(v["dispute_id"], v["outcome"])
        # Sanity — UTF-8 encoded bytes match the fixture verbatim.
        assert py_canonical.encode("utf-8") == v["expected_canonical"].encode("utf-8")
