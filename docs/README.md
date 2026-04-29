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
- [sdk/nlp-helper.md](sdk/nlp-helper.md): natural language intent parsing helper.
- [sdk/wallet-drivers.md](sdk/wallet-drivers.md): supported wallet driver integrations.
- [sdk/migration-0.2-to-1.0.md](sdk/migration-0.2-to-1.0.md): detailed SDK migration path from 0.2.x to 1.0.

TypeScript SDK 1.1.0 (federation-aware: `aggregateOracles`, `stage_posteriors`, `http_method`) is on [npm](https://www.npmjs.com/package/@satrank/sdk). Python SDK 1.0.5 is on [PyPI](https://pypi.org/project/satrank/).

## Archive

Historical phase reports, audits, and superseded snapshots live in [archive/](archive/). They are preserved for context but are not the current reference.

## Root references

Canonical deploy and security documents live at the repository root: [DEPLOY.md](../DEPLOY.md), [SECURITY.md](../SECURITY.md), [INTEGRATION.md](../INTEGRATION.md), [CHANGELOG.md](../CHANGELOG.md).
