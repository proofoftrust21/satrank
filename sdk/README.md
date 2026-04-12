# @satrank/sdk

Client SDK for the SatRank API. Trust scores for AI agents on Bitcoin Lightning.

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

## Agent Workflow: Screen Then Decide

The recommended two-step pattern for autonomous agents evaluating payment candidates: screen many with batch verdicts, then decide on the best one. 2 sats total, ~2 seconds for 100 candidates.

```typescript
import { SatRankClient, SatRankError } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev', {
  headers: { 'Authorization': 'L402 <macaroon>:<preimage>' },
});

// Step 1: Screen up to 100 candidates (1 sat for the whole batch, ~1.5s)
const candidateHashes: string[] = [/* ...up to 100 SHA-256 hashes */];

const response = await fetch('https://satrank.dev/api/verdicts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'L402 <macaroon>:<preimage>',
  },
  body: JSON.stringify({ hashes: candidateHashes }),
});
const { verdicts } = await response.json();

// Filter to SAFE nodes and sort by score
const safeNodes = verdicts
  .filter((v: { verdict: string }) => v.verdict === 'SAFE')
  .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

// Step 2: Decide on the best candidate (1 sat, ~230ms incl. LND QueryRoutes)
if (safeNodes.length > 0) {
  const best = safeNodes[0];
  const decision = await client.decide({
    target: best.hash,
    caller: '<your-pubkey-hash>',
  });

  if (decision.go) {
    // Pay with confidence — successRate is 0-1, e.g. 0.987
    console.log(`GO: ${best.hash}, rate=${decision.successRate}`);
    await myWallet.pay(best.hash, amountSats);
  }
}

// Concrete numbers:
// - 100 candidates screened in ~1.5s (15ms/target), 1 sat
// - 1 decision in ~230ms, 1 sat
// - Total: 2 sats, ~2 seconds, informed decision
```

## License

AGPL-3.0
