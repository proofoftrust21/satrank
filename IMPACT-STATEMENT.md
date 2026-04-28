# SatRank: Impact Statement

*The Lightning trust oracle for the agentic economy.*

---

## Problem

The agentic economy is emerging on Lightning. Autonomous agents need a trust layer before they pay, and the graph they have to navigate is mostly noise. A majority of the Lightning nodes visible in public gossip never route a payment. Their channels exist in the graph, their capacity looks real, and yet an invoice sent through them never settles. The live phantom share is published at `/api/stats.phantomRate` and stays stubbornly high from one week to the next.

L402 endpoints extend the problem one layer up. There is no catalog, no SLA, no reputation. Every agent discovers the same dead hops, the same broken paywalls, the same stuck invoices, and each one does it alone. A failed payment is not just a wasted sat. It is a wasted decision that the agent has no way to appeal, and no one to escalate to.

## Solution

SatRank is a sovereign, federated trust oracle for Lightning. Not a scraper, not an aggregator. We run the full stack ourselves: a Bitcoin full node (no Neutrino, no third-party gossip), our own LND, our own Nostr identity, our own probe fleet, and our own relay-publishing pipeline. And critically: the architecture is open enough that any other operator can run a SatRank-compatible oracle and federate with us.

The product exposes `POST /api/intent`: it takes a natural-language intent plus a caller identity and returns the top candidates ranked by posterior reliability, with a 5-stage decomposition of the L402 contract per candidate. Settlement happens client-side through the SDK. `sr.fulfill(intent, budget)` calls `/api/intent`, picks a candidate, and runs the L402 payment flow directly against the provider's endpoint. SatRank never custodies sats and never sees the preimage.

Every score is decomposed into a five-stage L402 contract posterior — challenge → invoice validity → payment fulfillment → data delivery → data quality. Each stage carries its own Beta posterior with `p_success`, `ci95`, `n_obs`, and `is_meaningful`. The composite `p_e2e = ∏ p_i` over meaningful stages tells the agent the end-to-end probability; the per-stage breakdown tells it which step is likely to fail. An agent can reason about each step independently and choose fallback strategies accordingly.

On top of the posteriors, SatRank publishes a **weekly signed calibration history** on Nostr (kind 30783) — the rolling delta between predicted and observed success rates. Any agent or peer oracle can verify the oracle's accuracy across time. A competitor announcing a similar oracle in 2027 cannot retroactively produce that history. The provenance is the moat.

The federation primitives ship with the oracle: any operator can run a SatRank-compatible instance (see `docs/OPERATOR_QUICKSTART.md`), publish a kind 30784 announcement, and have agents aggregate the network through the SDK's `aggregateOracles()` primitive. SatRank is one of N+1 instances; agents pick their own trust filters.

Three agent-native protocols in parallel: HTTP REST, MCP server (Claude / ChatGPT / Cursor), and NIP-90 Nostr DVM (sovereign agents who never touch HTTP).

The payment rail is tiered and rate-locking. The five-tier deposit schedule is public at `GET /api/deposit/tiers`. An agent that deposits at the tier 5 floor locks in 0.05 sats per request for the lifetime of that deposit token. The economic supportability of the oracle is publicly verifiable at `GET /api/oracle/budget` — a self-funding loop where paid `/api/intent?fresh=true` revenue covers the paid-probe spending budget at agent-economy scale (~17 fresh queries/day to break even).

## Differentiation

1. SatRank scores the Lightning payment graph, not the Nostr social graph. Every other NIP-85 provider answers "who do your friends trust". SatRank answers "can this node route my payment, right now, at this amount, and will the data come back correctly". The 5-stage contract decomposition is orthogonal to social graph scoring. Bridging into NIP-85 via kinds 30382, 30383, 30384 means a consumer listing both providers in a single kind 10040 receives both assertion families in one REQ.

2. Posterior, not composite. Most scorers output a single magic number between 0 and 100 and hope the consumer trusts it. SatRank outputs a 5-dimensional posterior distribution per endpoint. `p_e2e = 0.81` with `ci95 = [0.66, 0.94]` is a different signal than `p_e2e = 0.81` with `ci95 = [0.40, 0.99]`, and the agent needs to know which step in the contract dominates the uncertainty.

3. Calibration moat. We publish a weekly signed kind 30783 event with the predicted-vs-observed delta on a rolling 7-day window. The provenance compounds week after week — a fast-follower competitor cannot retroactively produce that history. Agents can aggregate multiple SatRank-compatible oracles weighted by their published calibration accuracy.

4. Mechanical neutrality. The scoring function is deterministic, the code is AGPL-3.0, and the pricing is tiered and public. There is no featured listing, no paid placement, no ranking boost.

5. The preimage closes the loop. Any agent can publish a kind 7402 outcome event after paying an L402 endpoint. SatRank ingests with Sybil-resistant weighting (PoW + Nostr identity age + preimage proof). The trust signal grows with the agent network, not just with our own probes.

6. Sovereign + federated infrastructure. Our bitcoind is a full node. Our LND is ours. Our Nostr identity publishes from relays we trust. Other operators can run their own SatRank-compatible oracle (`docs/OPERATOR_QUICKSTART.md`) and cross-attest. If SatRank disappears tomorrow, the last weeks of signed calibration history remain verifiable on relay.damus.io / nos.lol / relay.primal.net — and other federation members continue serving the network.

## Strategic thesis

The bet is simple. If the agentic economy consolidates into custodial hubs (ACINQ, WoS, Strike), SatRank is a curiosity. Agents pay inside closed gardens, the hub knows everyone, and trust is provisioned by KYC. No oracle needed.

If the agentic economy goes sovereign (one LN node per agent, or per agent cohort), trust between unknown nodes becomes the single hardest problem in the stack. Every first-contact payment is a cold start. Every repeat payment is a routing decision. An oracle that publishes a live posterior on every node in the graph, updated every six hours, signed by a key the agent can verify, is not a nice-to-have. It is pre-check infrastructure.

We bet on the sovereign path. That is why the product is built the way it is: deterministic scoring, public pricing, rate-locked tokens, open code, full-node trust root, Nostr-native distribution. Every design choice is an assertion that agents will run their own nodes, and that the trust they need will have to come from somewhere that is not the hub they route through.

## Call to action

- Read the methodology: [satrank.dev/methodology](https://satrank.dev/methodology)
- Install the TypeScript SDK: `npm install @satrank/sdk`
- Install the Python SDK: `pip install satrank`
- Integrate an agent: see `INTEGRATION.md`
- Contact: contact@satrank.dev
- Nostr: `satrank@satrank.dev`

---

**Project:** [satrank.dev](https://satrank.dev) · **NIP-05:** `satrank@satrank.dev` · **Contact:** contact@satrank.dev
**Code:** [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank) · **License:** AGPL-3.0
