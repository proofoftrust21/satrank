# SatRank

**The Lightning trust oracle for the agentic economy.**

[![npm](https://img.shields.io/npm/v/@satrank/sdk.svg?label=%40satrank%2Fsdk)](https://www.npmjs.com/package/@satrank/sdk)
[![PyPI](https://img.shields.io/pypi/v/satrank.svg)](https://pypi.org/project/satrank/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![API docs](https://img.shields.io/badge/API-OpenAPI%203.1-blueviolet.svg)](https://satrank.dev/api/docs)

## What it is

SatRank is a sovereign trust oracle for the Lightning Network. Autonomous agents pay Lightning-native HTTP services every day, and most of the graph they have to navigate is noise: a large share of public Lightning nodes never route a payment, and L402 endpoints ship without SLAs, without catalogs, without reputation. SatRank measures the part of the graph that actually settles and publishes a Bayesian posterior per node.

The product has two steps. `POST /api/intent` takes a natural-language intent and returns the top-ranked L402 candidates for that intent. `POST /api/fulfill` settles the chosen candidate through the L402 paywall and returns the proof. Agents resolve the intent first, settle second, and only settle against a target they believe in.

Every score is a posterior, not a composite number. For each node the API returns `p_success`, `ci95_low`, `ci95_high`, `n_obs`, and `time_constant_days`. Uncertainty is first-class. Every QueryRoutes probe, every preimage-verified report, and every fulfilled intent updates the same α, β cycle.

SatRank runs the full stack: a Bitcoin full node (no Neutrino, no third-party gossip), its own LND, its own Nostr identity, its own probe fleet, its own relay-publishing pipeline.

## Quick start

Install the SDK, hand it a wallet, describe the need.

```typescript
import { SatRank } from '@satrank/sdk';

const sr = new SatRank({ wallet: myLnWallet });

const result = await sr.fulfill({
  category: 'energy/intelligence',
  budget_sats: 50,
});

console.log(result.response);     // the paid API response
console.log(result.endpoint_url); // which endpoint served it
console.log(result.paid_sats);    // what it cost
```

```python
from satrank import SatRank

sr = SatRank(wallet=my_ln_wallet)

result = sr.fulfill(
    category="energy/intelligence",
    budget_sats=50,
)

print(result.response)      # the paid API response
print(result.endpoint_url)  # which endpoint served it
print(result.paid_sats)     # what it cost
```

The SDK resolves the intent against the live registry, picks the top-ranked endpoint inside the budget, handles the L402 handshake, pays the invoice with the wallet, and returns the service response. Fallbacks on failure.

Prefer raw HTTP? See the [OpenAPI 3.1 spec](https://satrank.dev/api/openapi.json) or the interactive [Swagger UI](https://satrank.dev/api/docs).

## Installation

```bash
# TypeScript / Node
npm install @satrank/sdk

# Python
pip install satrank
```

Requirements: Node `>=18.0.0`, Python `>=3.10`. Both SDKs are thin wrappers over the public REST API and work with any Lightning wallet that can pay a BOLT11 invoice.

## Core concepts

**Intent then fulfill.** Agents post a natural-language intent and receive a ranked shortlist of L402 endpoints. They choose one and settle through the L402 paywall. The two-step shape separates discovery from payment: an agent can re-rank, cache, or batch candidates before committing sats.

**Posterior, not a magic number.** Every score is a Beta-distributed posterior. `p_success = 0.87` with `ci95 = [0.81, 0.92]` is a different signal than `p_success = 0.87` with `ci95 = [0.40, 0.99]`. The API returns both, along with `n_obs` (observation count) and `time_constant_days` (decay). Composite 0 to 100 numbers are deprecated and no longer exposed.

**Deterministic, auditable scoring.** The scoring function is code, not a judgment call. It is published under AGPL-3.0 and the Bayesian derivation is documented in the [methodology](https://satrank.dev/methodology). No featured listing, no paid placement, no boost.

**Preimage closes the loop.** The same 32-byte preimage that unlocks an L402 response is the proof that the payment settled. SatRank accepts it as a first-class report input, weighted higher than self-reported outcomes. No account, no tracking, no login.

## Pricing

SatRank has a free tier and five paid deposit tiers. The base rate is 1 sat per paid request with no setup. Agents that pre-buy a quota deposit into one of the tiers below, and the per-request rate is locked into the L402 macaroon at deposit time.

| Deposit (sats) | Rate (sat/req) | Requests per deposit | Effective discount |
|---|---|---|---|
| 21 | 1.0 | 21 | 0 % |
| 1,000 | 0.5 | 2,000 | 50 % |
| 10,000 | 0.2 | 50,000 | 80 % |
| 100,000 | 0.1 | 1,000,000 | 90 % |
| 1,000,000 | 0.05 | 20,000,000 | 95 % |

The rate is engraved on the macaroon at settlement. A future tier change cannot retroactively raise the rate on a paid-up token. This is the mechanical half of mechanical neutrality: the business model cannot bias the ranking because the ranking is not what is sold, and it cannot reward individual callers because the tier is a function of the deposited amount, not of the caller.

Live tier schedule: `GET /api/deposit/tiers`. Flow: `POST /api/deposit` with `{ amount }` returns a BOLT11 invoice plus `tierId`, `rateSatsPerRequest`, and `quotaGranted`. Pay the invoice, then `POST /api/deposit` with `{ paymentHash, preimage }` to claim the macaroon.

## API surface

All endpoints are versionless and live under `https://satrank.dev`. Full reference: [OpenAPI 3.1](https://satrank.dev/api/openapi.json) / [Swagger UI](https://satrank.dev/api/docs).

| Method | Endpoint | Purpose | Cost |
|---|---|---|---|
| GET | `/api/intent/categories` | Enumerate the category taxonomy used by intent resolution | free |
| POST | `/api/intent` | Resolve a natural-language intent, return ranked L402 candidates with posterior | free, 10 req / 60 s / IP |
| POST | `/api/fulfill` | Settle the chosen candidate through L402, return the response and proof | paid, 1 req from balance |
| GET | `/api/agents/top` | Leaderboard: rank, alias, pubkey hash, posterior | free |
| GET | `/api/services` | Browse the L402 service registry by keyword, category, uptime | free |
| GET | `/api/agent/:hash` | Full node profile: posterior, components, reports, survival | 1 req |
| POST | `/api/report` | Submit a paid-call outcome; preimage-verified reports carry extra weight | free |
| POST | `/api/deposit` | Buy a rate-locked L402 quota in one of five public tiers | free (invoice phase) |
| GET | `/api/deposit/tiers` | Public deposit tier schedule | free |
| GET | `/api/stats` | Network counters: nodes, channels, probes, services | free |
| GET | `/api/health` | Liveness: database, LND, bitcoind, Nostr relay status | free |

Payment is gated by L402. A free-tier caller gets 21 requests on the first auto-issued macaroon (1 sat per request). A deposit caller gets the requests their tier grants, at the rate their tier locked in.

## Nostr distribution

SatRank publishes its entire trust graph to public Nostr relays. Any Nostr client can subscribe and verify the signatures without talking to satrank.dev at all.

- **npub**: `npub1t5gagm0phfxn99drxevd7yhwhdfcf4kkv70stdjlas7gvuraul2q27lpl4`
- **NIP-05**: `satrank@satrank.dev`
- **Relays**: `relay.damus.io`, `nos.lol`, `relay.primal.net`

Event kinds:

| Kind | Contents |
|---|---|
| 10040 | NIP-85 self-declaration |
| 20900 | Verdict flash: ephemeral broadcast on each verdict transition |
| 30382 | Node endorsement: posterior, verdict, component signals per node |
| 30383 | Service endpoint: URL, price, category, operator pubkey |
| 30384 | Operator profile: NIP-05, verified identity, badge |
| 30385 | Report: outcome, preimage-verified flag, reporter tier |
| 5900 / 6900 | NIP-90 DVM: on-demand score as a Nostr job |

If satrank.dev goes offline, the last 30 days of published scores remain verifiable on the relays above via events signed by the SatRank npub. Full protocol detail: [methodology § Nostr distribution](https://satrank.dev/methodology#nostr-distribution).

## Run your own SatRank

The code is [AGPL-3.0](./LICENSE). Fork it, run your own bitcoind, run your own LND, publish under your own Nostr identity. The deployment guide, including infra layout, Postgres schema, and service boundaries, lives in [DEPLOY.md](./DEPLOY.md).

Local development:

```bash
npm install
npm run build
npm start
```

Full command list is in [CLAUDE.md](./CLAUDE.md) (dev scripts, crawler, MCP server, calibration report, Nostr publisher).

## Repo structure

```
src/                TypeScript service (Express, Postgres, scoring engine)
  routes/           endpoint definitions
  controllers/      input validation, response shaping
  services/         scoring, intent resolution, fulfill orchestration
  repositories/     Postgres data access
  crawler/          LN graph + probe fleet
  nostr/            NIP-85 publisher, DVM, verdict flash
  mcp/              Model Context Protocol server
public/             landing page, methodology, static assets
docs/               phase reports, design documents, migration notes
sdk/                TypeScript SDK (@satrank/sdk on npm)
python-sdk/         Python SDK (satrank on PyPI)
scripts/            backup, rollback, calibration, purge utilities
infra/              deployment scaffolding, nginx, compose
```

## Contributing, license, contact

Security: see [SECURITY.md](./SECURITY.md) for the responsible disclosure policy. Do not open a public issue for security-sensitive reports; email `security@satrank.dev` instead.

License: [AGPL-3.0](./LICENSE). Forking is encouraged. If you run a modified SatRank as a public service, the AGPL requires publishing your modifications.

Why it exists: [IMPACT-STATEMENT.md](./IMPACT-STATEMENT.md) covers the problem, the solution, the differentiation, and the strategic bet.

Methodology in depth: [satrank.dev/methodology](https://satrank.dev/methodology).

- **Project**: [satrank.dev](https://satrank.dev)
- **Contact**: `contact@satrank.dev`
- **Nostr**: `satrank@satrank.dev`
- **Code**: [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank)
