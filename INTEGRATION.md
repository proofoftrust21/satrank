# Integrating SatRank into your autonomous agent

SatRank provides route reliability scoring for Lightning payments.
Before paying, ask SatRank for a GO/NO-GO decision. After paying, report the outcome.

**Quick start:** run the example agent loop to see the full cycle in action:
```bash
SATRANK_URL=https://satrank.dev SATRANK_API_KEY=<key> npx tsx examples/agent-loop.ts
```

Three integration paths, from easiest to most flexible.

---

## 1. Via MCP (Model Context Protocol)

Best for: autonomous agents using Claude, GPT, or any MCP-compatible runtime.

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
| `decide` | GO/NO-GO decision with success probability, the primary pre-transaction tool |
| `report` | Report outcome (success/failure/timeout), L402 token or API key (FREE) |
| `get_profile` | Agent profile with reports, probe uptime, rank, evidence |
| `get_agent_score` | Full trust score with components, evidence, and verification URLs |
| `get_verdict` | SAFE/RISKY/UNKNOWN with risk profile and optional personal trust graph |
| `get_batch_verdicts` | Batch verdict for up to 100 agents in one call |
| `get_top_agents` | Leaderboard ranked by score |
| `search_agents` | Search by alias (partial match) |
| `get_network_stats` | Global network statistics |
| `get_top_movers` | Agents with biggest 7-day score changes |
| `ping` | Real-time reachability check via QueryRoutes (FREE) |
| `submit_attestation` | Submit a trust attestation after a transaction (FREE) |

### Example: decide → pay → report
```
# Step 1: Should I pay this agent?
Agent calls decide({ target: "counterparty-hash", caller: "my-hash", walletProvider: "phoenix", serviceUrl: "https://api.example.com" })
→ { go: true, successRate: 0.98, verdict: "SAFE", pathfinding: { hops: 1, sourceNode: "03864ef..." }, serviceHealth: { status: "healthy", servicePriceSats: 1 } }

# Step 2: Agent proceeds with payment (if go=true)

# Step 3: Report outcome
Agent calls report({ target: "counterparty-hash", reporter: "my-hash", outcome: "success" })
→ { reportId: "...", verified: false, weight: 0.75, timestamp: 1712000000 }
```

### Example: check score before transacting
```
User: Should I accept a payment channel from agent abc123...?

Agent calls get_agent_score({ publicKeyHash: "abc123..." })

Agent: This agent has a trust score of 73/100 (medium confidence).
       450 channels, centrality rank #12, peer trust 0.3 BTC/channel,
       active for 730 days. Verifiable:
       - Lightning node: https://mempool.space/lightning/node/02abc...
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

### One line: decide → pay → report

```typescript
import { SatRankClient } from '@satrank/sdk';

const satrank = new SatRankClient('https://your-satrank-instance.com', {
  headers: { 'Authorization': 'L402 <macaroon>:<preimage>' }
});

// Full cycle in one call. The report is automatic.
const result = await satrank.transact('counterparty-hash', 'my-agent-hash', async () => {
  const payment = await myWallet.pay(invoice);
  return {
    success: payment.ok,
    preimage: payment.preimage,   // optional: gives 2x weight bonus
    paymentHash: payment.hash,    // optional: for preimage verification
  };
});

if (!result.paid) {
  console.log(`Skipped -- ${result.decision.reason}`);
} else {
  console.log(`Paid. Report weight: ${result.report?.weight}`);
}
```

### Check score
```typescript
const result = await satrank.getScore('a1b2c3d4e5f6...');

if (result.score.total < 30) {
  console.log('Low trust -- require escrow or decline');
} else if (result.score.total < 60) {
  console.log('Medium trust -- proceed with caution');
} else {
  console.log('High trust -- proceed normally');
}
```

---

## 3. Via HTTP API (any language)

Best for: non-JS agents, scripts, or direct integration.

### Base URL

```
https://your-satrank-instance.com/api
```

### Decision endpoints (recommended for agents)

```bash
# GO / NO-GO decision (L402-gated)
curl -X POST https://satrank.example/api/decide \
  -H 'Content-Type: application/json' \
  -H 'Authorization: L402 <macaroon>:<preimage>' \
  -d '{"target": "<hash>", "caller": "<your-hash>", "walletProvider": "phoenix"}'
# walletProvider: phoenix|wos|strike|blink|breez|zeus|coinos|cashapp
# Or use callerNodePubkey for any Lightning pubkey as pathfinding source

# Report outcome (FREE -- L402 token or API key)
curl -X POST https://satrank.example/api/report \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-api-key' \
  -d '{"target": "<hash>", "reporter": "<your-hash>", "outcome": "success"}'

# Agent profile (L402-gated)
curl -H 'Authorization: L402 <macaroon>:<preimage>' \
  https://satrank.example/api/profile/<hash>
```

### L402-gated endpoints (1 sat = 1 request)

Two payment paths:
- **Standard L402:** hit any paid endpoint without credentials → 402 + BOLT11 invoice for 21 sats (21 requests). Pay, use `Authorization: L402 <macaroon>:<preimage>`.
- **Deposit:** `POST /api/deposit` with `{ "amount": 500 }` → invoice for 500 sats (500 requests). Pay, verify, use `Authorization: L402 deposit:<preimage>`.

Both tokens work on all paid endpoints. The `X-SatRank-Balance` header on every response shows remaining requests. At 0, the next call returns `BALANCE_EXHAUSTED` (402) — drop the Authorization header for a new 21-sat invoice, or use deposit for bulk.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/decide` | L402 | GO/NO-GO with success probability |
| `GET /api/profile/{id}` | L402 | Agent profile with reports, uptime, rank |
| `GET /api/agent/{hash}` | L402 | Full score + evidence |
| `GET /api/agent/{hash}/verdict` | L402 | SAFE/RISKY/UNKNOWN verdict |
| `GET /api/agent/{hash}/history` | L402 | Score history over time |
| `GET /api/agent/{hash}/attestations` | L402 | Attestations received |
| `POST /api/verdicts` | L402 | Batch verdict (up to 100 hashes) |
| `POST /api/best-route` | L402 | Batch pathfinding (up to 50 targets, top 3 by route quality) |

### Free endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/deposit` | None | Buy 21–10,000 requests in one invoice (FREE endpoint) |
| `POST /api/report` | L402 token or API Key | Report outcome (FREE, no quota consumed) |
| `GET /api/ping/{pubkey}` | None | Real-time reachability check (FREE) |
| `POST /api/attestations` | API Key | Submit attestation (FREE, no payment) |
| `GET /api/agents/top` | None | Leaderboard |
| `GET /api/agents/search` | None | Search by alias |
| `GET /api/agents/movers` | None | Top movers (7-day delta) |
| `GET /api/health` | None | Service health |
| `GET /api/version` | None | Build version and schema info |
| `GET /api/stats` | None | Network statistics |

> **Reports and attestations are free.** They are the fuel of the trust network.
> Every report you submit makes the scoring more accurate for everyone.

### Auto-indexation

When you query an unknown Lightning pubkey (66 hex chars starting with 02 or 03),
SatRank returns `202 Accepted` and indexes the node in the background. Retry after 10 seconds.

---

## Scoring methodology

SatRank computes a composite trust score (0-100) from 5 weighted factors:

| Factor | Weight | Source |
|--------|--------|--------|
| Volume | 25% | Verified transaction count (log-normalized) |
| Reputation | 30% | 5 sub-signals: sovereign PageRank, peer trust, routing quality, capacity trend, fee stability. LN+ ratings as multiplicative modifier (x1.0-1.05) |
| Seniority | 15% | Days since first seen (diminishing returns) |
| Regularity | 15% | Consistency of transaction intervals |
| Diversity | 15% | Unique counterparties (log-normalized) |

Anti-gaming: mutual-loop detection (95% penalty), cycle detection up to 4 hops (90% penalty), minimum 7-day seniority to attest, attestation concentration limits.

Full methodology: `/methodology` on any SatRank instance.

---

## Comparison with alternatives

| | SatRank | Web of Trust (WoT) | Score.Kred | NaN Mesh |
|---|---|---|---|---|
| **Scoring method** | Composite 5-factor (volume, reputation, seniority, regularity, diversity) | Binary trust/distrust edges | Social influence aggregation | Behavioral clustering |
| **Data sources** | Lightning graph (centrality, capacity), route probes, LN+ ratings (bonus) | User-created trust assertions | Twitter, GitHub, LinkedIn | On-chain transactions |
| **Payment model** | L402 (1 sat/req, deposit up to 10k) | Free | Freemium SaaS | Not public |
| **Anti-gaming** | Mutual-loop detection, attestation concentration limits, seniority gates | Sybil-vulnerable (trust is free) | Relies on social platform identity | On-chain cost as barrier |
| **Evidence transparency** | Full: verification URLs to mempool.space, LN+, raw transaction samples | Partial: trust graph visible | Opaque scoring | Opaque scoring |
| **Agent-native** | Yes: MCP tools, TypeScript SDK, REST API | No: designed for humans | No: web dashboard only | No: research prototype |
| **Real-time** | Yes: scores recomputed on demand with TTL cache | Depends on implementation | Periodic batch updates | Periodic batch updates |

### SatRank weaknesses (honest assessment)

- **Cold start**: New agents with no transaction history get a score of 0. The system has no bootstrapping mechanism beyond manual attestations.
- **Lightning-centric**: The reputation component uses graph centrality and peer trust. Agents operating outside Lightning have fewer signals available.
- **Centralized index**: While data sources are verifiable, the scoring computation is centralized. Mitigation: scores are published as NIP-85 Trusted Assertions on Nostr for independent verification.
- **Small network effect**: Value increases with adoption. Currently useful primarily within the SatRank ecosystem.
