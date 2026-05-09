---
name: satrank-l402
description: Discover and score L402 endpoints on Bitcoin Lightning before paying. Use when an agent needs to call a paid API and wants a Bayesian trust posterior + offline-verifiable Nostr assertion. Bitcoin-pure, no x402/EVM.
license: MIT
version: 3.0.0
---

# SatRank — L402 trust skill

This skill teaches the agent to **navigate the Bitcoin Lightning agent
economy** through SatRank, the trust oracle on top of L402.

When the agent needs to **call a paid API on Lightning**, follow this loop:

## Step 1 — Discover

Resolve the intent (category + budget + SLA) into a ranked shortlist via
the SatRank MCP `intent` tool, OR a direct HTTP call:

```bash
curl -s -X POST https://satrank.dev/api/intent \
  -H 'Authorization: L402 <macaroon>:<preimage_hex>' \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "data",
    "budget_sats": 20,
    "max_latency_ms": 5000,
    "optimize": "p_success",
    "limit": 3
  }' | jq '.candidates[0]'
```

Each call costs 2 sats via L402. Single-shot agents replay the call after
paying the BOLT11 invoice returned with the 402 challenge. Multi-call agents
should mint a deposit macaroon first (see Step 1bis below).

Look at `bayesian.p_e2e`, `bayesian.ci95`, `stage_posteriors.payment.mean`.
**Skip any candidate with `is_meaningful=false`** — its trust score is
based on too few observations and should be treated as a prior, not data.

## Step 1bis — Mint a deposit macaroon (if you'll make many calls)

```bash
# 1. Mint a 100-sat deposit (free to call) — covers ~50 calls at 2 sats each
curl -s -X POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d '{"sats":100}'
# → returns {macaroon: "deposit_<id>", invoice: "lnbc...", payment_hash: "..."}

# 2. Pay the BOLT11 invoice with any Lightning wallet (WoS, Phoenix, …).

# 3. The preimage your wallet returns becomes the bearer secret.
# Use it on subsequent /api/intent calls. sats_remaining decrements
# atomically per call.

# 4. Check remaining balance:
curl -s https://satrank.dev/api/deposit/<id>
```

The deposit has a 30-day TTL. When `sats_remaining < 2`, mint a new one.

## Step 2 — Verify (optional but recommended)

For a specific endpoint, get the standalone score:

```bash
curl -s "https://satrank.dev/api/services/<url_hash>" | jq '.bayesian'
```

Or via MCP: `satrank.get_endpoint_score(url_hash="<sha256>")`. Free.

## Step 3 — Pay the chosen L402 endpoint directly

SatRank is **not** in the payment path. The agent pays the chosen endpoint
with its own Lightning wallet (`lnget`, NWC, Wallet of Satoshi, etc.):

```bash
lnget --max-cost 20 https://api.example.com/price?ticker=BTC
```

This is the V3 doctrine — SatRank is a trust **oracle**, not a payment
proxy. It tells you what's worth paying for ; you pay it directly.

## Step 4 — (optional) Cache the trust assertion

SatRank publishes signed Nostr trust assertions (kind 30782). Agents can
cache them and verify offline later without re-querying the oracle:

```bash
# Verify a previously-cached assertion offline (no network call)
satrank.verify_assertion(event=<nostr_kind_30782_event>)
```

Useful when an agent wants to commit to a trust judgement and later prove
it consulted SatRank without a re-query at audit time.

## When NOT to use SatRank

- The endpoint is **free**: just curl it.
- You already know which L402 endpoint you want and trust it: use `lnget`
  or your own wallet directly.
- You want **x402 / USDC / EVM**: not supported. SatRank is Lightning-pure.

## When SatRank is useful

- You need to discover L402 endpoints in a category you've never used.
- You want to compare candidates before spending sats.
- You want a Bayesian trust posterior backed by a streaming probe history.
- You want to cache an offline-verifiable trust judgement.

## MCP install (zero shell scripting)

```bash
claude mcp add satrank -- npx -y satrank-mcp
```

Then the 3 V3 tools are callable natively:

| Tool | Purpose | Cost |
|---|---|---|
| `satrank.intent` | Discover + rank L402 candidates | 2 sats per call |
| `satrank.get_endpoint_score` | Per-endpoint score snapshot | free |
| `satrank.verify_assertion` | Offline Schnorr verify of a Nostr assertion | free |

## Costs

| Action | Cost |
|---|---|
| `intent` | 2 sats per call |
| `intent` via deposit credits | 2 sats per call (amortized over deposit TTL) |
| `get_endpoint_score` | 0 sats |
| `verify_assertion` | 0 sats |
| `services/categories`, `services/best`, `oracle/budget` | 0 sats |

No subscription, no API key, no signup — pure L402 where payment is needed.
