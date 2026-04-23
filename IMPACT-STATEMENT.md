# SatRank: Impact Statement

*The Lightning trust oracle for the agentic economy.*

---

## Problem

The agentic economy is emerging on Lightning. Autonomous agents need a trust layer before they pay, and the graph they have to navigate is mostly noise. A majority of the Lightning nodes visible in public gossip never route a payment. Their channels exist in the graph, their capacity looks real, and yet an invoice sent through them never settles. The live phantom share is published at `/api/stats.phantomRate` and stays stubbornly high from one week to the next.

L402 endpoints extend the problem one layer up. There is no catalog, no SLA, no reputation. Every agent discovers the same dead hops, the same broken paywalls, the same stuck invoices, and each one does it alone. A failed payment is not just a wasted sat. It is a wasted decision that the agent has no way to appeal, and no one to escalate to.

## Solution

SatRank is a sovereign trust oracle for Lightning. Not a scraper, not an aggregator. We run the full stack ourselves: a Bitcoin full node (no Neutrino, no third-party gossip), our own LND, our own Nostr identity, our own probe fleet, and our own relay-publishing pipeline.

The product exposes two steps. `POST /api/intent` takes a natural-language intent plus a caller identity and returns the top candidates for that intent, ranked by posterior reliability. `POST /api/fulfill` settles the chosen candidate through the L402 paywall and returns the proof. The two-step shape matches how agents actually think: resolve the intent first, settle second, and only settle against a target you believe in.

Every score is a Bayesian posterior. For each node the API returns `p_success`, `ci95_low`, `ci95_high`, `n_obs`, `time_constant_days`. An agent can reason about uncertainty the same way a human trader reasons about a standard deviation. Every QueryRoutes probe, every preimage-verified report, and every fulfilled intent feeds the same α, β update cycle.

The payment rail is tiered and rate-locking. The five-tier deposit schedule is public at `GET /api/deposit/tiers`. An agent that deposits at the tier 5 floor locks in 0.05 sats per request for the lifetime of that deposit token. A future schedule change cannot retroactively charge the token more. The effective rate, tier id, and discount are surfaced in the phase-1 invoice response so the agent can confirm the price before paying.

## Differentiation

1. SatRank scores the Lightning payment graph, not the Nostr social graph. Every other NIP-85 provider answers "who do your friends trust". SatRank answers "can this node route my payment, right now, at this amount". The two questions are orthogonal. Bridging them into NIP-85 via kinds 30382, 30383, and 30384 means a consumer listing both providers in a single kind 10040 receives both assertion families in one REQ, with no SatRank-specific client code.

2. Posterior, not composite. Most scorers output a single magic number between 0 and 100 and hope the consumer trusts it. SatRank outputs a distribution. `p_success = 0.87` with `ci95 = [0.81, 0.92]` is a different signal than `p_success = 0.87` with `ci95 = [0.40, 0.99]`, and the agent needs to know. Composite outputs collapse that distinction. Posteriors preserve it.

3. Mechanical neutrality. The scoring function is deterministic, the code is AGPL-3.0, and the pricing is tiered and public. There is no featured listing, no paid placement, no ranking boost. The rate an agent pays is engraved on the deposit token at settlement. An operator cannot buy a better score, and SatRank cannot quietly raise the price on a paid-up agent.

4. The preimage closes the loop. The same 32-byte preimage that unlocks an L402 response is the proof that the payment settled. SatRank accepts it as a first-class report input, weighted higher than self-reported success. The feedback signal comes from the payment itself, not from a separate telemetry pipeline. No account, no tracking, no login. If the agent paid and got a response, the network learns.

5. Sovereign infrastructure. Our bitcoind is a full node. Our LND is ours. Our Nostr identity publishes from relays we trust. The SDK is forkable. The OpenAPI spec is public. If SatRank disappears tomorrow, the last 30 days of published scores remain verifiable on relay.damus.io, nos.lol, and relay.primal.net via kind 30382 events signed by our npub.

## Strategic thesis

The bet is simple. If the agentic economy consolidates into custodial hubs (ACINQ, WoS, Strike), SatRank is a curiosity. Agents pay inside closed gardens, the hub knows everyone, and trust is provisioned by KYC. No oracle needed.

If the agentic economy goes sovereign (one LN node per agent, or per agent cohort), trust between unknown nodes becomes the single hardest problem in the stack. Every first-contact payment is a cold start. Every repeat payment is a routing decision. An oracle that publishes a live posterior on every node in the graph, updated every six hours, signed by a key the agent can verify, is not a nice-to-have. It is pre-check infrastructure.

We bet on the sovereign path. That is why the product is built the way it is: deterministic scoring, public pricing, rate-locked tokens, open code, full-node trust root, Nostr-native distribution. Every design choice is an assertion that agents will run their own nodes, and that the trust they need will have to come from somewhere that is not the hub they route through.

## Call to action

- Read the methodology: [satrank.dev/methodology](https://satrank.dev/methodology)
- Install the TypeScript SDK: `npm install @satrank/sdk`
- Install the Python SDK: `pip install satrank`
- Integrate an agent: see `docs/integration.md` and `INTEGRATION.md`
- Contact: contact@satrank.dev
- Nostr: `satrank@satrank.dev`

---

**Project:** [satrank.dev](https://satrank.dev) · **NIP-05:** `satrank@satrank.dev` · **Contact:** contact@satrank.dev
**Code:** [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank) · **License:** AGPL-3.0
