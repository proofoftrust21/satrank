# aeps-node-rs

Rust reference implementation of [AEPS](../../spec/AEPS-whitepaper.md) — the Agent Evidence and Payment Standard.

License: MIT.

## Status

v0.1 ratification candidate. Tracks the TypeScript reference for spec
conformance ; both impls now pass all 16 cross-impl vectors in
`../../spec/test-vectors/`.

## Scope (v0.1)

- §1 Identity : `NostrPubkey` 32-byte hex parse + display.
- §4 Capability : `CapabilityDescriptor` struct + sorted-keys
  `canonical_json` + `compute_endpoint_id` (sha256 of canonical bytes).
- §8 Evidence : Ed25519 sign / verify (`ed25519-dalek`),
  `build_op_return_payload` (49-byte `AEPS1` payload) +
  `utc_day_index` (Howard Hinnant civil-from-days, matches TS impl).
- §10 Disputes : `AttestationOutcome` enum, `build_outcome_message` +
  `build_outcome_message_hash` — the canonical bytes BIP-340 signs.
- RFC 6962 Merkle : `leaf_hash` (0x00 prefix) / `node_hash` (0x01),
  `merkle_root`, `inclusion_proof`, `verify_inclusion_proof`.

Out of scope for v0.1 (deferred to v0.2) :

- LDK integration for hold-invoice + BOLT12.
- HTLC chain coordination across operators.
- HTTP server (TS impl serves the routes ; Rust ships the verifier
  primitives so CLI tooling can be built on top).

## What this crate is for

Two purposes:

1. **Conformance witness.** The Rust impl reads the same spec, computes the same Merkle roots, verifies the same signatures. If TS and Rust impls disagree on any test vector, the spec or one of the impls has a bug. This is the credibility layer.
2. **CLI verifier.** Auditors and observers can run `aeps verify <receipt>` against a published L1 anchor without trusting the issuing operator's HTTP API. The trust root is Bitcoin L1; `aeps-node-rs` makes that practical from the command line.

## Build

```sh
cargo build
cargo test
```

## Conformance test vectors

Live in [`../../spec/test-vectors/`](../../spec/test-vectors/). Both
implementations read the SAME fixtures and produce byte-identical output.

```sh
cargo test --test conformance
```

Currently 4 conformance suites against 16 vectors :

| Test | Section | Vectors |
|---|---|---|
| `merkle_conformance` | RFC 6962 Merkle root | 6 |
| `op_return_conformance` | §8.3 OP_RETURN payload | 4 |
| `dispute_outcome_conformance` | §10 outcome message | 4 |
| `capability_descriptor_conformance` | §4 capability descriptor | 2 |

Plus 32 unit tests in the lib itself.

Any divergence between Rust output and the fixture's `expected_*` field
indicates a bug — either the spec is ambiguous (file a whitepaper PR)
or one of the implementations diverged from the spec.
