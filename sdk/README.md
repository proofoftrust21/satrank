# @satrank/sdk

Client SDK for the SatRank API. Trust scores for AI agents on Bitcoin Lightning.

Zero dependencies. Uses native `fetch()` (Node.js 18+).

## 1.0.0-rc.1 — Bayesian migration (breaking)

Phase 3 replaces the composite 0-100 `score` + five-axis `components` shape
with a Bayesian Beta-Binomial posterior. **There is no cohabitation period.**
Every public endpoint now returns a `bayesian` block alongside its operational
fields; the old `score.total` / `score.components` / `score.confidence` have
been removed entirely from the server, the OpenAPI spec, the NIP-85 event tags
and this SDK.

### Field map

| Before (0.x)                              | After (1.0.0-rc.1)                                |
|-------------------------------------------|---------------------------------------------------|
| `response.score.total` (0-100)            | `response.bayesian.p_success` (0-1)               |
| `response.score.components.*`             | gone — use `response.bayesian.sources` breakdown  |
| `response.score.confidence` (0.1-0.9)     | `response.bayesian.ci95_low` / `ci95_high`        |
| `verdict: 'SAFE' | 'RISKY' | 'UNKNOWN'`   | adds `'INSUFFICIENT'` for cold-start / n_obs < 5  |
| `watchlist.change.score` / `.components`  | `watchlist.change.bayesian` (full block)          |
| NIP-85 tag `rank`                         | tag `p_success` (+ `ci95_low`, `ci95_high`, `n_obs`) |

### Verdict semantics

`verdict` now comes from the posterior directly:

- `SAFE` — `p_success ≥ 0.80` with converged posterior (n_obs ≥ 5 across
  probes, reports, or paid observations).
- `RISKY` — `p_success < 0.50` with converged posterior.
- `INSUFFICIENT` — new in 1.0.0-rc.1. Emitted when `n_obs < 5`; callers should
  treat it like `UNKNOWN` but can surface a different UX (cold-start vs.
  "we've never seen this node").
- `UNKNOWN` — agent not indexed at all.

`SAFE` is the only value that makes `decide.go === true`.

### Migration in ~5 min

```diff
- if (verdict.verdict === 'SAFE' && profile.score.total >= 70) { go(); }
+ if (verdict.verdict === 'SAFE' && verdict.p_success >= 0.80) { go(); }

- const [up, down] = [top.agents.sort((a,b) => b.score - a.score), ...];
+ const [up, down] = [top.agents.sort((a,b) => b.bayesian.p_success - a.bayesian.p_success), ...];
```

`RiskProfile.name` values (`established_hub`, `declining_node`, …) and the
operational fields on `/decide` (`pathfinding`, `survival`, `serviceHealth`,
`riskProfile`, `flags`, `reason`) are unchanged — the migration is a score
replacement, not a taxonomy rewrite.


## Installation

```bash
npm install @satrank/sdk
```

## Agent identity: pubkey, hash, normalization

SatRank identifies agents by `public_key_hash`: a 64-char lowercase hex SHA-256 of the Lightning pubkey **treated as an ASCII string** (not its raw bytes).

```typescript
import { createHash } from 'node:crypto';

// 66-char hex LN pubkey
const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';

// Hash — hash the hex string itself, NOT Buffer.from(pubkey, 'hex')
const hash = createHash('sha256').update(pubkey).digest('hex');
// => 64-char SHA-256 hex, e.g. '2fc0...'
```

Endpoints that accept an agent identifier (`/api/score/:hash`, `/api/profile/:id`, `/api/report`, `/api/decide`'s `target`/`caller`) expect the hash form. The SDK's `transact()`, `decide()`, and `report()` helpers accept either the hex pubkey or the hash — they hash the pubkey client-side using the rule above.

If you compute hashes yourself and see `NOT_FOUND { details: { resource: 'Agent (...)' } }` despite the node being indexed, double-check you hashed the pubkey-as-string and not its raw bytes.

### Response shapes — `publicKeyHash` vs `hash` vs `pubkey`

Some endpoints and their responses use different names for the same concept. This is not the SDK being sloppy — it matches the server API surface:

| Endpoint | Input parameter accepts | Response field |
|---|---|---|
| `/api/agents/top` | — | `publicKeyHash` (64-hex SHA-256) |
| `/api/agents/search` | `q` (alias / partial hash / pubkey) | `publicKeyHash` |
| `/api/agent/:publicKeyHash/verdict` | `:publicKeyHash` accepts **hash OR 66-hex LN pubkey** | verdict payload, no identifier echo |
| `/api/profile/:id` | `:id` accepts **hash OR 66-hex LN pubkey** | `agent.publicKeyHash` and `agent.publicKey` (LN pubkey) side by side |
| `/api/score/:hash` | `:hash` (64-hex only) | `publicKeyHash` |
| `/api/report` | `target`, `reporter` both accept hash OR pubkey | no identifier echo |
| `/api/decide` | `target`, `caller` both accept hash OR pubkey | `publicKeyHash` in score, plus `agent.publicKey` |

**Rule of thumb**: when you read from SatRank, it always gives you `publicKeyHash` (64-hex SHA-256). When you write to SatRank, anywhere that takes an identifier in the path or body will accept **either** the hash **or** the 66-char LN pubkey — the server hashes the pubkey client-side the same way the SDK does. See `normalizeIdentifier()` in `sdk/src/client.ts` for the exact rule.

## Quick Start

```typescript
import { SatRankClient } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev');

// Get an agent's Bayesian trust posterior with full evidence
const score = await client.getScore('a1b2c3...64-char-sha256-hash');
console.log(score.bayesian.p_success);       // 0-1 posterior mean
console.log(score.bayesian.ci95_low, score.bayesian.ci95_high); // 95% credible interval
console.log(score.bayesian.verdict);         // 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT'
console.log(score.evidence.reputation);      // LN+ ratings, centrality ranks

// Leaderboard — sort by the posterior mean
const top = await client.getTopAgents(10);
for (const agent of top.agents) {
  console.log(`${agent.alias}: ${agent.bayesian.p_success.toFixed(3)}`);
}

// Search
const results = await client.searchAgents('ACINQ');
```

## API Reference

### `new SatRankClient(baseUrl, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `30000` | Request timeout in ms (covers `/api/decide` worst case with on-demand re-probe) |
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
| `getVerdict(hash, callerPubkey?)` | `VerdictResponse` | SAFE/RISKY/UNKNOWN verdict with flags and risk profile |
| `submitAttestation(input)` | `CreateAttestationResponse` | Submit a trust attestation (free, requires API key) |
| `transact(target, caller, payFn, options?)` | `TransactResult` | Decide, pay, report in one call (options: walletProvider, amountSats, serviceUrl) |
| `searchServices(params?)` | `{ data, meta }` | Browse L402 services by keyword, category, score, uptime (free) |
| `getCategories()` | `ServiceCategory[]` | List available service categories (free) |
| `deposit(amount)` | `DepositInvoiceResponse` | Request a deposit invoice (21–10,000 sats, free endpoint) |
| `verifyDeposit(paymentHash, preimage)` | `DepositVerifyResponse` | Activate deposit balance after payment |
| `getBalance()` | `number \| null` | Remaining L402 requests from the last response's `X-SatRank-Balance` header |
| `getWatchlist(targets, since?)` | `WatchlistResponse` | One-shot verdict-change poll for up to 50 targets |
| `watchPoll(targets, opts, cb)` | `() => void` | HTTP long-poll wrapper around `getWatchlist` |
| `watchNostr(targets, cb, opts?)` | `() => void` | Subscribe to NIP-85 kind 30382 score updates via 3 relays |

### L402 Authentication

Scored endpoints require L402 payment (1 sat = 1 request). Two options: standard L402 (21 sats = 21 requests, auto-invoice) or `POST /api/deposit` (21–10,000 requests in one invoice). Pass the token in headers:

```typescript
const client = new SatRankClient('https://satrank.dev', {
  headers: {
    'Authorization': 'L402 <macaroon>:<preimage>',
  },
});

// Track remaining balance via X-SatRank-Balance header
console.log(client.getBalance()); // 20, 19, 18... 0
// At 0, the next call throws SatRankError with code BALANCE_EXHAUSTED
// Drop the Authorization header and retry to get a new invoice
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

### Decision Breakdown: probability components

`decide()` returns a **GO/NO-GO** backed by a `successRate` (0–1) and five probability components that each explain a distinct failure mode. `components` are not the 5 composite score factors (volume/reputation/seniority/regularity/diversity) — those live on `getProfile(id).score.components`. Decide components are the five independent sub-probabilities that multiply into `successRate`:

```typescript
const d = await client.decide({ target, caller, walletProvider: 'phoenix' });

// Decision
d.go                                            // true | false
d.successRate                                   // 0–1, ≥ 0.85 → go=true
d.basis                                         // 'empirical' when reports are dense enough, else 'proxy'
d.confidence                                    // 'very_low' | 'low' | 'medium' | 'high' | 'very_high'
d.verdict                                       // 'SAFE' | 'RISKY' | 'UNKNOWN'
d.flags                                         // VerdictFlag[] — human-readable drivers
d.reason                                        // short string, why go / why no-go

// Probability components — each 0–1, combined into successRate
const c = d.components;
c.trustScore                                    // 0–1, normalized composite agent score
c.routable                                      // 0–1, probability a route exists from the caller to the target
c.available                                     // 0–1, recent HTLC acceptance rate from probes
c.empirical                                     // 0–1, reporter-weighted historical success rate (null-like when sparse)
c.pathQuality                                   // 0–1, hop/latency/fee penalty on the live route

// Ancillary signals
d.targetFeeStability                            // 0–1 on the target's own fee snapshots, null when no fee data
d.maxRoutableAmount                             // highest sats with a known route, null when unknown
d.reportedSuccessRate                           // raw empirical rate 0–1, null when sparse
d.lastProbeAgeMs                                // freshness of the underlying probe
d.serviceHealth                                 // { status, httpCode, latencyMs, uptimeRatio, servicePriceSats, ... } | null

// Risk + survival
d.riskProfile                                   // { name: 'low' | 'medium' | 'high', ... }
d.survival                                      // { verdict: 'stable' | 'at_risk' | 'likely_dead', ... }

// Positional pathfinding (walletProvider → hub node)
d.pathfinding?.sourceProvider                   // "phoenix"
d.pathfinding?.sourceNode                       // "03864ef025fde8fb..." (ACINQ pubkey)
d.pathfinding?.hops                             // 2 (from phoenix's hub, not from SatRank)
```

Need the 5-factor breakdown (volume / reputation / seniority / regularity / diversity)? Call `getProfile(id)` or `getScore(hash)`:

```typescript
const p = await client.getProfile(target);
p.score.total                                   // 0–100 composite
p.score.components.volume                       // 0–100, weight 25 %
p.score.components.reputation                   // 0–100, weight 30 %  (5 sub-signals inside: centrality 20, peerTrust 30, routingQuality 20, capacityTrend 15, feeStability 15)
p.score.components.seniority                    // 0–100, weight 15 %
p.score.components.regularity                   // 0–100, weight 15 %
p.score.components.diversity                    // 0–100, weight 15 %
p.survival                                      // same shape as on decide
p.riskProfile                                   // same shape as on decide
p.reports                                       // { total, successes, failures, timeouts, successRate }
p.flags                                         // driver flags
```

### Error Handling

The SDK throws typed subclasses of `SatRankError`. Agents can dispatch on error type instead of inspecting `code` or `message` strings.

```typescript
import {
  SatRankClient,
  SatRankError,          // base class — catches everything
  BalanceExhaustedError, // 402 — token used up, remove Authorization and retry for a new invoice
  PaymentPendingError,   // 402 — deposit invoice not yet settled, retry after paying
  DuplicateReportError,  // 409 — report/attestation already submitted within dedup window (1h)
  RateLimitedError,      // 429 — too many requests from this IP
  TimeoutError,          // 504 / local abort — request exceeded the client timeout
  NetworkError,          // no HTTP response (DNS, connection refused, etc.)
  ServiceUnavailableError, // 503 — feature disabled (e.g. deposit macaroon missing)
} from '@satrank/sdk';

try {
  const result = await client.transact(target, caller, payFn, { walletProvider: 'phoenix' });
} catch (err) {
  if (err instanceof BalanceExhaustedError) {
    // Buy more requests via /api/deposit or remove the Authorization header for a new 21-sat invoice
  } else if (err instanceof DuplicateReportError) {
    // Already reported this target within the last hour — treat as success
  } else if (err instanceof RateLimitedError || err instanceof TimeoutError) {
    // Retryable — back off and retry
    if (err.isRetryable()) await backoff();
  } else if (err instanceof SatRankError) {
    console.log(err.statusCode, err.code, err.message);
  }
}
```

All SatRankError instances have `.isRetryable()` (true for 429/503/504/network/timeout) and `.isClientError()` (true for 4xx input issues).

Default timeout is 30 seconds — enough to cover `/api/decide` worst case with on-demand re-probe across all probe tiers. Override via `new SatRankClient(url, { timeout: 60_000 })`.

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
  { walletProvider: 'phoenix', amountSats: 50000 }, // optional: positional pathfinding
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
- `result.report`: the ReportResponse when the report submission succeeded, `null` when the report failed (auth / rate limit / duplicate), `undefined` when NO-GO so no payment was attempted.

Cost: 1 request from your L402 balance for decide (report is free). Latency: ~500ms + your payment time.

## Reporting: why it matters, when to do it, how

Reports are the **only non-circular signal** in the scoring system. Probe-based measurements predict their own inputs (the regularity component is derived from probe uptime, so "score predicts probe success" is trivially true). Your reports — *"I paid target X, it worked / it failed"* — are the ground truth that keeps the network's trust graph honest.

### Why you personally should care

- **Preimage-verified reports earn 2× weight**, tightening the score of every agent you transact with — so the next time *you* query a target, the score is more accurate because *you* (and people like you) fed it outcomes.
- Reports cost **nothing** (no quota consumed, no on-chain fee, one HTTP round-trip).
- The report endpoint is **free even without an API key** as long as you submit with an L402 token that already queried the target.

### Two ways to report

**Automatic (recommended)** — wrap your payment in `transact()`:

```typescript
const result = await client.transact(target, caller, async () => {
  const p = await myWallet.sendPayment(invoice);
  return { success: p.ok, preimage: p.preimage, paymentHash: p.paymentHash };
});
```

The SDK submits the report for you. If submission fails (auth, rate limit), the payment outcome is preserved in `result.paid` and `result.report` is `null` — you can retry later via the manual path.

**Manual** — any time after querying a target:

```typescript
await client.report({
  target: '<target 64-hex hash>',
  reporter: '<your own pubkey or hash>',
  outcome: 'success',  // or 'failure' | 'timeout'
  preimage: '<your payment preimage in hex>',     // optional — enables 2× weight
  paymentHash: '<sha256(preimage) in hex>',        // required alongside preimage
  memo: 'payment completed in 2.3s',               // optional, free text
});
```

### Auth rules — which token can report on which target?

One of these must be true:

1. **You're using an `X-API-Key`** (partner-tier access) — report on anything.
2. **You're using an L402 token** (`Authorization: L402 <macaroon>:<preimage>` or `L402 deposit:<preimage>`) that has **already queried** the target through *any* paid endpoint: `/api/decide`, `/api/verdicts`, `/api/agent/:hash/verdict`, `/api/profile/:id`, or `/api/best-route`. The token does not need remaining balance to submit a report, only to be non-exhausted.

If the token you hold never hit any of those endpoints for the target you want to report on, the simplest fix is to query the target once (for example `client.getProfile(target)`) and then resubmit the report — the query binds the token to the target for future reports.

### When to report — a simple rule

Report **every paid interaction** the moment it completes:

- `outcome: 'success'` — the payment settled.
- `outcome: 'failure'` — the invoice was rejected, the channel couldn't route, the HTL timed out.
- `outcome: 'timeout'` — you gave up before getting a terminal answer.

Always include `preimage` + `paymentHash` when you have them. The 2× weight is the single biggest lever on report influence.

### Rate limits & dedup

- **Rate limit**: 20 reports/minute per reporter. Soft cap; a busy agent that legitimately transacts this fast should open an issue.
- **Dedup**: one report per `(reporter, target)` per hour. Re-submitting within the window returns `409 Conflict` and does not overwrite the original.

### Reporter badge: how the server weights you

Your reporter weight on each `/api/report` submission is derived server-side from two inputs: your own agent score (fetched via `getProfile(yourHash)`) and a *badge tier* inferred from your recent verified-report count. The badge tier is not yet exposed as a standalone field on `ProfileResponse` — it's folded into the `weight` returned on every `ReportResponse`:

```typescript
const r = await client.report({ target, reporter, outcome: 'success', preimage, paymentHash });
r.verified                          // true when paymentHash + preimage validate
r.weight                            // effective weight the server applied (score × tier × 2× preimage bonus)
```

Tier thresholds (applied server-side):

| Tier | Threshold | Meaning |
|------|-----------|---------|
| `novice` | 0 verified reports in the last 30 days | Base weight |
| `contributor` | ≥ 5 verified reports | Weighted upward |
| `trusted` | ≥ 20 verified reports | Full weight, counts toward sovereign PageRank peer-trust |

To track your own progress: sum `/api/report` responses locally, or call `getProfile(yourHash)` and read `reports.total` / `reports.successRate` — these are reports you *received*, not submitted. A dedicated submitter-stats field may ship in a future `ProfileResponse` revision; the badge effect is already active in scoring.

## Deposit: Buy Bulk Balance

The deposit flow is a two-step process. SatRank generates a Lightning invoice, you pay it with your wallet, then you verify the payment to activate your balance.

```typescript
// Step 1: Request an invoice (free endpoint, no auth needed)
const invoice = await client.deposit(500); // 500 sats = 500 requests
console.log(invoice.invoice);    // "lnbc5u1..." — pay this with your wallet
console.log(invoice.paymentHash); // "a1b2c3..." — you'll need this in step 3

// Step 2: Pay the invoice with your Lightning wallet (out-of-band)
// Use NWC, Phoenix, LND, or any wallet. SatRank never touches your funds.
const preimage = await myWallet.pay(invoice.invoice);

// Step 3: Verify payment and activate balance
const result = await client.verifyDeposit(invoice.paymentHash, preimage);
console.log(result.token);   // "L402 deposit:be7740a4..." — your auth token
console.log(result.balance); // 500

// Step 4: Use the token on all paid endpoints
const authedClient = new SatRankClient('https://satrank.dev', {
  headers: { 'Authorization': result.token },
});
```

### Cost vs. value

| Volume | Daily oracle cost | Break-even |
|--------|-------------------|------------|
| 100 payments/day | ~300 sats | 1 avoided failure |
| 1,000 payments/day | ~3,000 sats | 1 avoided failure |
| 10,000 payments/day | ~30,000 sats | 1 avoided failure |

A failed Lightning payment costs more than the oracle fee: routing fees are lost, the HTLC timeout locks capital for 30-60 seconds, and the retry adds latency. The oracle pays for itself by avoiding a single bad payment per day.

## Positional Pathfinding

Most agents don't run their own LND node. They pay via wallet providers and don't know their position in the Lightning graph. Pass `walletProvider` to get pathfinding computed from your provider's hub node:

```typescript
const decision = await client.decide({
  target: '<target-hash>',
  caller: '<your-hash>',
  walletProvider: 'phoenix',  // pathfinding from ACINQ's node
  serviceUrl: 'https://api.example.com',  // HTTP health check
});
// decision.pathfinding.sourceNode = "03864ef025fd..."
// decision.pathfinding.hops = 1  (instead of 4-5 from SatRank)
// decision.serviceHealth = { status: "healthy", servicePriceSats: 1 }
```

Supported providers: `phoenix`, `wos`, `strike`, `blink`, `breez`, `zeus`, `coinos`, `cashapp`.

Alternatively, pass `callerNodePubkey` with any Lightning pubkey to use as the pathfinding source. If both are provided, `callerNodePubkey` takes priority.

## Agent Workflow: Screen, Route, Decide

The recommended three-step pattern for autonomous agents evaluating payment candidates: screen many with batch verdicts, find the best route, then decide on the winner. 3 requests, under 1 second for 100 candidates.

```typescript
import { SatRankClient, SatRankError } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev', {
  headers: { 'Authorization': 'L402 <macaroon>:<preimage>' },
});

// Step 1: Screen up to 100 candidates (1 request from L402 balance, ~250ms)
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

// Step 2: Find best route among SAFE candidates (1 request, ~100ms)
const routeResult = await client.bestRoute({
  targets: safeNodes,
  caller: '<your-pubkey-hash>',
  amountSats: 50000,
});
const topCandidate = routeResult.candidates[0]; // top by composite rank

// Step 3: Decide on the winner (1 request, ~150ms)
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
// - 100 candidates screened in ~250ms, 1 request
// - Best route found in ~100ms, 1 request
// - 1 decision in ~150ms, 1 request
// - Total: 3 requests from L402 balance, ~500ms
// - Pricing: 1 sat = 1 request (L402: 21 sats/21 reqs, or deposit: up to 10,000)
```

## Monitoring: Watch for Verdict Changes

Two options for monitoring your targets. **Nostr is recommended** (real-time, free, decentralized). HTTP polling is the fallback.

### Option 1: Nostr NIP-85 Subscription (recommended)

SatRank publishes NIP-85 kind 30382 events every 30 minutes (delta-only — unchanged agents are skipped). Subscribe via any Nostr relay to get real-time push notifications when a score changes.

```typescript
import { SatRankClient } from '@satrank/sdk';

const client = new SatRankClient('https://satrank.dev');

// Subscribe to score changes for specific Lightning nodes.
// By default, only events created AFTER subscription are delivered
// (the Nostr filter includes `since: now` to skip historical events).
const unsubscribe = client.watchNostr(
  [
    '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f', // ACINQ
    '026165850492521f4ac8abd9bd8088123446d126f648ca35e60f88177dc149ceb2', // Boltz
  ],
  (event) => {
    console.log(`${event.alias}: score=${event.score} verdict=${event.verdict} reachable=${event.reachable}`);
    // event.components = { volume: 100, reputation: 75, ... }
  },
  { includeHistory: false }, // default
);

// To also receive historical events (useful for backfill):
const unsubAll = client.watchNostr(targets, onEvent, { includeHistory: true });

// Or start from a specific timestamp:
const unsubSince = client.watchNostr(targets, onEvent, { since: 1776000000 });

// Later: stop watching
unsubscribe();
```

Under the hood, the SDK opens WebSocket connections to 3 Nostr relays and sends:
```json
["REQ", "satrank-xxx", {
  "kinds": [30382],
  "authors": ["5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4"],
  "#d": ["03864ef...", "026165..."]
}]
```

Any Nostr client (nak, nostr-tools, nostcat) can do the same without the SDK.

### Option 2: HTTP Polling (fallback)

Poll `GET /api/watchlist` for changes. Free endpoint, no L402 required.

**Staleness guarantees:**
- Max staleness: **60 seconds** after a verdict change (cache TTL).
- Responses within a 5-minute window on the same target set share a cache
  populated by the first poll. `meta.effectiveSince` tells you the `since`
  actually used for the DB query — you may receive changes older than your
  requested `since` (always a superset).
- To advance through time, use `meta.queriedAt` as the `since` for your next
  poll. Dedupe received changes by `changedAt > your_last_seen_ts`.


```typescript
const unsubscribe = client.watchPoll(
  ['hash1...', 'hash2...'], // SHA-256 hashes (max 50)
  { intervalMs: 300_000 },  // poll every 5 minutes
  (changes) => {
    for (const c of changes) {
      console.log(`${c.alias}: ${c.previousScore} → ${c.score} (${c.verdict})`);
    }
  },
);

// Later: stop polling
unsubscribe();
```

Or call `getWatchlist()` directly for one-shot queries:

```typescript
const result = await client.getWatchlist(
  ['hash1...', 'hash2...'],
  Math.floor(Date.now() / 1000) - 3600, // changes in the last hour
);
console.log(`${result.meta.changed} targets changed`);
```

## License

AGPL-3.0
