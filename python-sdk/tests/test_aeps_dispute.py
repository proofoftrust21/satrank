"""SDK 1.6.0 — AEPS §10 dispute methods + typed errors. Mirrors
sdk/tests/aepsDispute.test.ts in TypeScript byte-for-byte semantics."""

from __future__ import annotations

import httpx
import pytest
import respx

from satrank import (
    AepsDisputeNotFoundError,
    AepsDisputeNotOpenError,
    AepsOracleNotInSetError,
    AepsSignatureInvalidError,
    SatRank,
)
from satrank.api_client import ApiClient


@respx.mock
async def test_post_aeps_dispute_happy_path() -> None:
    route = respx.post("https://api.test/api/aeps/dispute").mock(
        return_value=httpx.Response(
            201,
            json={
                "data": {
                    "dispute_id": "dis_" + "a" * 32,
                    "state": "open",
                    "multiplier": 5,
                    "oracle_pubkeys": ["c" * 64, "d" * 64, "e" * 64],
                    "oracle_threshold": 2,
                    "expires_at": 1700000000,
                    "outcome_messages": {
                        "disputant_wins": {
                            "canonical": '{"x":1}',
                            "hash_hex": "11" * 32,
                        },
                        "respondent_wins": {
                            "canonical": '{"y":1}',
                            "hash_hex": "22" * 32,
                        },
                    },
                }
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        res = await api.post_aeps_dispute(
            respondent_pubkey="b" * 64,
            dispute_type="content_correctness",
            oracle_pubkeys=["c" * 64, "d" * 64, "e" * 64],
            oracle_threshold=2,
            authorization="Nostr fake",
        )
    assert route.called
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Nostr fake"
    body = req.read().decode()
    assert "content_correctness" in body
    assert res["dispute_id"] == "dis_" + "a" * 32
    assert res["multiplier"] == 5
    assert res["outcome_messages"]["disputant_wins"]["hash_hex"] == "11" * 32


@respx.mock
async def test_post_aeps_dispute_omits_optional_fields() -> None:
    route = respx.post("https://api.test/api/aeps/dispute").mock(
        return_value=httpx.Response(
            201,
            json={
                "data": {
                    "dispute_id": "dis_" + "a" * 32,
                    "state": "open",
                    "multiplier": 1,
                    "oracle_pubkeys": ["c" * 64],
                    "oracle_threshold": 1,
                    "expires_at": 1700000000,
                    "outcome_messages": {
                        "disputant_wins": {"canonical": "{}", "hash_hex": "00" * 32},
                        "respondent_wins": {"canonical": "{}", "hash_hex": "00" * 32},
                    },
                }
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        await api.post_aeps_dispute(
            respondent_pubkey="b" * 64,
            dispute_type="non_payment",
            oracle_pubkeys=["c" * 64],
            oracle_threshold=1,
            authorization="Nostr fake",
        )
    req = route.calls.last.request
    body = req.read().decode()
    # Optional fields not provided → not serialized
    assert "receipt_id" not in body
    assert "fork_event_id" not in body
    assert "dispute_reason" not in body
    assert "ttl_sec" not in body


@respx.mock
async def test_post_aeps_attestation_resolves() -> None:
    respx.post(
        "https://api.test/api/aeps/dispute/dis_abc/attestation"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "dispute_id": "dis_abc",
                    "attestation_id": 7,
                    "dispute_state": "resolved_disputant",
                }
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        res = await api.post_aeps_attestation(
            dispute_id="dis_abc",
            outcome="disputant_wins",
            signature_hex="aa" * 64,
            authorization="Nostr fake",
        )
    assert res["dispute_state"] == "resolved_disputant"
    assert res["attestation_id"] == 7


@respx.mock
async def test_post_aeps_attestation_404_raises_dispute_not_found() -> None:
    respx.post(
        "https://api.test/api/aeps/dispute/dis_unknown/attestation"
    ).mock(
        return_value=httpx.Response(
            404,
            json={"error": "dispute_not_found", "message": "unknown"},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(AepsDisputeNotFoundError):
            await api.post_aeps_attestation(
                dispute_id="dis_unknown",
                outcome="disputant_wins",
                signature_hex="aa" * 64,
                authorization="Nostr fake",
            )


@respx.mock
async def test_post_aeps_attestation_409_raises_not_open() -> None:
    respx.post(
        "https://api.test/api/aeps/dispute/dis_abc/attestation"
    ).mock(
        return_value=httpx.Response(
            409,
            json={"error": "dispute_not_open", "message": "already resolved"},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(AepsDisputeNotOpenError):
            await api.post_aeps_attestation(
                dispute_id="dis_abc",
                outcome="disputant_wins",
                signature_hex="aa" * 64,
                authorization="Nostr fake",
            )


@respx.mock
async def test_post_aeps_attestation_403_raises_oracle_not_in_set() -> None:
    respx.post(
        "https://api.test/api/aeps/dispute/dis_abc/attestation"
    ).mock(
        return_value=httpx.Response(
            403,
            json={"error": "oracle_not_in_set", "message": "forbidden"},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(AepsOracleNotInSetError):
            await api.post_aeps_attestation(
                dispute_id="dis_abc",
                outcome="disputant_wins",
                signature_hex="aa" * 64,
                authorization="Nostr fake",
            )


@respx.mock
async def test_post_aeps_attestation_400_raises_signature_invalid() -> None:
    respx.post(
        "https://api.test/api/aeps/dispute/dis_abc/attestation"
    ).mock(
        return_value=httpx.Response(
            400,
            json={"error": "signature_invalid", "message": "bad sig"},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(AepsSignatureInvalidError):
            await api.post_aeps_attestation(
                dispute_id="dis_abc",
                outcome="disputant_wins",
                signature_hex="aa" * 64,
                authorization="Nostr fake",
            )


@respx.mock
async def test_get_aeps_dispute_public_no_auth() -> None:
    route = respx.get("https://api.test/api/aeps/dispute/dis_xyz").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "dispute_id": "dis_xyz",
                    "disputant_pubkey": "a" * 64,
                    "respondent_pubkey": "b" * 64,
                    "dispute_type": "sla_breach",
                    "multiplier": 3,
                    "oracle_pubkeys": ["c" * 64, "d" * 64],
                    "oracle_threshold": 2,
                    "state": "open",
                    "expires_at": 1700000000,
                    "created_at": 1699000000,
                    "resolved_at": None,
                    "claim_id": None,
                    "attestation_counts": {
                        "disputant_wins": 1,
                        "respondent_wins": 0,
                    },
                    "attestations": [
                        {
                            "oracle_pubkey": "c" * 64,
                            "outcome": "disputant_wins",
                            "signed_at": 1699500000,
                        }
                    ],
                }
            },
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        res = await api.get_aeps_dispute("dis_xyz")
    assert route.called
    # No Authorization header on a public GET
    assert "Authorization" not in route.calls.last.request.headers
    assert res["state"] == "open"
    assert res["attestation_counts"]["disputant_wins"] == 1
    assert res["attestations"][0]["outcome"] == "disputant_wins"


@respx.mock
async def test_get_aeps_dispute_404_raises_dispute_not_found() -> None:
    respx.get("https://api.test/api/aeps/dispute/dis_unknown").mock(
        return_value=httpx.Response(
            404,
            json={"error": "dispute_not_found", "message": "unknown"},
        )
    )
    async with ApiClient(api_base="https://api.test") as api:
        with pytest.raises(AepsDisputeNotFoundError):
            await api.get_aeps_dispute("dis_unknown")


@respx.mock
async def test_satrank_open_dispute_delegates_to_api_client() -> None:
    respx.post("https://api.test/api/aeps/dispute").mock(
        return_value=httpx.Response(
            201,
            json={
                "data": {
                    "dispute_id": "dis_abc",
                    "state": "open",
                    "multiplier": 5,
                    "oracle_pubkeys": ["c" * 64],
                    "oracle_threshold": 1,
                    "expires_at": 1700000000,
                    "outcome_messages": {
                        "disputant_wins": {"canonical": "{}", "hash_hex": "11" * 32},
                        "respondent_wins": {"canonical": "{}", "hash_hex": "22" * 32},
                    },
                }
            },
        )
    )
    async with SatRank(api_base="https://api.test") as sr:
        res = await sr.open_dispute(
            respondent_pubkey="b" * 64,
            dispute_type="fork",
            oracle_pubkeys=["c" * 64],
            oracle_threshold=1,
            authorization="Nostr fake",
        )
    assert res["dispute_id"] == "dis_abc"


def test_dispute_endpoint_helper() -> None:
    sr = SatRank(api_base="https://api.test")
    assert sr.dispute_endpoint() == "https://api.test/api/aeps/dispute"


def test_attestation_endpoint_helper_url_encodes() -> None:
    sr = SatRank(api_base="https://api.test")
    assert (
        sr.attestation_endpoint("dis_abc")
        == "https://api.test/api/aeps/dispute/dis_abc/attestation"
    )
