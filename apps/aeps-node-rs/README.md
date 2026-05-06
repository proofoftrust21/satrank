# aeps-node-rs

Rust reference implementation of [AEPS](../../spec/AEPS-whitepaper.md) — the Agent Evidence and Payment Standard.

License: MIT.

## Status

Scaffolding. Tracks the TypeScript reference (`src/` in the parent repo) for spec conformance. Required for AEPS v0.1 ratification per the whitepaper §12.2.

## Scope (v0.1)

- AEPS-§4 capability descriptor types (parse + canonical serialization).
- AEPS-§7 bonds: type definitions and lifecycle state machine (no Lightning yet).
- AEPS-§8 evidence: Ed25519 signing, RFC 6962 Merkle batch, OpenTimestamps anchor format.
- AEPS-§10 disputes: structures + DLC-attestation parsing.

Out of scope for v0.1 of this Rust impl (deferred to v0.2):

- Full LDK integration for hold-invoice + BOLT12.
- HTLC chain coordination across operators.
- HTTP server (the TS impl serves both APIs in v0.1; the Rust impl provides a CLI verifier).

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

When both TS and Rust impls run the same vectors and produce the same outputs, they are conformant. Vectors live in `../../spec/test-vectors/` (to be added).
