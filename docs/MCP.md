# SatRank MCP server

Lightning trust oracle for AI agents on L402. Bitcoin-pure.

`satrank-mcp@3.0` ships a **3-tool minimal surface** focused on the agent
consumer parcours: pre-pay discovery, individual endpoint score lookup, and
offline assertion verification. Installable in any MCP-compatible AI agent
(Claude Code, Cursor, Codex, n8n, Claude Desktop, etc.).

This is the **Bitcoin-pure trust layer** that sits BEFORE the payment hop.
Agents pay with whatever Lightning wallet they're configured with (`lnget`,
NWC, Wallet of Satoshi, Phoenix). SatRank decides what's worth paying for
and exposes the Bayesian posterior + the offline-verifiable Nostr trust
assertion.

## What you get with one install

| Tool | Purpose |
|---|---|
| `intent` | Resolve a category + budget + SLA into a ranked list of L402 candidates. Returns Bayesian p_e2e + ci95 + 5-stage breakdown per candidate. **Paid** — 2 sats per call via L402, settled by the agent's wallet. |
| `get_endpoint_score` | Read the public scoring snapshot for a specific URL (sha256). Same posteriors + freshness status, scoped to one endpoint. **Free.** |
| `verify_assertion` | Verify offline a SatRank Nostr trust assertion (kind 30782). No network call. Compose oracle output across agents without re-querying. **Free.** |

That's the entire surface. No fulfill proxy, no AEPS audit chain, no LLM
gateway — V3 is the Bitcoin-pure trust layer, nothing more.

## Install

### Claude Code

```bash
claude mcp add satrank -- npx -y satrank-mcp
```

Or via the configuration file (`~/.config/claude/mcp.json`):

```json
{
  "mcpServers": {
    "satrank": {
      "command": "npx",
      "args": ["-y", "satrank-mcp"]
    }
  }
}
```

### Cursor / Codex / n8n / any MCP client

Same idea — point your MCP client at `npx -y satrank-mcp`. Stdio transport.

### From source

```bash
git clone https://github.com/proofoftrust21/satrank
cd satrank
npm install
npm run build
node dist/mcp.js
```

## Environment

The MCP server reads configuration from environment variables:

| Var | Required | Default | What |
|---|---|---|---|
| `SATRANK_API_BASE` | no | `https://satrank.dev` | The HTTP API the MCP proxies to. Override with `http://localhost:3000` for self-hosted. |

That's it. The MCP package is HTTP-only — it doesn't talk to Postgres or
LND directly. To run a self-hosted SatRank, see the root README.

## Example agent flow

```
1. agent → satrank.intent(category="data", budget_sats=20, optimize="latency")
   → returns 3 ranked candidates with p_e2e, ci95, stage_posteriors,
     median_latency_ms, price_sats. The agent pays 2 sats once via L402.

2. agent → satrank.get_endpoint_score(url_hash="<sha256>")
   → independent verification of one candidate's posterior. Free.

3. agent calls the L402 endpoint directly with its own wallet.
   SatRank is not in the payment path.

4. (optional) agent → satrank.verify_assertion(event=<nostr_kind_30782>)
   → offline Schnorr verify. Useful when caching trust assertions for
     later replay without re-querying SatRank.
```

## Multi-call discovery (deposit credits)

For agents that will make many `intent` calls in a window, the underlying
HTTP API supports a deposit primitive: pre-pay N sats once, spend across
many calls without a Lightning round-trip per call. The MCP tool stays
single-shot ; deposit is exposed at the HTTP layer:

```bash
# 1. Mint a 100-sat deposit macaroon (free to call)
curl -s -X POST https://satrank.dev/api/deposit \
  -H 'Content-Type: application/json' \
  -d '{"sats":100}'
# → returns {macaroon: "deposit_<id>", invoice: "lnbc...", payment_hash: "..."}

# 2. Pay the BOLT11 invoice with any Lightning wallet.

# 3. Subsequent /api/intent calls use the deposit as a bearer:
curl -s -X POST https://satrank.dev/api/intent \
  -H 'Authorization: L402 deposit_<id>:<preimage_hex>' \
  -H 'Content-Type: application/json' \
  -d '{"category":"data"}'
```

## Lightning-pure stance

SatRank only emits and consumes Lightning sats. No x402, no Base, no EVM.
This is doctrine, not configuration. The trust layer settles in the same
currency the payment layer does.

## Distribution

- npm: `npm install -g satrank-mcp`
- MCP registry: `dev.satrank/mcp`
- Source: https://github.com/proofoftrust21/satrank

## Spec conformance

- MCP protocol version: negotiated by client (2024-11-05 + 2025-03-26)
- Transport: stdio
- Tool count: 3
- License: MIT (MCP server), AGPL-3.0 (root oracle implementation)
