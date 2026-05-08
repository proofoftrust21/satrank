# satrank-l402 — Claude Code skill

[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Bitcoin-pure](https://img.shields.io/badge/Bitcoin-pure-orange)](https://github.com/proofoftrust21/satrank)

**Discover, score, and pay L402 endpoints on Bitcoin Lightning with
cryptographic audit trails.**

## What it does

Teaches an AI agent the trust+audit workflow for the Lightning agent economy :

1. **Discover** — `intent` returns ranked L402 endpoints with Bayesian
   `p_success` posterior and 5-stage trust breakdown.
2. **Verify** — `get_endpoint_score` returns the standalone trust signal for
   a specific URL.
3. **Pay** — `fulfill` routes the payment through SatRank's hold-invoice
   proxy ; refund on failure ; auto-issues an Ed25519-signed evidence receipt.
4. **Audit** — `fulfill_evidence` returns the canonical-JSON + signature ;
   `aeps.inclusion_proof` returns the Merkle audit path against the daily
   Bitcoin L1 anchor.
5. **Dispute** — open AEPS §10 disputes against fraudulent operators ;
   resolved disputes trigger 1×/2×/3×/5× slashing on operator bonds.

## When you want this skill

| Need | Use this skill ? |
|---|---|
| Free API call | ✗ just curl |
| Single paid call, no audit | ✗ use `lnget` |
| Paid call + compliance audit | ✓ |
| Multi-source agent flow with refund | ✓ |
| Slashable operator bond recourse | ✓ |
| EU AI Act Article 12 evidence | ✓ |
| x402 / USDC / EVM | ✗ not supported (Bitcoin-pure doctrine) |

## Install

See `INSTALL.md`. Recommended : `claude mcp add satrank -- npx -y satrank-mcp`.

## Files

- `SKILL.md` — instructions the agent reads at runtime
- `INSTALL.md` — three install paths (MCP / skill-only / lnget alone)
- `README.md` — this file

## Stack alignment

- L402 — Lightning Labs spec for HTTP 402 + macaroons + Lightning invoice
- AEPS — SatRank's spec for Agent Evidence and Payment standardisation,
  Bitcoin-anchored evidence trails (whitepaper in `docs/AEPS.md`)
- NIP-98 — Nostr HTTP authentication on the operator side
- BIP-340 Schnorr — dispute attestation signatures
- Ed25519 — evidence receipt signatures (faster verification path than
  Schnorr for the high-volume audit case)

## License

MIT
