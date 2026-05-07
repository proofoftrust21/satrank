# AEPS Spec

**AEPS — Agent Evidence and Payment Standard.** A protocol for autonomous AI agents to discover, pay, and obtain cryptographic proof of fulfillment from Internet APIs without intermediaries. Lightning-pure, Bitcoin-anchored, no foundation.

- **Whitepaper:** [AEPS-whitepaper.md](./AEPS-whitepaper.md) — the protocol.
- **Process:** [PROCESS.md](./PROCESS.md) — how AEPS evolves (forks, not votes).
- **License:** [LICENSE](./LICENSE) — MIT.
- **Test vectors:** [test-vectors/](./test-vectors/) — cross-impl conformance fixtures.

## Reference implementations

Two independent implementations, both verified against the same conformance fixtures :

- **`aeps-node-ts`** — TypeScript. Lives at the repository root (`/src` for the server, `/sdk` for the agent SDK). The HTTP surface, federation Nostr publishers/consumers, MCP bridge, and §10 DLC-style dispute resolution all live here.
- **`aeps-node-rs`** — Rust. Lives at [`/apps/aeps-node-rs`](../apps/aeps-node-rs). Conformance witness + CLI verifier (in progress). Reads the same `spec/test-vectors/*.json` fixtures and produces byte-identical canonical bytes.

Both required for v0.1 ratification per [PROCESS.md](./PROCESS.md).

## Conformance vectors

Located in [`test-vectors/`](./test-vectors/). Currently 16 fixtures across 5 byte-format-normative sections of the spec :

| Fixture | Section | Vectors |
|---|---|---|
| `merkle.json` | RFC 6962 Merkle root | 6 |
| `op_return.json` | §8.3 OP_RETURN payload | 4 |
| `dispute_outcome.json` | §10 outcome message | 4 |
| `capability_descriptor.json` | §4 capability descriptor | 2 |

Both implementations run against the SAME fixture and MUST produce the
SAME bytes. Any divergence ⇒ bug in one impl (or ambiguous spec —
the latter triggers a whitepaper clarification PR).

To run :

```sh
# TypeScript
npx vitest run src/tests/aepsConformance.test.ts

# Rust
cd apps/aeps-node-rs && cargo test --test conformance
```

## SDK helpers (canonical bytes, no crypto)

Both SDKs (`@satrank/sdk` 1.6.0+ TypeScript, `satrank` 1.6.0+ Python)
ship pure helpers so consumers don't re-derive the formats :

- `buildOutcomeMessage` / `buildOutcomeMessageHash` — §10 outcome
  bytes BIP-340 oracles sign.
- `buildNip98EventTemplate` / `encodeNip98AuthHeader` — kind 27235
  template + Authorization header encoding.

Helpers are zero-runtime-dep ; the agent's BIP-340 Schnorr signer
(`@noble/curves`, `nostr-tools`, `coincurve`, etc.) plugs in for the
actual signing step.

## Status

v0.1 ratification candidate (2026-05-08). Both reference implementations
ship and pass all 16 conformance fixtures. Awaiting :

- The whitepaper-mandated 5-year founder-exit clause clock to start ;
- BLIP/NIP submissions for kinds 31402 / 31403 / 31410 (proposed) ;
- Any third party publishing an independent third reference impl
  (not required for v0.1, but lowers the single-vendor risk).

The protocol shipped first ; the spec describes what shipped.
