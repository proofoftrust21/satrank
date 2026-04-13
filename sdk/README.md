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
| `decide(input)` | `DecideResponse` | GO/NO-GO with probabilities + positional pathfinding + targetFeeStability + maxRoutableAmount |
| `report(input)` | `ReportResponse` | Submit payment outcome (success/failure/timeout) |
| `getBatchVerdicts(hashes)` | `BatchVerdictItem[]` | Screen up to 100 targets in one call |
| `getProfile(id)` | `ProfileResponse` | Full agent profile with evidence |
| `getMovers()` | `MoversResponse` | Top score movers (7-day delta) |
| `bestRoute(input)` | `BestRouteResponse` | Batch pathfinding for up to 50 targets, top 3 by composite rank |
| `transact(target, caller, payFn)` | `TransactResult` | Decide, pay, report in one call |

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

## transact(): Decide, Pay, Report in One Call

The full feedback loop automated. The agent calls `transact()`, the SDK handles decide (pre-flight check), executes your payment callback only if GO, then reports the outcome automatically. Verified reports (with preimage + paymentHash) get 2x weight in future scoring.

```typescript
import { SatRankClient } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev', {
  headers: { 'Authorization': 'L402 <macaroon>:<preimage>' },
});

const result = await client.transact(
  '03864ef025fd...', // target LN pubkey or SHA-256 hash
  '024b550337d6...', // your LN pubkey or hash (the caller)
  async () => {
    // Your payment function. Only called if SatRank says GO.
    // Return { success, preimage?, paymentHash? } for verified reporting.
    const payment = await myLnd.sendPayment(targetInvoice);
    return {
      success: payment.status === 'SUCCEEDED',
      preimage: payment.preimage,         // enables 2x report weight
      paymentHash: payment.paymentHash,   // enables verification
    };
  },
);

if (result.paid) {
  console.log(`Paid successfully, reported to SatRank`);
  console.log(`Report weight: ${result.report?.weight}`);
} else {
  console.log(`SatRank said NO-GO: ${result.decision.reason}`);
  // No payment was attempted, no report was submitted
}
```

The `transact()` response includes everything:
- `result.paid`: whether the payment went through
- `result.decision`: the full DecideResponse (successRate, verdict, pathfinding, risk profile)
- `result.report`: the ReportResponse (only present if payment was attempted)

Cost: 2 sats (1 for decide + 1 for report). Latency: ~500ms + your payment time.

### Cost vs. value

| Volume | Daily oracle cost | Break-even |
|--------|-------------------|------------|
| 100 payments/day | ~300 sats (~$0.03) | 1 avoided failure |
| 1,000 payments/day | ~3,000 sats (~$0.30) | 1 avoided failure |
| 10,000 payments/day | ~30,000 sats (~$3.00) | 1 avoided failure |

A failed Lightning payment costs more than the oracle fee: routing fees are lost, the HTLC timeout locks capital for 30-60 seconds, and the retry adds latency. The oracle pays for itself by avoiding a single bad payment per day.

## Positional Pathfinding

Most agents don't run their own LND node. They pay via wallet providers and don't know their position in the Lightning graph. Pass `walletProvider` to get pathfinding computed from your provider's hub node:

```typescript
const decision = await client.decide({
  target: '<target-hash>',
  caller: '<your-hash>',
  walletProvider: 'phoenix',  // pathfinding from ACINQ's node
});
// decision.pathfinding.sourceNode = "03864ef025fd..."
// decision.pathfinding.hops = 1  (instead of 4-5 from SatRank)
```

Supported providers: `phoenix`, `wos`, `strike`, `blink`, `breez`, `zeus`, `coinos`, `cashapp`.

Alternatively, pass `callerNodePubkey` with any Lightning pubkey to use as the pathfinding source. If both are provided, `callerNodePubkey` takes priority.

## Agent Workflow: Screen, Route, Decide

The recommended three-step pattern for autonomous agents evaluating payment candidates: screen many with batch verdicts, find the best route, then decide on the winner. 3 sats total, ~3 seconds for 100 candidates.

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

// Filter to SAFE nodes
const safeNodes = verdicts
  .filter((v: { verdict: string }) => v.verdict === 'SAFE')
  .map((v: { hash: string }) => v.hash);

// Step 2: Find best route among SAFE candidates (1 sat, ~0.8s)
const routeResult = await client.bestRoute({
  targets: safeNodes,
  caller: '<your-pubkey-hash>',
  amountSats: 50000,
});
const topCandidate = routeResult.candidates[0]; // top by composite rank

// Step 3: Decide on the winner (1 sat, ~0.5s with re-probe if stale)
const decision = await client.decide({
  target: topCandidate.target,
  caller: '<your-pubkey-hash>',
});

if (decision.go) {
  // Pay with confidence
  // targetFeeStability: fee stability of the target node (0 = volatile, 1 = stable, < 0.3 = warning)
  // maxRoutableAmount: highest amount with a known route (compare with your payment)
  console.log(`GO: rate=${decision.successRate}, feeVol=${decision.targetFeeStability}, maxRoute=${decision.maxRoutableAmount}`);
  await myWallet.pay(topCandidate.target, amountSats);
}

// Concrete numbers:
// - 100 candidates screened in ~1.5s (15ms/target), 1 sat
// - Best route found in ~0.8s (parallel QueryRoutes), 1 sat
// - 1 decision in ~0.5s (re-probe if stale), 1 sat
// - Total: 3 sats, ~3 seconds, fully informed decision
```

## License

AGPL-3.0
