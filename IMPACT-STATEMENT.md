# SatRank: Impact Statement

**WoT-a-thon 2026, NIP-85 Excellence prize submission**
*Route reliability for Lightning payments. A NIP-85 provider on the payment graph.*

---

## Problem

The Lightning Network has no shared reliability oracle. **61 % of public-graph Lightning nodes are phantoms.** They advertise channels in gossip but fail to route payments. Wallets retry the same dead hops; agents paying for APIs over L402 burn budgets on retries. Gossip is untrusted by construction. Every wallet rediscovers the same failures alone.

For autonomous agents, every wasted payment is a wasted compute cycle.

## Solution

SatRank is a Lightning trust oracle distributed over Nostr. One question (*"can this node actually route my payment?"*) answered by a neutral party in milliseconds.

- **Trust root:** full **bitcoind v28.1** node + LND for gossip and probing.
- **Probe pipeline:** ~650 k probes / 24 h, every 30 min, recording reachability and latency.
- **Scoring:** composite 0-100 over 5 components (volume, reputation with sovereign PageRank and 5 sub-signals, seniority, regularity, diversity) with anti-gaming (mutual loops, 3-hop / 4-hop cycle BFS, attester min-age).
- **Distribution:** kind `30382:rank` events on 3 canonical relays every 6 h, plus a NIP-90 DVM (kind 5900 → 6900) for sub-100 ms real-time queries.

## Differentiation

1. **A NIP-85 provider on the Lightning payment graph.** Every other implementation (Brainstorm, Vertex, wot-scoring, nostr-wot-sdk) scores the Nostr social graph. SatRank bridges an orthogonal trust domain into NIP-85 with zero new kinds.
2. **Dual publishing.** Stream A indexes by Lightning pubkey (extension, ~5,000 events / cycle, full graph coverage). Stream B indexes by Nostr pubkey for strict NIP-85 conformance, built from cryptographically-verifiable mappings mined from NIP-57 zap receipts (kind 9735 -> BOLT11 `payee_node_key`) across 9 relays with a 90-day age wall.
3. **Closed feedback loop.** decide -> pay -> report. Reports are free, weighted by reporter score, with a 2x bonus for preimage-verified payments.
4. **Multi-amount probing and batch pathfinding.** The probe crawler tests at 4 tiers (1k/10k/100k/1M sats) for hot nodes, exposing `maxRoutableAmount` per node. `POST /api/best-route` runs parallel pathfinding for up to 50 targets in a single call, letting agents find the optimal route in ~100 ms.
5. **Positional pathfinding.** Agents pass `walletProvider` (phoenix, wos, strike, blink, breez, zeus, coinos, cashapp) and SatRank computes pathfinding from the provider's hub node instead of its own. A Phoenix agent gets 1.7-hop routes (P_path=0.97) instead of 4.4-hop fallbacks (P_path=0.50).
6. **Sovereign Oracle.** SatRank autonomously crawls L402 registries (402index, L402Apps), extracts `payee_node_key` from BOLT11 invoices, maps endpoints to LN nodes, and health-checks them periodically. The `/api/decide` response includes `serviceHealth` (HTTP status, uptime, latency, service price) alongside LN routability. Agents get both "can I route the payment?" and "is the service alive?" in a single call.

## Key metrics (2026-04-09)

| Metric | Value |
|---|---|
| Active Lightning nodes scored | **~13,900** |
| Phantom share (live `/api/stats`) | **61 %** |
| Probes / 24 h | **~650,000** |
| Lightning-indexed events / cycle | **~5,000** (score ≥ 30) |
| Strict NIP-85 events on relays (Stream B) | **105** |
| Test suite | **544 tests / 43 files**, all green |
| L402 paywall | **validated end-to-end** (21 sats = 21 requests, 1 sat/req effective) |
| Agent workflow | **3 requests, ~500 ms** (screen 100 + best-route + decide) |
| Schema version | **v24** |

## NIP-85 compliance

- **Kind 30382 (Trusted Assertions):** dual-indexed (Lightning + Nostr), canonical `rank` tag + 5 component tags. Strict consumers parse without SatRank-specific code.
- **Kind 10040 (Trusted Provider Declaration):** copy-paste documentation + self-declaration script + live circuit widget on `satrank.dev/methodology`. SatRank's own kind 10040 is published live.
- **Kind 5900 / 6900 (NIP-90 DVM):** real-time trust-check job handler on the 3 canonical relays, with on-demand probing for unknown nodes.
- **NIP-05:** `satrank@satrank.dev` resolves to the service pubkey via `/.well-known/nostr.json`.
- **Composability with Brainstorm verified live (2026-04-09):** both providers' `rank` assertions returned in one REQ on `relay.damus.io` and `nos.lol`, with no SatRank-specific client code.

## Business model

Freemium, sustainable on Lightning rails alone:

- **Free:** NIP-85 scores on relays, NIP-90 DVM, `/api/ping`, `/api/agents/top`, `/api/stats`, `/api/health`, reports.
- **21 sats = 21 requests via L402:** `/api/decide`, `/api/verdicts`, `/api/best-route`, `/api/profile`, `/api/agent/:hash/*`. Token balance tracked via `X-SatRank-Balance` header. 1 sat/request effective.

Free distribution funds adoption, paid `/api/decide` funds infrastructure, free reports fund accuracy. Margin is positive at any non-zero sustained call rate.

## Why SatRank should win

1. **Only NIP-85 provider bridging the Lightning payment graph into the WoT.** A user listing SatRank + Brainstorm in a single kind 10040 receives both `rank` assertions in one REQ: Lightning reliability + social trust, no extra client code.
2. **Nostr-native from day one,** same keypair, same relay list, same verification path for kind 0, 10040, 30382 (Stream A + B), 5900/6900 and NIP-05.
3. **Production infrastructure, not a demo.** ~13,900 nodes scored, ~89 k validated channels, ~9,630 BTC validated capacity, 921 k snapshots retained, 544 tests, Docker hardening (cap-drop-ALL, read-only FS), L402 paid gate. All open-source, all reproducible.

---

**Project:** [satrank.dev](https://satrank.dev) · **NIP-05:** `satrank@satrank.dev` · **Contact:** contact@satrank.dev
**Service pubkey:** `5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4`
**Code:** [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank) · **License:** AGPL-3.0
**Long version:** [`IMPACT-STATEMENT-FULL.md`](IMPACT-STATEMENT-FULL.md)
