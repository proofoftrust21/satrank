# SatRank: Impact Statement

**WoT-a-thon 2026, NIP-85 Excellence prize submission**
*The sovereign trust oracle for the agentic economy on Bitcoin Lightning.*

---

## Problem

The Lightning Network has no shared reliability oracle. **61 % of public-graph Lightning nodes are phantoms** — they advertise channels in gossip but fail to route payments. Wallets retry the same dead hops. Agents paying for L402 APIs burn their budgets on retries. Gossip is untrusted by construction. Every wallet rediscovers the same failures alone.

For the autonomous-agent economy now emerging on top of 402-style paywalls, every wasted payment is a wasted compute cycle — and worse, it's a wasted *decision*. An AI agent that picks the wrong counterparty has no upstream authority to appeal to.

## Solution

SatRank is a **sovereign trust oracle** for the Lightning payment graph, distributed over Nostr. One question — *"can this node actually route my payment, and should I trust it?"* — answered by a neutral party in milliseconds, with every answer backed by a full node we run ourselves.

- **Trust root:** our own **bitcoind full node** + LND. Every channel capacity is UTXO-validated. Neutrino and gossip-only setups are explicitly rejected as sources.
- **Probe pipeline:** ~180 700 live `QueryRoutes` probes per 24 h, every 30 minutes, at four amount tiers (1 k / 10 k / 100 k / 1 M sats). Reachability, hops, latency, estimated fees — all persisted and aggregated.
- **Scoring (schema v29):** composite 0–100 over 5 components (volume 25 %, reputation 30 % with 5 sub-signals, seniority 15 %, regularity 15 %, diversity 15 %) with multiplicative modifiers, anti-gaming (mutual-loop detection, 3-hop / 4-hop BFS cycle search, min 7-day seniority, attester score recursion), a survival predictor (`stable` / `at_risk` / `likely_dead`), and a risk profile (`low` / `medium` / `high`).
- **Distribution:** kind `30382:rank` events on the 3 canonical relays every 6 h (~5 000 per cycle, dual-indexed: Lightning + Nostr pubkey), plus a NIP-90 DVM (kind 5900 → 6900) for sub-100 ms real-time queries, plus kind 10040 self-declaration, plus NIP-05 (`satrank@satrank.dev`).

## Differentiation

1. **The only NIP-85 provider on the Lightning payment graph.** Every other implementation (Brainstorm, Vertex, wot-scoring, nostr-wot-sdk) scores the Nostr social graph. SatRank bridges an orthogonal trust domain into NIP-85 with zero new kinds.
2. **Dual publishing.** Stream A indexes by Lightning pubkey (extension, ~5 000 events per cycle, full graph coverage). Stream B indexes by Nostr pubkey for strict NIP-85 conformance, built from cryptographically-verifiable `(nostr_pubkey, ln_pubkey)` mappings mined from NIP-57 zap receipts (kind 9735 → BOLT11 `payee_node_key`) across 9 relays with a 90-day age wall and custodial-wallet filtering.
3. **Closed feedback loop.** decide → pay → report. Reports are authenticated (API-key or the same L402 token that decided on the target — scope enforced through `decide_log`), free, weighted by reporter score and a badge tier (`novice` / `contributor` / `trusted`), with a 2× bonus for preimage-verified payments. The loop is non-circular: reports are the only signal that doesn't predict its own inputs.
4. **Multi-amount probing and batch pathfinding.** Probes tested at 4 tiers (1 k / 10 k / 100 k / 1 M sats) expose `maxRoutableAmount` per node. `POST /api/best-route` runs parallel pathfinding for up to 50 targets in a single call — an agent screens 100 candidates, narrows to the top 3 by composite rank, and decides on the winner in **3 requests, ~500 ms**.
5. **Positional pathfinding.** Agents pass `walletProvider` (phoenix, wos, strike, blink, breez, zeus, coinos, cashapp) and SatRank computes pathfinding *from the provider's hub node* instead of from itself. A Phoenix agent paying Binance jumps from P_path = 0.50 (4-hop fallback) to 0.97 (1-hop via ACINQ). `callerNodePubkey` lets any agent pin an arbitrary LN pubkey as the pathfinding origin.
6. **Sovereign Oracle.** SatRank autonomously crawls 402-style registries (402index, L402Apps), extracts `payee_node_key` from BOLT11, maps endpoints to LN nodes, and health-checks them periodically. `/api/decide` returns `serviceHealth` (HTTP status, uptime, latency, service price in sats) alongside LN routability. **94 paid L402 services** indexed from 402index at the time of writing. An agent gets "can I route the payment?" and "is the service alive?" in a single call.
7. **Deposit rail.** `POST /api/deposit` buys 21–10 000 requests in a single BOLT11 invoice — the rail AI agents actually need, since 21-sat-per-invoice L402 loops don't amortize across the ~3 000 daily queries a serious agent makes. Tokens live in `token_balance`; quota remaining is surfaced in the `X-SatRank-Balance` response header.

## Key metrics (2026-04-16, live)

| Metric | Value | Source |
|---|---|---|
| Active Lightning nodes scored | **13 966** | `/api/stats` `totalAgents` |
| Phantom share | **61 %** (live) | `/api/stats` `phantomRate` |
| Verified reachable | **5 393** | `/api/stats` `verifiedReachable` |
| Total channels (UTXO-validated) | **88 376** | `/api/stats` `totalChannels` |
| Network capacity (validated) | **9 541.2 BTC** | `/api/stats` `networkCapacityBtc` |
| Probes / 24 h | **~180 700** | `/api/stats` `probes24h` |
| Paid L402 services indexed | **94** | `/api/stats` `serviceSources.402index` |
| Lightning-indexed events / cycle | **~5 000** (score ≥ 30) | crawler log |
| Strict NIP-85 events on relays (Stream B) | **105** | publish log (2026-04-10 run) |
| Test suite | **573 tests / 45 files**, all green | `npm test` |
| L402 + deposit paywall | **validated end-to-end** (1 sat = 1 req) | `/api/deposit`, `X-SatRank-Balance` |
| Agent workflow | **3 requests, ~500 ms** (screen 100 + best-route + decide) | |
| Schema version | **v29** | `/api/health` `schemaVersion` |
| Agent SDK | **`@satrank/sdk` 0.2.8** (npm) | — |
| Security hardening | **multiple audits, all critical and high findings remediated** | git log |
| Agent simulations | **8 external simulations, 97 % score** on last run | sim #8 report |

## NIP-85 compliance

- **Kind 30382 (Trusted Assertions):** dual-indexed (Lightning + Nostr), canonical `rank` tag + `verdict`, `reachable`, `survival`, and 5 component tags. Strict consumers parse without SatRank-specific code.
- **Kind 10040 (Trusted Provider Declaration):** copy-paste documentation + self-declaration script + live circuit widget on `satrank.dev/methodology.html`. SatRank's own kind 10040 is live on all 3 relays.
- **Kind 5900 / 6900 (NIP-90 DVM):** real-time trust-check job handler on the 3 canonical relays, with on-demand probing for unknown nodes.
- **NIP-05:** `satrank@satrank.dev` resolves to the service pubkey via `/.well-known/nostr.json`.
- **Composability with Brainstorm verified live (2026-04-09):** both providers' `rank` assertions returned in one `REQ` on `relay.damus.io` and `nos.lol`, with no SatRank-specific client code.

## Business model

Freemium, sustainable on Lightning rails alone:

- **Free:** NIP-85 scores on relays, NIP-90 DVM, `/api/ping`, `/api/agents/top`, `/api/stats`, `/api/health`, `/api/report` (authenticated, no quota).
- **1 sat = 1 request:** `/api/decide`, `/api/verdicts`, `/api/best-route`, `/api/profile`, `/api/agent/:hash/*`. Standard L402 (21 sats = 21 requests, auto-invoice) or `POST /api/deposit` (21–10 000 requests in a single invoice). Token balance tracked via `X-SatRank-Balance` header.
- **Reporter-bonus loop** (economic incentive, shipped behind `REPORT_BONUS_ENABLED=false`) credits verified reporters 1 sat of request balance per preimage-verified report. Activation gated on `/api/stats/reports.window.totalSubmitted < 100` at day 30.

Free distribution funds adoption, paid `/api/decide` funds infrastructure, authenticated free reports fund accuracy. Margin is positive at any non-zero sustained call rate.

## Why SatRank should win

1. **The only NIP-85 provider bridging the Lightning payment graph into the WoT.** A user listing SatRank + Brainstorm in a single kind 10040 receives both `rank` assertions in one `REQ`: Lightning reliability + social trust, no extra client code.
2. **Nostr-native from day one** — same keypair, same relay list, same verification path for kind 0, 10040, 30382 (Stream A + B), 5900 / 6900 and NIP-05.
3. **Production infrastructure, not a demo.** 13 966 nodes scored, 88 376 UTXO-validated channels, 9 541.2 BTC validated capacity, 573 tests, hardened container runtime, L402 + deposit paid gate, multiple full security audits with all critical and high findings remediated. All open-source, all reproducible.
4. **Built for agents, not humans.** An agent SDK (`@satrank/sdk`), an MCP server (12 tools, listed on glama.ai), an OpenAPI spec, a deposit rail that amortizes quota, a positional pathfinding API, a three-step workflow that evaluates 100 candidates in half a second, and 8 external agent simulations averaging 97 % on the last run. The agentic economy doesn't need another social-graph scorer — it needs a sovereign, paid, low-latency route-quality oracle. That's what SatRank ships.

---

**Project:** [satrank.dev](https://satrank.dev) · **NIP-05:** `satrank@satrank.dev` · **Contact:** contact@satrank.dev
**Service pubkey:** `5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4`
**Code:** [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank) · **License:** AGPL-3.0
