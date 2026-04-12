# @satrank/sdk

Client SDK for the SatRank API — trust scores for AI agents on Bitcoin Lightning.

Zero dependencies. Uses native `fetch()` (Node.js 18+).

## Installation

```bash
npm install @satrank/sdk
```

## Quick Start

```typescript
import { SatRankClient } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev');

// Get an agent's trust score with full evidence
const score = await client.getScore('a1b2c3...64-char-sha256-hash');
console.log(score.score.total);        // 0-100
console.log(score.score.confidence);   // 'very_low' | 'low' | 'medium' | 'high' | 'very_high'
console.log(score.evidence.reputation); // LN+ ratings, centrality ranks

// Leaderboard
const top = await client.getTopAgents(10);
for (const agent of top.agents) {
  console.log(`${agent.alias}: ${agent.score}`);
}

// Search
const results = await client.searchAgents('ACINQ');
```

## API Reference

### `new SatRankClient(baseUrl, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `10000` | Request timeout in ms |
| `headers` | `Record<string, string>` | `{}` | Custom headers (e.g. L402 token) |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getScore(hash)` | `AgentScoreResponse` | Detailed score with evidence |
| `getTopAgents(limit?, offset?)` | `TopAgentsResponse` | Leaderboard |
| `searchAgents(alias, limit?, offset?)` | `SearchAgentsResponse` | Search by alias |
| `getHistory(hash, limit?, offset?)` | `HistoryResponse` | Score history |
| `getAttestations(hash, limit?, offset?)` | `AttestationsResponse` | Received attestations |
| `getStats()` | `NetworkStats` | Global network statistics |
| `getHealth()` | `HealthResponse` | Service health |
| `getVersion()` | `VersionResponse` | Build info |

### L402 Authentication

Scored endpoints require L402 payment. Pass the token in headers:

```typescript
const client = new SatRankClient('https://satrank.dev', {
  headers: {
    'Authorization': 'L402 <macaroon>:<preimage>',
  },
});
```

### Evidence

The `getScore` response includes verifiable evidence:

```typescript
const { evidence } = await client.getScore(hash);

// Transaction sample (5 most recent)
evidence.transactions.sample.forEach(tx => {
  console.log(tx.txId, tx.protocol, tx.verified);
});

// Lightning Network graph data (null for non-LN agents)
if (evidence.lightningGraph) {
  console.log(evidence.lightningGraph.sourceUrl); // mempool.space link
}

// LN+ reputation (null if no ratings)
if (evidence.reputation) {
  console.log(evidence.reputation.positiveRatings);
  console.log(evidence.reputation.hubnessRank);
  console.log(evidence.reputation.sourceUrl); // lightningnetwork.plus link
}

```

### Error Handling

```typescript
import { SatRankClient, SatRankError } from '@satrank/sdk';

try {
  const score = await client.getScore(hash);
} catch (err) {
  if (err instanceof SatRankError) {
    console.log(err.statusCode); // 402, 404, etc.
    console.log(err.code);       // 'PAYMENT_REQUIRED', 'NOT_FOUND', etc.
  }
}
```

## License

AGPL-3.0
