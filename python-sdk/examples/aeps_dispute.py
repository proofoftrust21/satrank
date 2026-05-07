"""AEPS §10 dispute — end-to-end worked example.

Mirrors sdk/examples/aeps-dispute.ts. Demonstrates the 4-step flow :
  1. Agent opens a content_correctness dispute (3 oracles, threshold 2)
  2. Each oracle independently signs the canonical outcome message hash
  3. Threshold reached → dispute resolves automatically + 5× slashing
     claim opens against the operator's bond
  4. Public state read confirms the resolution + claim linkage

Dependencies (this example only ; the SDK itself only requires httpx) :
  pip install satrank coincurve

Run with :
  SATRANK_API_BASE=https://satrank.dev python python-sdk/examples/aeps_dispute.py
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from datetime import datetime, timezone

from coincurve import PrivateKey  # BIP-340 Schnorr ; "pip install coincurve"

from satrank import (
    AepsDisputeNotFoundError,
    AepsOracleNotInSetError,
    AepsSignatureInvalidError,
    SatRank,
    build_nip98_event_template,
    build_outcome_message_hash,
    encode_nip98_auth_header,
)

API_BASE = os.environ.get("SATRANK_API_BASE", "https://satrank.dev")


# ---------- Keypair helpers ---------------------------------------------------


def new_keypair() -> tuple[bytes, str]:
    """Returns (secret_key_bytes, x_only_public_key_hex)."""
    sk = secrets.token_bytes(32)
    pk = PrivateKey(sk).public_key.format(compressed=True)
    # BIP-340 x-only : drop the parity byte.
    return sk, pk[1:].hex()


def nip98_sign_event(template: dict, sk: bytes) -> dict:
    """Minimal NIP-98 finalize — computes event id + Schnorr sig.

    A real implementation would use ``nostr-tools`` or ``python-nostr`` ;
    this example inlines just enough to keep the dependency surface tight.
    """
    import hashlib

    pk_hex = PrivateKey(sk).public_key.format(compressed=True)[1:].hex()
    serial = json.dumps(
        [0, pk_hex, template["created_at"], template["kind"],
         template["tags"], template["content"]],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    event_id = hashlib.sha256(serial.encode("utf-8")).hexdigest()
    sig = PrivateKey(sk).sign_schnorr(bytes.fromhex(event_id)).hex()
    return {
        "id": event_id,
        "pubkey": pk_hex,
        "kind": template["kind"],
        "created_at": template["created_at"],
        "tags": template["tags"],
        "content": template["content"],
        "sig": sig,
    }


def nip98(url: str, method: str, body_json: str, sk: bytes) -> str:
    """Build + sign + encode the Authorization header for an AEPS request."""
    tmpl = build_nip98_event_template(url=url, method=method, body=body_json)
    signed = nip98_sign_event(tmpl, sk)
    return encode_nip98_auth_header(signed)


# ---------- Main flow ---------------------------------------------------------


async def main() -> None:
    agent_sk, agent_pk = new_keypair()
    operator_sk, operator_pk = new_keypair()  # respondent — bond gets slashed
    oracles = [new_keypair() for _ in range(3)]

    async with SatRank(api_base=API_BASE) as sr:
        # 1. Open dispute
        print("1) Open content_correctness dispute (3 oracles, threshold 2)")
        body_dict = {
            "respondent_pubkey": operator_pk,
            "dispute_type": "content_correctness",
            "receipt_id": 42,
            "oracle_pubkeys": [pk for _sk, pk in oracles],
            "oracle_threshold": 2,
        }
        body_json = json.dumps(body_dict, separators=(",", ":"))
        auth = nip98(sr.dispute_endpoint(), "POST", body_json, agent_sk)
        dispute = await sr.open_dispute(**body_dict, authorization=auth)
        print(f"   dispute_id   : {dispute['dispute_id']}")
        print(f"   multiplier   : {dispute['multiplier']}×")
        print(f"   threshold    : {dispute['oracle_threshold']} of "
              f"{len(dispute['oracle_pubkeys'])}")
        expires = datetime.fromtimestamp(dispute['expires_at'], tz=timezone.utc)
        print(f"   expires_at   : {expires.isoformat()}")

        # 2. Each oracle independently signs the canonical outcome hash
        print("\n2) Oracles sign attestations independently")
        h = build_outcome_message_hash(dispute["dispute_id"], "disputant_wins")
        hash_bytes = h["hash_bytes"]

        async def attest(oracle_sk: bytes, label: str) -> None:
            sig = PrivateKey(oracle_sk).sign_schnorr(hash_bytes).hex()
            attest_body = json.dumps(
                {"outcome": "disputant_wins", "signature_hex": sig},
                separators=(",", ":"),
            )
            attest_auth = nip98(
                sr.attestation_endpoint(dispute["dispute_id"]),
                "POST",
                attest_body,
                oracle_sk,
            )
            try:
                r = await sr.submit_attestation(
                    dispute_id=dispute["dispute_id"],
                    outcome="disputant_wins",
                    signature_hex=sig,
                    authorization=attest_auth,
                )
                pk_short = PrivateKey(oracle_sk).public_key.format(compressed=True)[1:9].hex()
                print(f"   {label} ({pk_short}…) → {r['dispute_state']}")
            except AepsOracleNotInSetError:
                print(f"   {label}: oracle not in set (403)")
            except AepsSignatureInvalidError:
                print(f"   {label}: BIP-340 verify failed (400)")
            except AepsDisputeNotFoundError:
                print(f"   {label}: dispute_id unknown (404)")

        await attest(oracles[0][0], "oracle 1")
        await attest(oracles[1][0], "oracle 2")  # threshold reached here

        # 3. Public read of resolved state
        print("\n3) Public read of resolved state")
        view = await sr.get_dispute(dispute["dispute_id"])
        print(f"   state                : {view['state']}")
        print(f"   attestation_counts   : {view['attestation_counts']}")
        if view.get("resolved_at"):
            resolved = datetime.fromtimestamp(view["resolved_at"], tz=timezone.utc)
            print(f"   resolved_at          : {resolved.isoformat()}")
        print(f"   slashing claim_id    : {view.get('claim_id')}")
        # claim_id is non-null on resolved_disputant. The operator's bond
        # is reserved for the 5× slash. Settlement cron transitions
        # 'reserved' → 'executed' after a 1h grace window with the §7.2
        # distribution (80% claimant / 15% observer / 5% burned).


if __name__ == "__main__":
    asyncio.run(main())
