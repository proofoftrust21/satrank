---
name: satrank-l402
description: Discover and score L402 endpoints on Bitcoin Lightning before paying. Use when an agent needs to call a paid API and wants a Bayesian trust posterior + offline-verifiable Nostr assertion. Self-hosters can opt into the full audit/fulfill/AEPS surface. Bitcoin-pure, no x402/EVM.
license: MIT
version: 2.0.0
---

# SatRank — L402 trust + audit skill

This skill teaches the agent to **navigate the Bitcoin Lightning agent economy**
through SatRank, the trust+audit oracle on top of L402.

When the agent needs to **call a paid API**, follow this loop :

## Step 1 — Discover

Resolve the intent (category + keywords + budget) into a ranked shortlist
via the SatRank MCP `intent` tool, OR a direct HTTP call :

```bash
curl -s -X POST https://satrank.dev/api/intent \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "data/finance",
    "keywords": ["price", "stock"],
    "budget_sats": 20,
    "max_latency_ms": 5000,
    "optimize": "p_success"
  }' | jq '.candidates[0]'
```

Look at `bayesian.p_success`, `bayesian.ci95`, `stage_posteriors.payment.p_success`.
**Skip any candidate with `is_meaningful=false`** — its trust score is a prior,
not data.

## Step 2 — Verify (optional but recommended)

For a specific endpoint, get the standalone score :

```bash
curl -s "https://satrank.dev/api/services/<url_hash>" | jq '.bayesian'
```

Or via MCP : `satrank.get_endpoint_score(url_hash="<sha256>")`.

## Step 3 — Pay through SatRank fulfill (compliance-grade audit trail)

If the agent wants the **post-pay evidence trail automatically signed and
anchored**, route the call through SatRank's fulfill proxy :

```bash
curl -s -X POST https://satrank.dev/api/fulfill \
  -H 'Authorization: Nostr <NIP-98>' \
  -H 'Content-Type: application/json' \
  -d '{
    "intent": {"category": "data/finance", "keywords": ["price"]},
    "max_sats": 20,
    "max_latency_ms": 5000
  }' | jq
```

SatRank pays the L402 endpoint, returns the body + a `job_id`, AND auto-issues
an Ed25519-signed evidence receipt covered by the daily AEPS Bitcoin L1 anchor.

**Alternative — direct payment via lnget (no audit trail) :**

```bash
lnget --max-cost 20 https://api.example.com/price?ticker=BTC
```

Use `lnget` when you only need the body, no evidence trail. Use SatRank
fulfill when you need regulator-grade audit per call.

## Step 4 — Retrieve evidence

```bash
curl -s "https://satrank.dev/api/fulfill/<job_id>/evidence" | jq
```

The receipt is :
- canonical-JSON of `{agent_pubkey, attempt_index, body_sha256, candidate_url,
  intent_hash, job_id, operator_pubkey, sats_paid, ts_started, ts_finished,
  ts_settled, satrank_version}`
- Ed25519-signed by the SatRank operator pubkey (`/.well-known/satrank-key`)
- inclusion in the daily Merkle tree anchored on Bitcoin L1 via OP_RETURN

For long-term retention, save :
- `payload_canonical_json`
- `signature_b64`
- `payload_sha256`
- the `daily_anchor` for that UTC day (via `aeps.daily_anchor` MCP tool)

This is what the EU AI Act Article 12 (logs by-design + 6 months retention)
requires for high-risk AI systems.

## Step 5 — (rare) Open a dispute

If the operator delivered something inconsistent (body_sha256 mismatch,
schema violation), open an AEPS §10 dispute :

```bash
curl -s -X POST https://satrank.dev/api/aeps/dispute \
  -H 'Authorization: Nostr <NIP-98>' \
  -H 'Content-Type: application/json' \
  -d '{"dispute_type": "body_mismatch", "respondent_pubkey": "...",
       "oracle_pubkeys": ["...", "..."], "oracle_threshold": 2,
       "evidence_receipt_id": <id>}'
```

Disputes are resolved by BIP-340 Schnorr threshold attestation. Resolved
disputes can trigger 1×/2×/3×/5× slashing on the operator's bond.

## When NOT to use SatRank

- The endpoint is **free** : just curl it.
- You do **not need an audit trail** AND already have a wallet : use `lnget`
  directly (`lnget https://...`).
- You want **x402 / USDC / EVM** : not supported. SatRank is Lightning-pure.

## When SatRank is indispensable

- Compliance / regulator personas — Ed25519 evidence + L1 Merkle anchor =
  forensic chain that maps to SOX, MiFID, EU AI Act.
- Multi-source intel agents that need a trust score before paying.
- Any flow where a refund path matters (the operator might fail post-pay).
- Agents that would benefit from a slashable bond pool against fraudulent
  operators (operator bonds = real economic recourse).

## MCP install (zero shell scripting)

Add SatRank MCP to Claude Code with one command :

```bash
claude mcp add satrank -- npx -y satrank-mcp
```

Then the 3 V2 tools are callable natively : `satrank.intent`,
`satrank.get_endpoint_score`, `satrank.verify_assertion`. The fulfill /
mini-llm / aeps.* surfaces stay reachable via direct HTTP for self-hosters
running the full repo (`src/mcp/server.ts`).

## SatRank costs

| Action | Cost |
|---|---|
| `intent` (free tier) | 0 sats |
| `intent?fresh=true` | 2 sats |
| `fulfill` premium | max(1, 10% of invoice) |
| `mini-llm/{classify,summarize,translate}` | 10 sats each |
| `aeps.*` reads | 0 sats |
| `evidence_receipt` read | 0 sats |

Free reads, paid only on actions that incur backend cost. No subscription,
no API key, no signup — pure L402 + NIP-98 where authentication is needed.
