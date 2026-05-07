# AEPS §10 disputes — SDK quickstart

This walkthrough takes you from zero to a resolved dispute in five
minutes. It uses [`@satrank/sdk` 1.6.0+](../../sdk) (TypeScript) and
[`satrank` 1.6.0+](../../python-sdk) (Python). The full protocol is
specified in [`spec/AEPS-whitepaper.md`](../../spec/AEPS-whitepaper.md).

## What problem does this solve

An AI agent paid an L402 endpoint via Lightning. The operator returned
content that does NOT match the schema the agent paid for (or
violated the SLA, or never delivered, or anchored a forked evidence
log). Without AEPS the agent's only recourse is to publish a bad
review and move on.

With AEPS §10, the agent **opens a dispute** referencing the receipt.
A pre-agreed **threshold of oracles** independently fetch the receipt,
validate it against the operator's published `output_schema`, and
sign their attestation. When the threshold is reached, the dispute
resolves and a **5× slashing claim** opens against the operator's
Lightning bond — automatically, on-chain enforceable, no admin in
the loop.

## Prerequisites

- An agent secret key (any 32-byte BIP-340 secp256k1 private key).
- Three oracle pubkeys you trust (you, OR three independent oracles
  whose pubkeys you registered when you paid the operator).
- The operator's pubkey + the receipt_id you want to dispute.

## TypeScript

Install :

```bash
npm install @satrank/sdk @noble/curves nostr-tools
```

```typescript
import {
  SatRank,
  AepsDisputeNotFoundError,
  AepsOracleNotInSetError,
  AepsSignatureInvalidError,
  buildOutcomeMessageHash,
  buildNip98EventTemplate,
  encodeNip98AuthHeader,
} from '@satrank/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

// 1. Setup ---------------------------------------------------------
const sr = new SatRank({ apiBase: 'https://satrank.dev' });
const agentSk = generateSecretKey();
const oracles = [generateSecretKey(), generateSecretKey(), generateSecretKey()];

// 2. Open dispute --------------------------------------------------
const openBody = JSON.stringify({
  respondent_pubkey: '<operator-pubkey-hex>',
  dispute_type: 'content_correctness',
  receipt_id: 42,
  oracle_pubkeys: oracles.map(o => Buffer.from(getPublicKey(o)).toString('hex')),
  oracle_threshold: 2,
});
const openTmpl = buildNip98EventTemplate({
  url: sr.disputeEndpoint(),
  method: 'POST',
  body: openBody,
});
const openAuth = encodeNip98AuthHeader(finalizeEvent(openTmpl, agentSk));
const dispute = await sr.openDispute(JSON.parse(openBody), openAuth);

console.log('dispute_id:', dispute.dispute_id);
console.log('multiplier:', dispute.multiplier, '×');

// 3. Each oracle signs ----------------------------------------------
const { hashBytes } = buildOutcomeMessageHash(
  dispute.dispute_id,
  'disputant_wins',
);

for (const [i, oracleSk] of oracles.entries()) {
  const sig = Buffer.from(schnorr.sign(hashBytes, oracleSk)).toString('hex');
  const body = JSON.stringify({ outcome: 'disputant_wins', signature_hex: sig });
  const tmpl = buildNip98EventTemplate({
    url: sr.attestationEndpoint(dispute.dispute_id),
    method: 'POST',
    body,
  });
  const auth = encodeNip98AuthHeader(finalizeEvent(tmpl, oracleSk));
  try {
    const r = await sr.submitAttestation(
      dispute.dispute_id,
      JSON.parse(body),
      auth,
    );
    console.log(`oracle ${i}:`, r.dispute_state);
    if (r.dispute_state !== 'open') break;  // threshold reached
  } catch (e) {
    if (e instanceof AepsOracleNotInSetError) console.error(`oracle ${i}: not in set`);
    else if (e instanceof AepsSignatureInvalidError) console.error(`oracle ${i}: bad sig`);
    else throw e;
  }
}

// 4. Read final state ----------------------------------------------
const view = await sr.getDispute(dispute.dispute_id);
console.log('state:', view.state);
console.log('claim_id:', view.claim_id, '— operator bond reserved for slash');
```

A complete runnable file lives at
[`sdk/examples/aeps-dispute.ts`](../../sdk/examples/aeps-dispute.ts).

## Python

Install :

```bash
pip install satrank coincurve
```

```python
import asyncio
import json
import secrets
import hashlib
from coincurve import PrivateKey
from satrank import (
    SatRank,
    AepsDisputeNotFoundError,
    AepsOracleNotInSetError,
    AepsSignatureInvalidError,
    build_outcome_message_hash,
    build_nip98_event_template,
    encode_nip98_auth_header,
)

def new_keypair() -> tuple[bytes, str]:
    sk = secrets.token_bytes(32)
    pk = PrivateKey(sk).public_key.format(compressed=True)
    return sk, pk[1:].hex()  # x-only

def nip98_sign_event(template: dict, sk: bytes) -> dict:
    pk_hex = PrivateKey(sk).public_key.format(compressed=True)[1:].hex()
    serial = json.dumps(
        [0, pk_hex, template["created_at"], template["kind"],
         template["tags"], template["content"]],
        separators=(",", ":"), ensure_ascii=False,
    )
    eid = hashlib.sha256(serial.encode("utf-8")).hexdigest()
    sig = PrivateKey(sk).sign_schnorr(bytes.fromhex(eid)).hex()
    return {**template, "id": eid, "pubkey": pk_hex, "sig": sig}

async def main():
    agent_sk, agent_pk = new_keypair()
    oracles = [new_keypair() for _ in range(3)]
    async with SatRank(api_base="https://satrank.dev") as sr:
        # 1. Open
        body = {
            "respondent_pubkey": "<operator-pubkey-hex>",
            "dispute_type": "content_correctness",
            "receipt_id": 42,
            "oracle_pubkeys": [pk for _, pk in oracles],
            "oracle_threshold": 2,
        }
        body_json = json.dumps(body, separators=(",", ":"))
        tmpl = build_nip98_event_template(
            url=sr.dispute_endpoint(), method="POST", body=body_json
        )
        auth = encode_nip98_auth_header(nip98_sign_event(tmpl, agent_sk))
        dispute = await sr.open_dispute(**body, authorization=auth)
        print("dispute_id:", dispute["dispute_id"])

        # 2. Oracles attest
        h = build_outcome_message_hash(dispute["dispute_id"], "disputant_wins")
        for i, (sk, _pk) in enumerate(oracles):
            sig = PrivateKey(sk).sign_schnorr(h["hash_bytes"]).hex()
            attest_body = json.dumps(
                {"outcome": "disputant_wins", "signature_hex": sig},
                separators=(",", ":"),
            )
            attest_tmpl = build_nip98_event_template(
                url=sr.attestation_endpoint(dispute["dispute_id"]),
                method="POST", body=attest_body,
            )
            attest_auth = encode_nip98_auth_header(nip98_sign_event(attest_tmpl, sk))
            try:
                r = await sr.submit_attestation(
                    dispute_id=dispute["dispute_id"],
                    outcome="disputant_wins",
                    signature_hex=sig,
                    authorization=attest_auth,
                )
                print(f"oracle {i}: {r['dispute_state']}")
                if r["dispute_state"] != "open":
                    break
            except (AepsOracleNotInSetError, AepsSignatureInvalidError) as e:
                print(f"oracle {i}: {type(e).__name__}")

        # 3. Read final state
        view = await sr.get_dispute(dispute["dispute_id"])
        print("state:", view["state"])
        print("claim_id:", view.get("claim_id"))

asyncio.run(main())
```

A complete runnable file lives at
[`python-sdk/examples/aeps_dispute.py`](../../python-sdk/examples/aeps_dispute.py).

## What happens after resolution

When the dispute resolves to `resolved_disputant`, the server :

1. **Auto-opens a slashing claim** against the respondent's
   operator bond. The claim multiplier is `dispute.multiplier`
   (1× / 3× / 5× per dispute_type) and the slash amount is
   `multiplier × disputed_amount`.
2. **Reserves bond_pending_sats** on the operator's bond. The
   reservation prevents the operator from withdrawing the bond
   below the slash amount.
3. **After a 1-hour grace window**, the
   `equivocationSlashCron` (which also handles regular dispute
   payouts) transitions the claim to `executed` and moves
   `bond_pending_sats → bond_slashed_sats`.
4. **§7.2 distribution** : 80% to the disputant, 15% to the
   observer (the first party who detected the underlying
   violation, when applicable), 5% burned (deflationary).

Disbursement of the disputant + observer shares to actual Lightning
wallets is a v0.2 follow-up ; v0.1 records the shares but does not
emit Lightning payments yet.

## Common errors

| Error | When |
|---|---|
| `AepsDisputeNotFoundError` (404) | `dispute_id` doesn't exist on the server (typo, expired purge, or you queried the wrong server) |
| `AepsDisputeNotOpenError` (409) | The dispute already resolved or expired ; new attestations are no longer accepted |
| `AepsOracleNotInSetError` (403) | The NIP-98 pubkey on the attestation request is not one of the dispute's `oracle_pubkeys` |
| `AepsSignatureInvalidError` (400) | The BIP-340 Schnorr signature did not verify against the canonical outcome message hash. Most often : signed with the wrong key, or signed a message for a different `dispute_id` / `outcome` |
| `Nip98InvalidError` (401) | The Authorization header on the open / attest request was missing, malformed, expired, or replayed |

## Equivocation : signing both outcomes

If an oracle signs `disputant_wins` AND `respondent_wins` for the same
dispute, both signatures become **publicly verifiable evidence** of
equivocation. The server :

1. Records both signatures in `aeps_oracle_equivocations`.
2. Marks the attestation row `equivocated = TRUE` ; the oracle's vote
   is excluded from threshold counting.
3. Auto-opens a 5× slashing claim against the **oracle's own**
   operator bond (oracles are operators serving in another operator's
   threshold set ; their bond backs their attestation honesty).

This is the structural reason the protocol can use cheap Schnorr
attestations instead of expensive on-chain DLC contracts : the
threat is economic, not cryptographic. Equivocate → lose your bond.

See [`spec/AEPS-whitepaper.md`](../../spec/AEPS-whitepaper.md) §10 for
the protocol-level treatment.
