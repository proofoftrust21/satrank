# SatRank documentation

This directory contains active documentation for SatRank operators and integrators.

## Federation

- **[OPERATOR_QUICKSTART.md](OPERATOR_QUICKSTART.md)** — bootstrap guide for any operator wanting to run a SatRank-compatible oracle. Hardware tiers, Postgres + LND macaroons, Nostr identity, environment variables, federation timeline (Day 0 → Day 30+), economic break-even analysis. **Read this if you want to join the federation.**

## Operations

- [env.example.md](env.example.md): environment variables reference for self-hosted deployments.

## SDK

- [MIGRATION-TO-1.0.md](MIGRATION-TO-1.0.md): high-level migration guide for upgrading to SatRank SDK 1.0.
- [sdk/quickstart-ts.md](sdk/quickstart-ts.md): TypeScript SDK quickstart.
- [sdk/quickstart-python.md](sdk/quickstart-python.md): Python SDK quickstart.
- [sdk/aeps-disputes.md](sdk/aeps-disputes.md): **AEPS §10 dispute walkthrough** — open + attest + resolve in 5 minutes (TS + Python).
- [sdk/nlp-helper.md](sdk/nlp-helper.md): natural language intent parsing helper.
- [sdk/wallet-drivers.md](sdk/wallet-drivers.md): supported wallet driver integrations.
- [sdk/migration-0.2-to-1.0.md](sdk/migration-0.2-to-1.0.md): detailed SDK migration path from 0.2.x to 1.0.

TypeScript SDK 1.6.0 (AEPS dispute surface + canonical-byte helpers) is on [npm](https://www.npmjs.com/package/@satrank/sdk). Python SDK 1.6.0 (parity) is on [PyPI](https://pypi.org/project/satrank/).

## AEPS — Agent Evidence and Payment Standard

The protocol behind SatRank, codified as a single MIT-licensed
whitepaper. v0.1 is the ratification candidate (2026-05-08).

- **[AEPS.md](AEPS.md)** — landing page : every AEPS-related resource
  in the repo, indexed.
- **[../spec/AEPS-whitepaper.md](../spec/AEPS-whitepaper.md)** — the
  protocol (~9 pages).
- **[../spec/PROCESS.md](../spec/PROCESS.md)** — evolution process
  (forks, not votes).
- **[../spec/test-vectors/](../spec/test-vectors/)** — 16 cross-impl
  conformance fixtures.
- **[../apps/aeps-node-rs](../apps/aeps-node-rs)** — Rust reference
  implementation.

## Archive

Historical phase reports, audits, and superseded snapshots live in [archive/](archive/). They are preserved for context but are not the current reference.

## Root references

Canonical deploy and security documents live at the repository root: [DEPLOY.md](../DEPLOY.md), [SECURITY.md](../SECURITY.md), [INTEGRATION.md](../INTEGRATION.md), [CHANGELOG.md](../CHANGELOG.md).
