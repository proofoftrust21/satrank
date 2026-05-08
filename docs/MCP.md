# SatRank MCP server

Trust oracle for AI agents on Bitcoin Lightning.

`satrank-mcp` v2.0 ships a **3-tool minimal surface** focused on the agent
consumer parcours: pre-pay discovery, individual endpoint score lookup, and
offline assertion verification. Installable in any MCP-compatible AI agent
(Claude Code, Cursor, Codex, n8n, Claude Desktop, etc.).

This is the **Bitcoin-pure trust layer** that sits BEFORE the payment hop.
Agents pay with whatever Lightning wallet they're configured with (`lnget`,
`aperture`, NWC) ; SatRank decides what's worth paying for, exposes the
posterior, and ships the offline-verifiable assertion event for downstream
oracle aggregation.

## What you get with one install (V2 — 3 tools)

| Tool | Purpose |
|---|---|
| `intent` | Resolve a category + keywords + budget + SLA into a ranked list of L402 candidates. Returns Bayesian p_success + ci95 + 5-stage breakdown per candidate. Free to call ; pass `fresh: true` for a 2-sat sync probe. |
| `get_endpoint_score` | Read the public scoring snapshot for a specific URL (sha256). Same posteriors + freshness status, scoped to one endpoint. |
| `verify_assertion` | Verify offline a SatRank Nostr trust assertion (kind 30782) or oracle calibration (kind 30783). No network call. Compose oracle output across agents without re-querying. |

**Self-hosters** running the full repo (`src/mcp/server.ts`) keep access to
the extended surface — fulfill proxy, mini-LLM L402 endpoints, AEPS daily
anchor / inclusion-proof / dispute / observer / multi-hop tools — gated by
feature flags (`FULFILL_ENABLED`, `MINI_LLM_ENABLED`, `CLAIM_ENGINE_ENABLED`,
`AGENT_BONDS_ENABLED`, `AEPS_DISPUTE_ENABLED`, `FORK_DETECTION_ENABLED`).

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

### Cursor / Codex / any MCP client

Same idea — point your MCP client at `npx -y satrank-mcp`. Stdio transport.

### Docker

```bash
docker run --rm -i \
  -e SATRANK_API_BASE=https://satrank.dev \
  -e DATABASE_URL=postgres://satrank:satrank@host:5432/satrank \
  ghcr.io/proofoftrust21/satrank-mcp:latest
```

### From source

```bash
git clone https://github.com/proofoftrust21/satrank
cd satrank
npm install
npm run build
node dist/mcp/server.js
```

## Environment

The MCP server reads configuration from environment variables :

| Var | Required | Default | What |
|---|---|---|---|
| `SATRANK_API_BASE` | yes | `https://satrank.dev` | The HTTP API the MCP proxies to (use `http://localhost:3000` for self-hosted) |
| `DATABASE_URL` | yes | none | Postgres connection (used for the offline tools that don't go through HTTP) |
| `LND_REST_URL` | optional | none | Local LND node for routing queries (only required if you run a local SatRank instance) |

## Example agent flow

```
1. agent → satrank.intent(category="data/finance", keywords=["price", "stock"])
   → returns 3 ranked candidates with bayesian.p_success, ci95, stage_posteriors

2. agent → satrank.get_endpoint_score(url_hash="...")
   → independent verification of the candidate's Bayesian trust posterior

3. agent → satrank.fulfill(intent={...}, max_sats=20, max_latency_ms=5000)
   → SatRank pays the L402 endpoint, returns body + body_sha256 + preimage
   → fulfill writes a signed evidence_receipt automatically

4. agent → satrank.fulfill_evidence(job_id="...")
   → returns the Ed25519-signed audit trail for compliance reporting

5. (optional) agent → satrank.aeps.inclusion_proof(receipt_id=...)
   → returns the Merkle audit path against the daily L1 anchor on Bitcoin
```

## Why this is indispensable (vs alternatives)

| Capability | SatRank MCP | `lightning-agent-tools` | x402 stack | Compliance frameworks (MS AGT, Asqav) |
|---|---|---|---|---|
| Discover L402 endpoints | ✓ ranked by Bayesian p_success | ✗ no discovery | ✗ EVM-only | ✗ |
| Pay an L402 endpoint | ✓ via fulfill proxy | ✓ via lnget | ✓ via x402 | ✗ |
| Cryptographic evidence per call | ✓ Ed25519 + L1 anchor | ✗ | ✗ | ✗ self-signed only |
| Sign third-party API responses | ✓ unique | ✗ | ✗ | ✗ only own actions |
| Bitcoin-pure | ✓ | ✓ | ✗ EVM | partial |
| Cross-framework agent reputation | ✓ | ✗ | partial | ✗ |
| Slashable operator bonds | ✓ | ✗ | partial | ✗ |

## Lightning-pure stance

SatRank MCP only emits and consumes Lightning Network sats and Lightning-routed
Taproot Assets (USDT-LN). No x402, no Base, no EVM. This is doctrine, not
configuration.

## Distribution registries

- npm : `npm install -g satrank-mcp`
- MCP registry : https://registry.modelcontextprotocol.io/satrank
- Smithery : https://smithery.ai/server/proofoftrust21/satrank
- Glama : https://glama.ai/mcp/servers/proofoftrust21/satrank
- Source : https://github.com/proofoftrust21/satrank

## Spec conformance

- MCP protocol version : 2024-11-05 + 2025-03-26 (negotiated by client)
- Transport : stdio
- Tool count : 27 (16 read-only, 11 write/commerce)
- License : MIT
