# SatRank

**The Lightning trust oracle for the agentic economy.**

[![npm](https://img.shields.io/npm/v/@satrank/sdk.svg?label=%40satrank%2Fsdk)](https://www.npmjs.com/package/@satrank/sdk)
[![PyPI](https://img.shields.io/pypi/v/satrank.svg)](https://pypi.org/project/satrank/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![API docs](https://img.shields.io/badge/API-OpenAPI%203.1-blueviolet.svg)](https://satrank.dev/api/docs)

## What it is

SatRank is a sovereign, federated trust oracle for the Lightning Network. Autonomous agents pay Lightning-native HTTP services every day, and most of the graph they have to navigate is noise: a large share of public Lightning nodes never route a payment, and L402 endpoints ship without SLAs.

SatRank decomposes the L402 contract into **five conditional stages** — challenge → invoice validity → payment fulfillment → data delivery → data quality — and maintains an independent Bayesian posterior per stage per endpoint. The end-to-end probability is the chain-rule product over stages with sufficient observations. Agents see both the per-stage breakdown (which step is likely to fail) and the composite (will the request succeed end-to-end).

On top of the posteriors, SatRank publishes a **weekly signed calibration history** on Nostr (kind 30783) — the rolling delta between predicted and observed success rates. Any agent or peer oracle can verify the oracle's accuracy across time. A competitor that announces a similar oracle in 2027 cannot retroactively produce that history. The provenance is the moat.

The federation primitives ship with the oracle. Any operator can run a SatRank-compatible instance, publish a kind 30784 announcement, and have agents aggregate the network through weighted Bayesian model averaging. SatRank itself is one of N+1 instances; agents pick their own trust filters via `aggregateOracles()` in the SDK.

Three agent-native protocols in parallel:
- **HTTP REST** — the canonical API at `https://satrank.dev/api/*`
- **MCP server** — `intent` + `verify_assertion` tools for Claude Code, ChatGPT, Cursor, Alby Agent Toolkit
- **Nostr DVM** (NIP-90 kind 5900/6900) — sovereign agents who never touch HTTP

The product exposes `POST /api/intent`: it takes a natural-language intent and returns the top-ranked L402 candidates, each with its full Bayesian posterior + 5-stage decomposition + http_method. Settlement happens client-side. The SDK helper `sr.fulfill(intent, budget)` calls `/api/intent`, selects a candidate, and performs the L402 payment flow directly against the provider's endpoint. SatRank never custodies sats and never sees the preimage.

SatRank runs the full stack: a Bitcoin full node (no Neutrino, no third-party gossip), its own LND, its own Nostr identity, its own probe fleet, its own relay-publishing pipeline. The economic supportability is publicly verifiable at `GET /api/oracle/budget` (revenue / spending / coverage_ratio).

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

**Intent then fulfill.** Agents post a natural-language intent and receive a ranked shortlist of L402 endpoints with `http_method` + 5-stage `stage_posteriors` + composite `p_e2e`. They choose one and settle through the L402 paywall. The two-step shape separates discovery from payment: an agent can re-rank, cache, or batch candidates before committing sats.

**Posterior, not a magic number.** Every score is a Beta-distributed posterior. `p_success = 0.87` with `ci95 = [0.81, 0.92]` is a different signal than `p_success = 0.87` with `ci95 = [0.40, 0.99]`. The API returns both, along with `n_obs`, `is_meaningful`, and the per-stage breakdown.

**End-to-end calibrated.** The 5-stage L402 contract is measured per endpoint: challenge (free probe), invoice (free decode), payment (paid via SatRank's LND), delivery (HTTP recall), quality (heuristic / schema). Composed `p_e2e = ∏ p_i` over meaningful stages.

**Honestly calibrated history.** A weekly cron publishes the delta between predicted and observed success rates as a kind 30783 Nostr event signed by the oracle. Anyone can audit the oracle's accuracy across time without trusting a self-claim. The provenance moat compounds week after week.

**Federated, not centralized.** SatRank is one SatRank-compatible oracle among N+1. Other operators can run their own (see [`docs/OPERATOR_QUICKSTART.md`](./docs/OPERATOR_QUICKSTART.md)) and the federation grows. Agents discover peers via kind 30784 announcements + `GET /api/oracle/peers` + SDK `aggregateOracles()`.

**Web of trust via crowd outcomes.** Any agent who has paid for an L402 endpoint can publish a kind 7402 outcome event. SatRank ingests them with Sybil-resistant weighting (NIP-13 PoW + Nostr identity age + preimage proof) and consolidates them into the per-stage posteriors after a 1h anti-spam delay. The trust signal grows with the agent network.

**Deterministic, auditable scoring.** The scoring function is code, not a judgment call. AGPL-3.0, derivation in the [methodology](https://satrank.dev/methodology). No featured listing, no paid placement.

**Preimage closes the loop.** The same 32-byte preimage that unlocks an L402 response is the proof that the payment settled. SatRank accepts it as a first-class report input, weighted higher than self-reported outcomes. No account, no tracking, no login.

## Data sources

The SatRank catalog of L402 endpoints is sourced from publicly available registries in the L402 ecosystem.

- **[402index.io](https://402index.io)** — primary source (~95% of the current catalog). Maintained by Ryan Gentry, the largest protocol-agnostic directory of paid APIs for AI agents. SatRank consumes their public API and adds Bayesian probabilistic scoring on top.
- **[l402.directory](https://l402.directory)** — curated supplementary source with `.well-known/l402-directory-verify.txt` claim verification. Smaller catalog (~20 paid endpoints today) but contributes signals 402index does not surface: `consumption.type` (browser / api_response / stream / download), `provider.contact`, and per-service `.well-known` attestation. Cross-listed entries accumulate both attributions in `service_endpoints.sources[]`.

Operator self-submissions are accepted via `POST /api/services/register` with NIP-98 authentication and a one-time L402 listing fee. Submitted endpoints are labeled `source=self_registered` in the database and are validated by the same registry crawler before they enter the ranking pool. Self-submissions can only fill empty metadata fields; trusted-source data (name, category, description) is never overwritten.

Roadmap: announcing `/api/services/register` publicly so operators can register without going through any third-party registry.

SatRank is fully open source under AGPL-3.0. The scoring methodology is deterministic and auditable: anyone can fork the engine and reproduce the rankings independently.

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
| POST | `/api/intent` | Resolve a natural-language intent, return ranked L402 candidates with posterior + 5-stage stage_posteriors + http_method | free, 10 req / 60 s / IP |
| POST | `/api/intent?fresh=true` | Same shape but server runs a synchronous probe on top candidates (last_probe_age_sec < 60 s) | 2 sats |
| GET | `/api/agents/top` | Leaderboard: rank, alias, pubkey hash, posterior | free |
| GET | `/api/services` | Browse the L402 service registry by keyword, category, uptime | free |
| GET | `/api/agent/:hash` | Agent score, advisory, metadata. Free directory read | free |
| GET | `/api/profile/:id` | Full agent profile: 5-component LN-graph decomposition, reports, survival, evidence | 1 sat |
| POST | `/api/verdicts` | Batch verdict for up to 100 hashes | 1 sat |
| POST | `/api/probe` | End-to-end L402 probe via SatRank's LND with full telemetry | 5 sats |
| POST | `/api/report` | Submit a paid-call outcome; preimage-verified reports carry 2× weight | free |
| POST | `/api/deposit` | Buy a rate-locked L402 quota in one of five public tiers | free (invoice phase) |
| GET | `/api/deposit/tiers` | Public deposit tier schedule | free |
| GET | `/api/stats` | Network counters: nodes, channels, probes, services | free |
| GET | `/api/health` | Liveness: database, LND, bitcoind, Nostr relay status | free |
| GET | `/api/oracle/budget` | **NEW** Self-funding loop snapshot (lifetime + 30d + 7d revenue / spending / coverage_ratio) | free |
| GET | `/api/oracle/peers` | **NEW** SatRank-compatible oracles discovered via kind 30784 announcements | free |
| GET | `/api/oracle/peers/:pubkey/calibrations` | **NEW** Calibration history (kind 30783) of a specific peer — cross-oracle meta-confidence | free |
| GET | `/api/oracle/assertion/:url_hash` | **NEW** Trust assertion metadata (kind 30782) + BOLT12 TLV embedding hint for an endpoint | free |

Payment is gated by L402. A free-tier caller gets 21 requests on the first auto-issued macaroon (1 sat per request). A deposit caller gets the requests their tier grants, at the rate their tier locked in.

Fulfillment itself is not an endpoint on satrank.dev. The SDK helper `sr.fulfill()` performs the L402 handshake directly against the selected candidate's `endpoint_url`. See [INTEGRATION.md](./INTEGRATION.md) Path 1 for the flow.

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
| 30383 | Service endpoint endorsement: URL, price, category, operator pubkey |
| 30384 | Service profile: NIP-05, verified identity, badge |
| **30782** | **Trust assertion** (NIP-33 addressable, weekly): per-endpoint 5-stage posterior + p_e2e + valid_until + calibration_proof. Transferable / offline-verifiable |
| **30783** | **Calibration history** (NIP-33 addressable, weekly): delta_mean / delta_p95 between predicted and observed. The provenance moat |
| **30784** | **Oracle announcement** (NIP-33 addressable, daily): oracle_pubkey, lnd_pubkey, catalogue_size, capabilities. Federation discovery |
| **7402** | **Crowd outcome reports** (regular): published by independent agents, Sybil-weighted ingestion (PoW + identity age + preimage proof) |
| 5900 / 6900 | NIP-90 DVM: `j: trust-check` (legacy) and `j: intent-resolve` (sovereign agent flow) |

If satrank.dev goes offline, the last weeks of signed calibration history + trust assertions remain verifiable on the relays above via events signed by the SatRank npub — and other SatRank-compatible oracles in the federation continue serving the network. Full protocol detail: [methodology § Federation](https://satrank.dev/methodology#federation).

## Run your own SatRank-compatible oracle

The code is [AGPL-3.0](./LICENSE). Fork it, run your own bitcoind, run your own LND, publish under your own Nostr identity, and join the federation. The complete operator bootstrap is documented in [`docs/OPERATOR_QUICKSTART.md`](./docs/OPERATOR_QUICKSTART.md): hardware tiers (~€12/month minimum on Hetzner), Postgres + LND macaroon setup, Nostr identity generation, environment variables, federation timeline (Day 0 → Day 30+ when you appear in other oracles' aggregations), and economic break-even analysis.

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
