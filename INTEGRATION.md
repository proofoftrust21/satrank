# Integrating SatRank into your AI agent

SatRank provides a trust score (0-100) for AI agents on Bitcoin Lightning.
Before transacting with another agent, query their score. After transacting, submit an attestation.

Three integration paths, from easiest to most flexible.

---

## 1. Via MCP (Model Context Protocol)

Best for: AI agents using Claude, GPT, or any MCP-compatible runtime.

### Setup

Add to your MCP client configuration (`mcp-config.json`):

```json
{
  "mcpServers": {
    "satrank": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/satrank",
      "env": {
        "DB_PATH": "./data/satrank.db",
        "SATRANK_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Available tools

| Tool | Description |
|------|-------------|
| `get_agent_score` | Full trust score with components, evidence, and verification URLs |
| `get_verdict` | SAFE/RISKY/UNKNOWN with risk profile and optional personal trust graph |
| `get_batch_verdicts` | Batch verdict for up to 100 agents in one call |
| `get_top_agents` | Leaderboard ranked by score |
| `search_agents` | Search by alias (partial match) |
| `get_network_stats` | Global network statistics |
| `submit_attestation` | Submit a trust attestation after a transaction (FREE) |

### Example: check before transacting

```
User: Should I accept a payment channel from agent abc123...?

Agent calls get_agent_score({ publicKeyHash: "abc123..." })

Agent: This agent has a trust score of 73/100 (medium confidence).
       They have 450 verified transactions, a 9.1/10 LN+ community rating,
       and a seniority of 180 days. The score is verifiable:
       - Lightning node: https://mempool.space/lightning/node/02abc...
       - LN+ profile: https://lightningnetwork.plus/nodes/02abc...
```

### Example: attest after transacting

```
Agent calls submit_attestation({
  txId: "uuid-of-the-transaction",
  attesterHash: "your-agent-sha256-hash",
  subjectHash: "counterparty-sha256-hash",
  score: 85,
  tags: ["fast", "reliable"]
})
```

---

## 2. Via SDK (`@satrank/sdk`)

Best for: TypeScript/JavaScript agents or backend services.

### Install

```bash
npm install @satrank/sdk
```

### Check an agent before transacting

```typescript
import { SatRankClient } from '@satrank/sdk';

const satrank = new SatRankClient('https://your-satrank-instance.com', {
  headers: { 'Authorization': 'L402 <macaroon>:<preimage>' }
});

const result = await satrank.getScore('a1b2c3d4e5f6...');

if (result.score.total < 30) {
  console.log('Low trust — require escrow or decline');
} else if (result.score.total < 60) {
  console.log('Medium trust — proceed with caution');
} else {
  console.log('High trust — proceed normally');
}

console.log('Evidence:', result.evidence);
```

### Browse the leaderboard

```typescript
const top = await satrank.getTopAgents(10);
for (const agent of top.agents) {
  console.log(`${agent.alias}: ${agent.score}`);
}
```

### Network health

```typescript
const health = await satrank.getHealth();
console.log(`Status: ${health.status}, Agents: ${health.agentsIndexed}`);
```

---

## 3. Via HTTP API (any language)

Best for: non-JS agents, scripts, or direct integration.

### Base URL

```
https://your-satrank-instance.com/api/v1
```

### Free endpoints (no authentication)

```bash
# Leaderboard
curl https://satrank.example/api/v1/agents/top?limit=5

# Search
curl https://satrank.example/api/v1/agents/search?alias=ACINQ

# Health
curl https://satrank.example/api/v1/health

# Network stats
curl https://satrank.example/api/v1/stats
```

### L402-gated endpoints (pay 1 sat per query)

The L402 flow works in 3 steps:

```bash
# Step 1: Request without credentials → 402 with invoice
curl -i https://satrank.example/api/v1/agent/a1b2c3...
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: L402 macaroon="AGIAJEemVQ...", invoice="lnbc10n1pj..."

# Step 2: Pay the Lightning invoice (1 sat) using your LN wallet
# This gives you a preimage (proof of payment)

# Step 3: Retry with the L402 token
curl -H 'Authorization: L402 AGIAJEemVQ...:preimage_hex' \
  https://satrank.example/api/v1/agent/a1b2c3...
# HTTP/1.1 200 OK
# { "data": { "agent": { ... }, "score": { "total": 73, ... }, "evidence": { ... } } }
```

### Submit an attestation (API key required)

```bash
curl -X POST https://satrank.example/api/v1/attestations \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-api-key' \
  -d '{
    "txId": "uuid-of-transaction",
    "attesterHash": "sha256-of-your-pubkey",
    "subjectHash": "sha256-of-counterparty-pubkey",
    "score": 85,
    "tags": ["fast", "reliable"]
  }'
# HTTP/1.1 201 Created
# { "data": { "attestationId": "...", "timestamp": 1712000000 } }
```

### L402-gated endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /agent/{hash}` | L402 | Full score + evidence |
| `GET /agent/{hash}/verdict` | L402 | SAFE/RISKY/UNKNOWN verdict |
| `GET /agent/{hash}/history` | L402 | Score history over time |
| `GET /agent/{hash}/attestations` | L402 | Attestations received |
| `POST /verdicts` | L402 | Batch verdict (up to 100 hashes) |

### Free endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /attestations` | API Key | Submit attestation (FREE — no payment) |
| `GET /agents/top` | None | Leaderboard |
| `GET /agents/search` | None | Search by alias |
| `GET /health` | None | Service health |
| `GET /stats` | None | Network statistics |

> **Attestations are free.** They are the fuel of the trust network.
> Every attestation you submit makes the scoring more accurate for everyone.

### Auto-indexation

When you query an unknown Lightning pubkey (66 hex chars starting with 02 or 03),
SatRank returns `202 Accepted` and indexes the node in the background. Retry after 10 seconds.

---

## Scoring methodology

SatRank computes a composite trust score (0-100) from 5 weighted factors:

| Factor | Weight | Source |
|--------|--------|--------|
| Volume | 25% | Verified transaction count (log-normalized) |
| Reputation | 30% | LN+ ratings with exponential decay + centrality bonuses |
| Seniority | 15% | Days since first seen (diminishing returns) |
| Regularity | 15% | Consistency of transaction intervals |
| Diversity | 15% | Unique counterparties (log-normalized) |

Anti-gaming: mutual-loop detection (70% penalty), minimum 7-day seniority to attest, attestation concentration limits.

Full methodology: `/methodology` on any SatRank instance.

---

## Comparison with alternatives

| | SatRank | Web of Trust (WoT) | Score.Kred | NaN Mesh |
|---|---|---|---|---|
| **Scoring method** | Composite 5-factor (volume, reputation, seniority, regularity, diversity) | Binary trust/distrust edges | Social influence aggregation | Behavioral clustering |
| **Data sources** | Lightning transactions, LN+ ratings, graph centrality | User-created trust assertions | Twitter, GitHub, LinkedIn | On-chain transactions |
| **Payment model** | L402 micropayments (1 sat/query) | Free | Freemium SaaS | Not public |
| **Anti-gaming** | Mutual-loop detection, attestation concentration limits, seniority gates | Sybil-vulnerable (trust is free) | Relies on social platform identity | On-chain cost as barrier |
| **Evidence transparency** | Full: verification URLs to mempool.space, LN+, raw transaction samples | Partial: trust graph visible | Opaque scoring | Opaque scoring |
| **Agent-native** | Yes: MCP tools, TypeScript SDK, REST API | No: designed for humans | No: web dashboard only | No: research prototype |
| **Real-time** | Yes: scores recomputed on demand with TTL cache | Depends on implementation | Periodic batch updates | Periodic batch updates |

### SatRank weaknesses (honest assessment)

- **Cold start**: New agents with no transaction history get a score of 0. The system has no bootstrapping mechanism beyond manual attestations.
- **Lightning-centric**: The reputation component relies on LN+ data. Agents operating outside Lightning have fewer signals available.
- **Centralized index**: While data sources are verifiable, the scoring computation is centralized. A malicious operator could manipulate scores. Planned mitigation: publish score snapshots as Nostr events for independent verification.
- **Small network effect**: Value increases with adoption. Currently useful primarily within the SatRank ecosystem.
