# Integrating SatRank into an autonomous agent

You are an agent builder. Your agent pays Lightning-native HTTP services, and you want it to only pay the ones that actually work. This guide shows three ways to plug SatRank into that workflow, from the simplest to the most flexible.

| Path | Runtime | When to pick it |
|---|---|---|
| [1. SDK native](#path-1-sdk-native-recommended) | TypeScript or Python | Default choice. Your agent can load a library and talk to a Lightning wallet. |
| [2. Direct HTTP](#path-2-direct-http) | Any language, any runtime | Edge workers, MCP wrappers, Go, Rust, shell. No SDK to load. |
| [3. MCP (Model Context Protocol)](#path-3-mcp) | LLM agent frameworks | Claude Desktop, Claude Code, Cursor, ChatGPT GPT Builder, or any MCP-capable client. SatRank ships a stdio MCP server. |
| [4. Nostr DVM](#path-4-nostr-dvm) | Sovereign / agent-native | Pure Nostr flow with no HTTP, no API key, no SDK. Agent publishes a kind 5900 job, oracle replies kind 6900. |

The end state is the same regardless of path: your agent posts an intent, gets a ranked list of L402 endpoints (with `http_method`, `stage_posteriors`, and `bayesian.p_success` per candidate), and settles with the one it picked.

**Tip for federated agents:** with the SDK 1.1.0, `aggregateOracles({ baseUrl, maxStaleSec, minCatalogueSize, requireCalibration })` lets you discover all SatRank-compatible oracles via Nostr kind 30784 announcements and filter them by your own trust criteria. Useful when you want to avoid trusting any single oracle. See the [TS SDK quickstart](./docs/sdk/quickstart-ts.md) for usage.

---

## Path 1: SDK native (recommended)

The SDK is a thin wrapper around the public REST API plus an L402 flow driver. It is published on npm as `@satrank/sdk@1.1.0` and on PyPI as `satrank==1.1.0`. Both ship the PR-7 surface — `http_method` + `stage_posteriors` on every candidate, federation primitives via `aggregateOracles()` / `aggregate_oracles()`, and `fulfill()` defaults that close the silent 405-fallback class.

### TypeScript

```bash
npm install @satrank/sdk
```

```typescript
import { SatRank } from '@satrank/sdk';

const sr = new SatRank({ wallet: myLnWallet });

const result = await sr.fulfill({
  category: 'energy/intelligence',
  budget_sats: 50,
});

console.log(result.response);     // the paid API response body
console.log(result.endpoint_url); // which provider endpoint served it
console.log(result.paid_sats);    // what it cost on the wire
```

### Python

```bash
pip install satrank
```

```python
from satrank import SatRank

sr = SatRank(wallet=my_ln_wallet)

result = sr.fulfill(
    category="energy/intelligence",
    budget_sats=50,
)

print(result.response)      # the paid API response body
print(result.endpoint_url)  # which provider endpoint served it
print(result.paid_sats)     # what it cost on the wire
```

### What `sr.fulfill()` actually does

`sr.fulfill()` is a client-side helper. It calls `POST /api/intent` to obtain candidates, then performs the L402 payment flow directly against the selected provider endpoint. SatRank exposes no server-side fulfillment endpoint by design. Here is the sequence it runs:

1. Resolve intent: call `POST https://satrank.dev/api/intent` with the intent, budget, and optional `max_latency_ms`.
2. Pick candidate: take the rank 1 entry from the returned `candidates` list by default. The caller can override this selection.
3. L402 challenge: `GET candidate.endpoint_url` with no auth. The provider responds `402 Payment Required` with `WWW-Authenticate: L402 macaroon=..., invoice=...`.
4. Pay invoice: hand the BOLT11 invoice to the wallet. The wallet pays, returns a 32-byte preimage.
5. L402 retry: `GET candidate.endpoint_url` again with `Authorization: L402 macaroon:preimage`. The provider returns the paid response.
6. Report (optional, off by default): `POST https://satrank.dev/api/report` with the preimage and outcome, so the posterior improves for the next caller.

SatRank never custodies sats and never sees the preimage. The entire payment is between the agent's wallet and the provider.

### What the SDK handles for you

- Rate limiting on `POST /api/intent` (10 requests / 60 seconds / IP). The SDK backs off on `429` using the `Retry-After` header.
- L402 challenge/response parsing.
- Preimage verification against the payment hash.
- Retries on transient network errors with exponential backoff.
- Anonymous outcome reporting via the preimage (optional, behind a flag).
- Wallet abstraction: LND gRPC, LNURL-pay, NWC, or a custom `{ pay(invoice) -> { preimage, paymentHash } }` adapter all work.

### Wallet requirement

`sr.fulfill()` needs a wallet the agent code can reach at call time. Options:

- Local LND node (LND gRPC or REST).
- Nostr Wallet Connect (NWC) to a remote wallet.
- LNURL-pay adapter to a custodial provider.
- Any object exposing `pay(invoice: string) -> Promise<{ preimage: string, paymentHash: string }>`.

If the agent cannot hold a wallet (e.g. stateless function runtime), fall back to Path 2 and let the orchestrator hold the wallet.

---

## Path 2: Direct HTTP

Use this path when the SDK is not an option: other languages, edge runtimes, or custom MCP wrappers. The flow below is the same one the SDK runs, made explicit with `curl`.

### Step 1: Know the category taxonomy (optional)

```bash
curl -sS https://satrank.dev/api/intent/categories
```

Returns the registry's active categories with endpoint counts. Skip if you already know the category string (`energy/intelligence`, `ai/text`, `data/finance`, etc.).

### Step 2: Resolve the intent

```bash
curl -sS -X POST https://satrank.dev/api/intent \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "energy/intelligence",
    "budget_sats": 100,
    "max_latency_ms": null
  }'
```

Returns up to five ranked candidates. Each candidate carries:

- `rank` (1 is best)
- `endpoint_url` (the provider's URL, not satrank.dev)
- `endpoint_hash`, `operator_pubkey`, `operator_id`, `service_name`
- `price_sats`
- `bayesian`: the full posterior block (`p_success`, `ci95_low`, `ci95_high`, `n_obs`, `verdict`, `sources`, `convergence`, `window`)
- `advisory`: a convenience shortcut (`advisory_level`, `recommendation`, `msg`)

Rate limit on this endpoint: 10 requests / 60 seconds / IP. Free (no L402). On limit, expect `HTTP 429` with `Retry-After` in seconds.

### Step 3: Pick a candidate

The SDK defaults to `candidates[0]` (rank 1). A custom client can re-rank by any field: cheapest `price_sats` inside budget, tightest `ci95` interval, highest `p_success`, or a composite of your own.

### Step 4: L402 handshake against the candidate

```bash
# First call: no auth, expect 402 + WWW-Authenticate
curl -i https://grid.ptsolutions.io/v1/intelligence/demand-supply/ercot

# Response:
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: L402 macaroon="AGIA...", invoice="lnbc250n..."
```

Parse the `macaroon` and `invoice` tokens from the header. Pay the BOLT11 invoice with any Lightning wallet. Keep the 32-byte preimage.

```bash
# Second call: L402 auth header with macaroon:preimage
curl -H 'Authorization: L402 AGIA...:abc123...' \
  https://grid.ptsolutions.io/v1/intelligence/demand-supply/ercot
```

Returns the paid response body with `HTTP 200`.

### Step 5: Report outcome (optional, free)

```bash
curl -sS -X POST https://satrank.dev/api/report \
  -H 'Content-Type: application/json' \
  -d '{
    "target": "1830ae448029e7f463bee9e7cc92a44b26b4b974b4b57dd095acad4e7b971c22",
    "reporter": "<your-sha256-hash-or-anonymous>",
    "outcome": "success",
    "paymentHash": "<64-hex>",
    "preimage": "<64-hex>"
  }'
```

Returns `{ reportId, weight, verified, timestamp }`. Free, no quota consumed.

### Authentication model for satrank.dev endpoints

Three tiers of auth coexist:

| Tier | How | When used |
|---|---|---|
| Free, rate-limited | No auth | `/api/intent` (10/60s/IP), leaderboards, stats, health, categories, ping, report |
| Auto-issued L402 | `402 -> 21 sat invoice -> 21-request macaroon` | First call to any paid endpoint (`/api/agent/*`, `/api/profile/*`, `/api/verdicts`, `/api/probe`) |
| Pre-deposited L402 | `POST /api/deposit { amount } -> invoice -> macaroon with tier-locked rate` | Volume callers who want rate discounts |

The SDK handles both L402 paths transparently. Direct-HTTP callers need to implement the 402 retry themselves.

---

## Path 3: MCP

SatRank ships a stdio MCP server (`src/mcp/server.ts`) that exposes the public API as MCP tools. LLM agents using Claude Desktop, Cursor, or any MCP-capable client can discover and call them without HTTP plumbing.

### Install

Add to your MCP client config (the exact file depends on the client: `~/.cursor/mcp.json` for Cursor, Claude Desktop has its own config surface):

```json
{
  "mcpServers": {
    "satrank": {
      "command": "npx",
      "args": ["-y", "tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/your/satrank/checkout",
      "env": {
        "DB_PATH": "./data/satrank.db"
      }
    }
  }
}
```

Reference config committed in the repo: [`mcp-config.json`](./mcp-config.json).

### Exposed tools

The server exposes the following tools. Schema declarations: `src/mcp/server.ts` (zod-validated).

| Tool | Purpose |
|---|---|
| **`intent`** | **Phase 6.0** — resolve an intent (category, keywords, budget, latency ceiling) and get ranked L402 candidates with full posterior, 5-stage `stage_posteriors`, `http_method`, and freshness advisory. The first agent-native primitive |
| **`verify_assertion`** | **Phase 6.0** — offline-verify a kind 30782 transferable assertion or kind 30783 calibration event. Validates Schnorr signature + valid_until + expected oracle pubkey + d-tag. No network call. Use this to compose oracle output across agents without re-querying SatRank |
| `get_agent_score` | Full trust score with components, evidence, verification URLs |
| `get_top_agents` | Leaderboard ranked by posterior |
| `search_agents` | Search by alias (partial match) |
| `get_network_stats` | Global network counters |
| `get_verdict` | SAFE / RISKY / UNKNOWN / INSUFFICIENT with flags and risk profile |
| `get_batch_verdicts` | Batch verdict for up to 100 hashes |
| `get_top_movers` | Agents with biggest 7-day score changes |
| `submit_attestation` | Submit a trust attestation after a transaction |
| `decide` | Internal decision helper retained for LLM reasoning flows |
| `report` | Report a transaction outcome with optional preimage verification |
| `get_profile` | Agent profile with reports, probe uptime, rank, evidence, flags |
| `ping` | Real-time QueryRoutes reachability check, free |

The `intent` + `verify_assertion` pair is the new agent-economy-native primitive: an agent can ask for a service, verify the trust assertion offline, hand it off to a sub-agent, and the sub-agent verifies independently — no round-trip to SatRank.

---

## Path 4: Nostr DVM

**Phase 6.1** — for sovereign Nostr-native agents. SatRank exposes a NIP-90 Data Vending Machine (kind 5900 / 6900). The agent publishes an intent as a Nostr event; the oracle replies on the same relays. No HTTP, no API key.

```javascript
// Agent publishes kind 5900 with j: intent-resolve
const job = await nostr.publish({
  kind: 5900,
  tags: [
    ["j", "intent-resolve"],
    ["i", JSON.stringify({
      category: "data/finance",
      budget_sats: 5,
      max_latency_ms: 2000,
    }), "json"],
    ["bid", "1000"], // optional bid for the DVM
  ],
});

// Oracle replies on the same relays with kind 6900
const result = await nostr.subscribe_one({
  kind: 6900,
  e_tag: job.id,
  timeout: 2000,
});

// result.content === JSON.stringify(intent_response_with_candidates)
```

The DVM also serves the legacy `j: trust-check` job type for node-trust queries.

Use this when your agent never wants to touch HTTP — every interaction stays on Nostr. Pair with `verify_assertion` MCP tool (Path 3) or local Schnorr verification for offline-verifiable composability.

---

## Reading the response: posterior, 5-stage decomposition, and advisory

Every candidate from `/api/intent` carries a Bayesian posterior block, an optional 5-stage L402 contract decomposition (when stage data is available), and an advisory overlay.

```json
{
  "bayesian": {
    "p_success": 0.835,
    "ci95_low": 0.55,
    "ci95_high": 0.986,
    "n_obs": 6.094,
    "verdict": "INSUFFICIENT"
  },
  "stage_posteriors": {
    "p_e2e": 0.81,
    "p_e2e_pessimistic": 0.51,
    "p_e2e_optimistic": 0.94,
    "meaningful_stages": ["challenge", "invoice", "payment", "delivery", "quality"],
    "measured_stages": 5,
    "stages": {
      "challenge": { "p_success": 0.99, "ci95_low": 0.94, "ci95_high": 1.00, "n_obs": 47, "is_meaningful": true },
      "invoice":   { "p_success": 0.98, "ci95_low": 0.91, "ci95_high": 1.00, "n_obs": 38, "is_meaningful": true },
      "payment":   { "p_success": 0.92, "ci95_low": 0.78, "ci95_high": 0.99, "n_obs": 23, "is_meaningful": true },
      "delivery":  { "p_success": 0.96, "ci95_low": 0.85, "ci95_high": 1.00, "n_obs": 19, "is_meaningful": true },
      "quality":   { "p_success": 0.91, "ci95_low": 0.72, "ci95_high": 0.99, "n_obs": 14, "is_meaningful": true }
    }
  },
  "http_method": "POST",
  "advisory": {
    "advisory_level": "yellow",
    "recommendation": "proceed_with_caution",
    "msg": "CI95 width=0.44, low confidence"
  }
}
```

**`bayesian.p_success`** measures the legacy "L402 challenge cycle" posterior (probe-level). **`stage_posteriors.p_e2e`** is the chain-rule product over the 5 stages with `is_meaningful=true` (default threshold: `n_obs >= 3`). An agent that wants the most informative signal reads `stage_posteriors`; an agent that wants the simplest reads `bayesian.p_success`. Both are emitted unconditionally.

The per-stage breakdown answers "which step is likely to fail?" — useful for choosing fallback strategies. A high `challenge` + low `delivery` means the endpoint is reachable but returns junk after payment; an agent should pick a different candidate.

`http_method` is persisted from the upstream registry (Phase 5.10A): pass it to your fulfill request to avoid the silent 405-fallback round-trip on POST-only endpoints.

`verdict` is a threshold on the posterior:

| Verdict | Meaning | Typical agent reaction |
|---|---|---|
| `SAFE` | Narrow CI95, high p_success | Commit, retry on soft failure |
| `UNKNOWN` | Mid p_success | Commit cautiously, set tight timeouts |
| `RISKY` | Low p_success | Hedge: parallel fallback or skip |
| `INSUFFICIENT` | n_obs too low for a reliable posterior | Either explore (pay once, report) or skip to the next candidate |

`ci95_high - ci95_low` is the confidence width. A narrow width means the posterior is stable; a wide width means the score is still learning. An agent that cares about tail risk should filter on CI width, not only on `p_success`.

`advisory` is a convenience overlay that compresses verdict plus CI width into a green / yellow / red recommendation. Use it if you do not want to reason about CI widths yourself.

Full derivation: [methodology sections 3 and 4](https://satrank.dev/methodology).

---

## Reporting outcomes (feedback loop)

Reports are the primary signal that updates the posterior. Submitting them improves the score for every downstream caller. Two auth paths exist, with distinct reporter weights:

| Path | Auth | Reporter weight | When to use |
|---|---|---|---|
| Anonymous via preimage pool | Preimage of a real L402 settlement, no identity | `low` 0.3, `medium` 0.5, `high` 0.7 (tier depends on preimage freshness and pool accounting) | Agents that want to contribute without tying reports to a stable identity |
| Authenticated | `X-API-Key` or NIP-98 signed event | `1.0` | Agents with a stable identity that want maximum signal weight |

Preimage-verified reports are always preferred over self-reported outcomes, because the server can cryptographically confirm the payment settled. Unverified reports are still ingested but with reduced weight.

The endpoint is `POST /api/report`, free, no quota consumed. Reports that reach the server are published to Nostr as kind 30385 after a short aggregation window.

---

## Pricing for integrators

SatRank charges for paid requests on satrank.dev endpoints. There is no subscription, no account, no API-key fee.

### Pay per call

The default: hit any paid endpoint, receive a `402` challenge, pay a 21-sat invoice, get a 21-request macaroon at rate 1 sat/request. Fine for scout agents that do a few calls and move on.

### Deposits with rate discount

`POST /api/deposit { amount }` returns an invoice plus `tierId`, `rateSatsPerRequest`, `discountPct`, and `quotaGranted`. Pay the invoice, then `POST /api/deposit { paymentHash, preimage }` to claim the macaroon.

The rate is locked into the macaroon at settlement. A tier schedule change cannot raise the rate on a paid-up token.

| Deposit | Rate (sat/req) | Requests | Good for |
|---|---|---|---|
| 21 sats | 1.0 | 21 | Scout runs, one-off testing |
| 1,000 sats | 0.5 | 2,000 | Regular daily usage |
| 10,000 sats | 0.2 | 50,000 | Multi-agent fleets |
| 100,000 sats | 0.1 | 1,000,000 | Infrastructure services |
| 1,000,000 sats | 0.05 | 20,000,000 | High-frequency orchestrators |

Live schedule: `GET /api/deposit/tiers`. Landing section: [satrank.dev pricing](https://satrank.dev/#pricing).

---

## Operational notes

**Time.** All timestamps are UTC Unix seconds.

**Response headers to observe.**

| Header | Meaning |
|---|---|
| `X-SatRank-Balance` | Requests remaining on the current L402 macaroon |
| `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` | Free-tier rate limit state |
| `Retry-After` | Seconds to wait on `429` or `503` |

**Common errors.**

| HTTP | Code | Meaning | Suggested reaction |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body or missing field | Fix the payload shape |
| 402 | `PAYMENT_REQUIRED` | Paid endpoint without valid L402 auth | Follow the L402 flow |
| 402 | `BALANCE_EXHAUSTED` | Macaroon has 0 requests left | Drop the Authorization header and get a new macaroon, or top up via deposit |
| 429 | `RATE_LIMITED` | Free-tier rate limit hit | Back off for `Retry-After` seconds |
| 200 | `candidates: []` | No candidate matched the intent filter | Relax `budget_sats` or `max_latency_ms`, or broaden `category` |

**Backoff policy for direct-HTTP callers.** Honor `Retry-After` exactly on 429. On 5xx without `Retry-After`, exponential backoff starting at 500 ms capped at 30 s.

**SSRF safety.** SatRank refuses to probe endpoints that resolve to private ranges (RFC1918, localhost, link-local). If a service registration points at an internal address, the service is rejected at registry time.

**Kind 20900 verdict flash.** When a node's verdict transitions (SAFE becomes RISKY, or vice versa), SatRank publishes an ephemeral Nostr event (kind 20900) on `relay.damus.io`, `nos.lol`, `relay.primal.net`. Agents that watch these relays can react to verdict transitions in near real time without polling.

---

## Support and community

- **GitHub issues** for bugs, schema mismatches, and documentation holes: [proofoftrust21/satrank](https://github.com/proofoftrust21/satrank/issues).
- **Security disclosures** go to `security@satrank.dev`. Do not open a public issue for vulnerabilities. Full policy: [SECURITY.md](./SECURITY.md).
- **General contact**: `contact@satrank.dev`.
- **Nostr**: `satrank@satrank.dev` (NIP-05 verified).
- **Methodology deep-dive**: [satrank.dev/methodology](https://satrank.dev/methodology).
- **Why it exists**: [IMPACT-STATEMENT.md](./IMPACT-STATEMENT.md).
