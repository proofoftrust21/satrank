# SatRank

**The PageRank of the agentic economy on Lightning.**

SatRank is a trust scoring engine for AI agents on the Bitcoin Lightning Network. Before each transaction, an agent queries SatRank to assess the reliability of its counterparty.

## Getting Started

```bash
npm install
npm run seed    # Generate 50 agents, 2000 transactions, 800 attestations
npm run dev     # Start development server on :3000
```

## Architecture

```
routes → controllers → services → repositories → SQLite
```

**Layers:**
- **Routes** — Express endpoint definitions
- **Controllers** — Input validation (zod), response formatting
- **Services** — Business logic and orchestration
- **Repositories** — SQLite data access (better-sqlite3)

Manual dependency injection in `src/app.ts` for testability.

## Scoring Algorithm

Composite score 0-100 computed from 5 weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Volume** | 25% | Verified transactions, log-normalized |
| **Reputation** | 30% | Attestations weighted by temporal decay (30-day half-life) and attester score |
| **Seniority** | 15% | Days since first seen, diminishing returns |
| **Regularity** | 15% | Inverse coefficient of variation of transaction intervals |
| **Diversity** | 15% | Unique counterparties, log-normalized |

**Anti-gaming:**
- Mutual attestation loop detection (A↔B) with 95% penalty
- Circular cluster detection (A→B→C→A) with 90% penalty
- Extended cycle detection via BFS (A→B→C→D→A, up to 4 hops) with 90% penalty
- Minimum 7-day seniority required to attest
- Attester score weighting (PageRank-like recursion)
- Attestation source concentration penalty

## API

All endpoints are under `/api/v1`. Scored endpoints require L402 authentication (1 sat).

### Verdict (primary endpoint)
```bash
curl http://localhost:3000/api/v1/agent/<hash>/verdict
# Returns: SAFE / RISKY / UNKNOWN with confidence, flags, risk profile
```

### Batch Verdicts
```bash
curl -X POST http://localhost:3000/api/v1/verdicts \
  -H "Content-Type: application/json" \
  -d '{"hashes": ["abc123...", "def456..."]}'
```

### Agent Score
```bash
curl http://localhost:3000/api/v1/agent/<hash>
# Returns: score, components, evidence, delta, alerts
```

### Score History
```bash
curl http://localhost:3000/api/v1/agent/<hash>/history?limit=10
```

### Received Attestations
```bash
curl http://localhost:3000/api/v1/agent/<hash>/attestations?limit=20
```

### Leaderboard
```bash
curl http://localhost:3000/api/v1/agents/top?limit=20&sort_by=score
```

### Top Movers
```bash
curl http://localhost:3000/api/v1/agents/movers
```

### Search by Alias
```bash
curl http://localhost:3000/api/v1/agents/search?alias=atlas
```

### Submit Attestation (free — no L402)
```bash
curl -X POST http://localhost:3000/api/v1/attestations \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-key>" \
  -d '{"txId": "...", "attesterHash": "...", "subjectHash": "...", "score": 85, "category": "successful_transaction"}'
```

### Health & Stats
```bash
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/stats
```

## MCP Server

SatRank exposes an MCP (Model Context Protocol) server for agent-native access via stdio:

```bash
npm run mcp        # Development
npm run mcp:prod   # Production
```

Available tools: `get_agent_score`, `get_top_agents`, `search_agents`, `get_network_stats`, `get_verdict`, `get_batch_verdicts`, `get_top_movers`, `submit_attestation`.

## SDK

```bash
npm install @satrank/sdk
```

```typescript
import { SatRankClient } from '@satrank/sdk';

const client = new SatRankClient('http://localhost:3000');
const verdict = await client.getVerdict('<hash>');
const score = await client.getScore('<hash>');
const batch = await client.getBatchVerdicts(['<hash1>', '<hash2>']);
const movers = await client.getMovers();
```

## Tech Stack

- **TypeScript** strict mode
- **Express** — REST API
- **better-sqlite3** — Embedded database, WAL mode
- **zod** — Input validation
- **pino** — Structured logging
- **helmet** — Security headers
- **express-rate-limit** — Abuse protection

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development with hot reload (tsx watch) |
| `npm run build` | TypeScript compilation |
| `npm start` | Production |
| `npm test` | Tests (vitest) |
| `npm run seed` | Generate mock data |
| `npm run lint` | TypeScript check |
| `npm run mcp` | MCP server (dev) |
| `npm run crawl` | Observer Protocol crawler |

## Roadmap

- [ ] Aperture integration (L402 reverse proxy) — monetize queries in sats
- [x] Observer Protocol crawler — automatic on-chain data ingestion
- [ ] 4tress connector — verified attestations
- [x] Lightning graph crawler — channel topology and capacity via LND node
- [x] TypeScript SDK for agents (`@satrank/sdk`)
- [x] Verdict API — SAFE/RISKY/UNKNOWN binary decision
- [x] MCP server — agent-native access via stdio
- [x] Auto-indexation — unknown pubkeys indexed on demand
- [ ] Real-time scoring with cache invalidation
- [ ] Trust network visualization dashboard

## Vision

SatRank is the score agents check before every transaction. The agentic economy on Lightning needs a neutral, transparent trust oracle — that's what we're building.
