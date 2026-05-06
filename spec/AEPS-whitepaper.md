# AEPS — Agent Evidence and Payment Standard

**A protocol for autonomous AI agents to discover, pay, and obtain cryptographic proof of fulfillment from Internet APIs without intermediaries.**

Draft v0.1 — May 2026

License: MIT (this document and all reference implementations).

---

## Abstract

The autonomous-agent economy requires machine-to-machine payment and trust without humans in the loop. Existing solutions either depend on trusted intermediaries (Stripe, Coinbase) or sacrifice content correctness for payment proof (L402, x402). AEPS specifies an open protocol where each transaction yields cryptographic proof of payment and delivery, enforceable via on-chain disputes, with all participants pseudonymous and self-custodial.

The protocol is designed under three constraints, in priority order:

1. **No trusted third party.** Every claim verifiable by any observer using Bitcoin L1 alone.
2. **Adversarial equilibrium.** Honest play is the dominant strategy under standard byzantine assumptions.
3. **Lightning-pure.** Settlement only on Lightning, only in BTC. No alt-chains, no custodial mints, no alternative units of account.

There is no AEPS Foundation. There is no AEPS Inc. There is the protocol and there are nodes.

---

## 1. Introduction

An autonomous agent calling an Internet API faces three irreducible problems:

- **Discovery.** Finding an endpoint that does what the agent needs without a centralized broker.
- **Payment.** Paying the operator with a unit of value the operator accepts, atomically against delivery.
- **Verification.** Obtaining cryptographic proof that the payment was made and the delivery occurred, durable enough to survive adversarial dispute years later.

Existing answers fall short:

- **L402** (Lightning Labs) solves payment but not delivery: an operator can serve a 402 challenge, accept payment, then return arbitrary content. The agent has no recourse.
- **x402** (Coinbase) solves payment on USDC/EVM rails but inherits chain congestion and stablecoin custody risk.
- **MCP** (Anthropic) solves discovery but punts on payment to whatever the host application implements.
- **Stripe Agent Toolkit** centralizes everything behind a US-jurisdiction custodian.

AEPS composes existing primitives — Lightning hold-invoices, Nostr public keys, Ed25519 signatures, Bitcoin L1 timestamping, Discreet Log Contracts — into a single protocol where every step is verifiable and every misbehavior is economically punishable.

The protocol does not innovate at the cryptographic layer. It innovates at the composition layer.

---

## 2. Actors

- **Agent.** An autonomous entity that wants to pay for an API call. Identified by a Nostr secp256k1 pubkey.
- **Operator.** An entity hosting one or more API endpoints. Identified by a Nostr secp256k1 pubkey.
- **Observer.** Any node that watches operator evidence chains. Permissionless, no bond required, rewarded from slashing pool when it detects malicious operator behavior first.
- **Oracle.** A Discreet Log Contract oracle attesting to dispute outcomes. Multiple oracles available; agent and operator pre-agree on n-of-m threshold per endpoint.

There is no validator class. There is no foundation. There is no governance committee.

---

## 3. Identity

Identity is a Nostr secp256k1 public key, encoded as 32-byte hex per [NIP-01].

Operators publish endpoint advertisements as Nostr addressable events (kind 31402, proposed for NIP) signed by their root key. Agents may delegate to ephemeral keys via [NIP-26] with a delegation conditions string scoping the delegate's authority and lifetime.

There is no DNS dependency, no foundation registry, no KYC layer. NIP-05 human-readable handles are optional convenience and never normative.

---

## 4. Capability Schema

Every endpoint advertises a capability descriptor:

```json
{
  "endpoint_id": "<sha256 hex of canonical descriptor>",
  "operator_pubkey": "<32-byte hex>",
  "method": "POST",
  "url": "https://operator.example/api/v1/translate",
  "input_schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", ... },
  "output_schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", ... },
  "price_msat": 5000,
  "quote_validity_s": 300,
  "evidence_endpoint": "https://operator.example/.well-known/aeps-evidence",
  "bond_pubkey": "<operator's bond root pubkey>",
  "dlc_oracles": ["<oracle_pubkey_1>", "<oracle_pubkey_2>", "<oracle_pubkey_3>"],
  "dlc_threshold": 2,
  "version": "0.1"
}
```

The descriptor is canonicalized per [RFC 8785] and signed by `operator_pubkey` (Ed25519 over the canonical bytes). The signature is the operator's commitment to that schema for that endpoint.

`endpoint_id` is the sha256 of the canonical descriptor bytes. It functions as a content address: any change to the schema produces a new `endpoint_id`. This prevents silent mutation.

`input_schema` and `output_schema` use [JSON Schema 2020-12]. They define what payloads are accepted and what response shapes are valid. Disputes over content correctness are decided by whether the operator's response validates against `output_schema`.

`dlc_oracles` and `dlc_threshold` specify which oracle keys must attest for disputes against this endpoint, with n-of-m threshold semantics.

---

## 5. Discovery

Operators publish capability descriptors as Nostr addressable events (kind 31402). Anyone subscribed to relays ingests them.

Two query modes:

- **Direct relay subscription.** Agent connects to relays, subscribes to kind 31402 with filters on tags (category, language, keywords). Agent ranks results by reputation (§9) and selects.
- **DVM query.** Agent publishes a NIP-90 job request (kind 5402, proposed) describing the intent in natural language. Any AEPS node that operates a DVM advertises capabilities (kind 31990) and responds with kind 6402 result events containing matched endpoints.

Discovery is permissionless. There is no central catalog. Reputation determines ranking, never membership.

---

## 6. Settlement

Payment is Lightning. Specifically:

### 6.1 Synchronous fulfillment (BOLT11 hold-invoice)

1. Agent calls operator endpoint.
2. Operator returns HTTP 402 with a [BOLT11] hold-invoice in the `WWW-Authenticate` header.
3. Agent locks payment along a Lightning route via HTLC. The HTLC commits to `payment_hash = sha256(preimage)` where the preimage is known only to the operator.
4. Operator delivers content. On success, operator settles the HTLC by revealing the preimage.
5. Agent receives content + preimage. The preimage is the proof of payment.

This is the classical L402 flow with a stricter 402 challenge schema.

### 6.2 Asynchronous fulfillment (BOLT12 offer)

For operators that batch or queue work, [BOLT12] offers replace BOLT11 invoices. The agent sends an `invoice_request` to the operator's blinded path; the operator returns a signed `invoice` when ready to fulfill; payment proceeds as in §6.1.

### 6.3 Atomic multi-hop (HTLC chains)

For agent workflows spanning N operators (e.g., search → translate → publish), AEPS specifies an HTLC-chain primitive:

1. Agent generates a single random preimage `r`. Computes `H = sha256(r)`.
2. Agent contracts with each of the N operators sequentially, locking an HTLC of amount `price_i` against `H` for each.
3. Each operator sees only their leg's HTLC. They cannot settle without `r`.
4. Once all N legs are locked, agent reveals `r` to the final operator only.
5. Each operator settles in reverse order by observing `r` as the final operator settles.
6. Either the entire chain settles atomically or any single timeout cascades all legs back to refund.

This primitive is not implementable on EVM/x402 without major centralization. It is a structural advantage of Lightning.

### 6.4 What is not supported

- **No Cashu, Fedimint, or other custodial mints.** They reintroduce trusted parties.
- **No Taproot Assets, RGB, or other tokenized rails.** They alter the unit of account from sat to issuer-defined token, which changes the security model in ways that are not transparent to the agent.
- **No on-chain settlement.** AEPS is Lightning-only.

The protocol is opinionated: Lightning is the rail, sat is the unit, period.

---

## 7. Bonds

### 7.1 Bond classes

**Operator bond.** Required to publish capability descriptors. Posted via Lightning hold-invoice to the operator's own miniscript bond contract on L1, force-closable on dispute. Bond size is operator-chosen but sets a lower bound on claim multiplier. Slashable for:

- Serving content that fails to validate against the published `output_schema`. Claim multiplier 5×.
- Force-closing the bond contract during an open dispute. Claim multiplier 1×.
- Anchoring conflicting daily Merkle roots (§8). Claim multiplier 5×.
- Failing to settle a hold-invoice within the published SLA. Claim multiplier 3×.

**Agent bond.** Optional, raises tier limits on rate-limited endpoints. Slashable for:

- Filing a dispute that the DLC oracle resolves against the agent. Claim multiplier 3×.
- Spamming the discovery layer (rate-limit violations). Claim multiplier 1×.

There is no validator bond. There is no witness federation bond. There are only operator and agent bonds.

### 7.2 Slashing distribution

When a slash executes:

- 80% to the claimant (the agent or operator on the winning side of the dispute).
- 15% to the observer who first published the triggering evidence (when applicable; otherwise rolled into claimant).
- 5% burned (deflationary, a credible commitment that the protocol does not enrich any custodian).

Slashing is automatic. The DLC oracle's attestation, once on Bitcoin L1, satisfies the bond contract's miniscript condition and the bond unlocks to the claimant.

---

## 8. Evidence

Every operator maintains an append-only evidence log.

### 8.1 Receipt format

For each fulfilled call, the operator produces an Ed25519-signed receipt:

```json
{
  "receipt_id": "<sha256 of canonical receipt>",
  "endpoint_id": "<from §4>",
  "operator_pubkey": "<32-byte hex>",
  "agent_pubkey": "<32-byte hex>",
  "request_hash": "<sha256 of canonical request body>",
  "response_hash": "<sha256 of canonical response body>",
  "request_time_ms": 1714759200000,
  "response_time_ms": 1714759200234,
  "payment_preimage_hash": "<sha256 of HTLC preimage>",
  "amount_msat": 5000,
  "schema_version": "0.1"
}
```

The receipt is signed by `operator_pubkey` per [RFC 8032]. The agent's copy of the receipt, after revealing the preimage on settlement, is the proof of payment + delivery.

### 8.2 Daily Merkle batch

Once per UTC day, the operator constructs a Merkle tree over all receipts issued in the prior 24-hour window. The root is `daily_root[D]`.

### 8.3 Bitcoin L1 anchor

The operator publishes `daily_root[D]` to Bitcoin L1 in an OP_RETURN output of a transaction signed by the operator's bond root key. This transaction is the **trust root** of the entire evidence chain.

The transaction format:

```
OP_RETURN <"AEPS1"> <operator_pubkey[8 bytes]> <D[4 bytes]> <daily_root[32 bytes]>
```

Total OP_RETURN payload = 45 bytes. Cost at typical fee rates: a few hundred sat per day per operator.

The transaction is also gossiped as a Nostr event (kind 31403, proposed) for fast discovery without requiring a Bitcoin node.

### 8.4 Verification

Anyone with a receipt and a Bitcoin full node can verify it:

1. Look up the operator's L1 anchor transaction for day D.
2. Read `daily_root[D]` from the OP_RETURN.
3. Compute the Merkle inclusion proof for the receipt.
4. Verify Ed25519 signature against `operator_pubkey`.

If the receipt is valid, all four checks pass. If any fails, the receipt is invalid.

### 8.5 Non-equivocation

The L1 chain is the transparency log. An operator who tries to anchor a different root for the same day produces two L1 transactions. Both are public.

A permissionless **observer** scanning operator anchors detects the conflict, publishes a fork-evidence Nostr event referencing both L1 transaction IDs, and triggers a 5× slashing dispute. The observer earns 15% of the slashing pool.

The mechanism does not require coordinated witnesses, federation, Sigstore-Rekor, or external infrastructure. It uses Bitcoin L1 alone as the global ordering oracle.

---

## 9. Reputation

Reputation is computed by each AEPS node from the public evidence stream. It is not authoritative; it is observable.

For each `(endpoint_id, agent_pubkey)` pair, a streaming Beta posterior tracks success rate:

- Successes = receipts where `output_schema` validation passed and no dispute resolved against operator.
- Failures = receipts where dispute resolved against operator.
- Posterior = `Beta(α + successes, β + failures)` with weak Laplace prior `α = β = 1`.

Reputation receipts are signed by the computing node and may be published as Nostr events (kind 31404, proposed) for portability. Agents may carry receipts across nodes; nodes may aggregate or weight foreign receipts as they choose. There is no normative reputation registry.

For privacy-preserving disclosure, BBS+ credentials [draft-irtf-cfrg-bbs] over reputation tuples allow an agent to prove "my reputation in category X exceeds threshold T" without revealing identity. This is optional and out of scope for v0.1 wire-format.

---

## 10. Disputes

### 10.1 Dispute types

- **Content correctness.** Agent claims `response_hash` does not match expected `output_schema`. Multiplier 5×.
- **SLA breach.** Agent or operator claims latency exceeded contracted bound. Multiplier 3×.
- **Fork detection.** Observer claims operator anchored conflicting Merkle roots. Multiplier 5×.
- **Non-payment.** Operator claims agent locked HTLC then never released preimage and force-closed. Multiplier 1×.
- **False dispute.** Operator counter-claim that agent's dispute is invalid. Multiplier 3×, slashes agent bond.

### 10.2 DLC oracle resolution

A dispute is resolved by a Discreet Log Contract [Dryja 2017]:

1. Disputant publishes a dispute event referencing the receipt(s), the dispute type, and the pre-agreed `dlc_oracles` list from the capability descriptor.
2. The disputant funds an on-chain DLC contract whose payout depends on the oracle's signature over the dispute outcome.
3. Each oracle in the threshold set independently fetches the disputed receipts, validates against schemas, and signs an attestation.
4. Once `dlc_threshold` oracles have signed, the bond's miniscript condition resolves on-chain. The slashing distribution (§7.2) executes automatically.

Oracles are Bitcoin-native, pseudonymous, and bonded by their reputation. Suredbits-style oracle protocols are sufficient. Multiple oracles in a threshold set defeat single-oracle bribery.

### 10.3 No dispute window timeout

Disputes are valid for the lifetime of the bond. The L1 anchor transaction is permanent; the receipts are signed; the operator cannot escape liability by waiting out a window.

---

## 11. Threat Model

We assume:

- Up to 30% of operators are byzantine. They will serve wrong content, fork their evidence log, or refuse to settle HTLCs.
- Up to 30% of observers are colluding with byzantine operators. They will not publish detected forks.
- Up to (m-1)/2 of any DLC oracle quorum is corrupt, where m is the threshold.
- The Bitcoin L1 chain is honest under the standard 51% honest miner assumption.
- Lightning network routing succeeds with non-trivial probability for typical hops; payment failures are bounded.
- All transport (clearnet, Tor, blinded paths) is observable to a nation-state adversary unless explicitly tunneled.

Under these assumptions:

- A byzantine operator who serves wrong content is detected by the agent (`output_schema` validation), disputed via DLC oracle, slashed 5×.
- A byzantine operator who forks evidence is detected by any of the >70% honest observers. Observation is profitable (15% reward). Game-theoretically, there is at least one observer who will publish the fork.
- A byzantine operator who attempts to collude with all observers fails because observation is permissionless and the L1 fork-evidence is on-chain.
- A byzantine DLC oracle quorum below threshold cannot attest. Misbehaving oracles lose future selection in capability descriptors, which is their revenue source.
- An adversarial Lightning routing failure does not slash; it simply fails the call. Bonds are only slashed against on-chain attested misbehavior, not network failure.

The protocol does not protect against:

- **Privacy of the request graph.** A relay that subscribes to all kind 31402 events sees agent-pubkey/operator-pubkey/timing metadata. Mitigation is operator-side: hidden services, ephemeral pubkeys per call. Out of scope for v0.1.
- **Quantum break of Ed25519 / secp256k1.** Post-quantum substitutes deferred to v2.
- **Censorship at the Lightning routing layer.** A peer that refuses to forward HTLCs can break a route. Mitigation is route diversity + HTLC chain redundancy.
- **Sybil attacks on the catalog.** Anyone can publish kind 31402 events. Mitigation is operator bond requirement: a Sybil swarm must lock real sat per pubkey, raising cost.

---

## 12. Versioning and Adoption

### 12.1 Versioning

The protocol is versioned by the `version` field in the capability descriptor. Incompatible changes increment the major version. Backward-compatible additions increment the minor version.

This document is v0.1.

### 12.2 Adoption path

AEPS does not have a foundation, governance committee, or chairs. Adoption follows the Bitcoin pattern:

1. Two reference implementations published, MIT licensed (`aeps-node-ts`, `aeps-node-rs`). Both are required for v0.1 ratification.
2. Anyone can run a node. Anyone can fork the implementation or the protocol.
3. The market chooses which fork. No vote, no committee.
4. Once stable across multiple operators in production, individual wire formats are submitted as BLIPs (for Lightning extensions) and NIPs (for Nostr kinds) for ratification by their respective ecosystems.
5. After 5 years of demonstrated stability, the original author of this draft steps back. The protocol survives by virtue of the code, the spec, and the running nodes — not by virtue of any individual.

### 12.3 No rent extraction

There is no AEPS Foundation. There is no mandatory fee to a maintainer. There is no premine. There is no governance token. There is no compliance tier paywall. The protocol is free.

Any node operator may charge for services rendered (running a beefier oracle, hosting a Compliance Console, providing premium SLA) — but these are downstream products, not protocol primitives.

---

## 13. References

- Nakamoto, S. *Bitcoin: A Peer-to-Peer Electronic Cash System.* 2008.
- Dryja, T. *Discreet Log Contracts.* 2017.
- BOLT specs: https://github.com/lightning/bolts
- Nostr Implementation Possibilities (NIPs): https://github.com/nostr-protocol/nips
- L402 Specification (Lightning Labs): https://github.com/lightninglabs/L402
- OpenAPI Specification 3.1: https://spec.openapis.org/oas/v3.1.0
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- RFC 8032: Edwards-Curve Digital Signature Algorithm (EdDSA)
- RFC 8785: JSON Canonicalization Scheme
- draft-irtf-cfrg-bbs-signatures
- BIP-353: DNS Payment Instructions

---

*This draft is licensed under MIT. The reference implementations are MIT. The wire formats are public. There is nothing here to capture.*
