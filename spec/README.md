# AEPS Spec

**AEPS — Agent Evidence and Payment Standard.** A protocol for autonomous AI agents to discover, pay, and obtain cryptographic proof of fulfillment from Internet APIs without intermediaries. Lightning-pure, Bitcoin-anchored, no foundation.

- **Whitepaper:** [AEPS-whitepaper.md](./AEPS-whitepaper.md) — the protocol.
- **Process:** [PROCESS.md](./PROCESS.md) — how AEPS evolves (forks, not votes).
- **License:** [LICENSE](./LICENSE) — MIT.

## Reference implementations

- `aeps-node-ts` — TypeScript reference impl. Lives under `/Users/lochju/satrank/src` for now; will migrate into `packages/` as the codebase refactors.
- `aeps-node-rs` — Rust reference impl. To be scaffolded.

Both required for v0.1 ratification.

## Status

v0.1 draft. Not yet ratified. The protocol is shipped first; the spec describes what shipped. When two reference impls run AEPS-conformance tests cleanly against each other, v0.1 ratifies.
