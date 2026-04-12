# SatRank — Impact Statement

**WoT-a-thon 2026 — NIP-85 Excellence prize submission**
*Route reliability for Lightning payments. The first NIP-85 provider on the payment graph.*

---

## Problem

The Lightning Network has no shared reliability oracle. **~60 % of public-graph Lightning nodes are phantoms** — they advertise channels in gossip but fail to route payments. Wallets retry the same dead hops; agents paying for APIs over L402 burn budgets on retries. Gossip is untrusted by construction. Every wallet rediscovers the same failures alone.

For autonomous agents, every wasted payment is a wasted compute cycle.

## Solution

SatRank is a Lightning trust oracle distributed over Nostr. One question — *"can this node actually route my payment?"* — answered by a neutral party in milliseconds.

- **Trust root:** full **bitcoind v28.1** node + LND for gossip and probing.
- **Probe pipeline:** ~650 k probes / 24 h, every 30 min, recording reachability and latency.
- **Scoring:** composite 0-100 over 5 components (volume, reputation with sovereign PageRank and 5 sub-signals, seniority, regularity, diversity) with anti-gaming (mutual loops, 3-hop / 4-hop cycle BFS, attester min-age).
- **Distribution:** kind `30382:rank` events on 3 canonical relays every 6 h, plus a NIP-90 DVM (kind 5900 → 6900) for sub-100 ms real-time queries.

## Differentiation

1. **Only NIP-85 provider on the Lightning payment graph.** Every other implementation (Brainstorm, Vertex, wot-scoring, nostr-wot-sdk) scores the Nostr social graph. SatRank bridges an orthogonal trust domain into NIP-85 with zero new kinds.
2. **Dual publishing.** Stream A indexes by Lightning pubkey (extension, ~2,400 events / cycle, full graph coverage). Stream B indexes by Nostr pubkey for strict NIP-85 conformance, built from cryptographically-verifiable mappings mined from NIP-57 zap receipts (kind 9735 -> BOLT11 `payee_node_key`) across 9 relays with a 90-day age wall.
3. **Closed feedback loop.** decide → pay → report. Reports are free, weighted by reporter score, with a 2× bonus for preimage-verified payments.

## Key metrics (2026-04-09)

| Metric | Value |
|---|---|
| Active Lightning nodes scored | **13,913** |
| Phantom share (live `/api/stats`) | **~60 %** |
| Probes / 24 h | **~650,000** |
| Lightning-indexed events / cycle | **~2,400** (score ≥ 30) |
| Strict NIP-85 events on relays (Stream B) | **82** (81 zap-mined + 1 self-declaration) |
| Test suite | **504 tests / 38 files**, all green |
| L402 paywall | **validated end-to-end** (1 sat per `/api/decide` call) |

## NIP-85 compliance

- **Kind 30382 (Trusted Assertions)** — dual-indexed (Lightning + Nostr), canonical `rank` tag + 5 component tags. Strict consumers parse without SatRank-specific code.
- **Kind 10040 (Trusted Provider Declaration)** — copy-paste documentation + self-declaration script + live circuit widget on `satrank.dev/methodology`. SatRank's own kind 10040 is published live.
- **Kind 5900 / 6900 (NIP-90 DVM)** — real-time trust-check job handler on the 3 canonical relays, with on-demand probing for unknown nodes.
- **NIP-05** — `satrank@satrank.dev` resolves to the service pubkey via `/.well-known/nostr.json`.
- **Composability with Brainstorm verified live (2026-04-09)** — both providers' `rank` assertions returned in one REQ on `relay.damus.io` and `nos.lol`, with no SatRank-specific client code.

## Business model

Freemium, sustainable on Lightning rails alone:

- **Free:** NIP-85 scores on relays, NIP-90 DVM, `/api/ping`, `/api/agents/top`, `/api/stats`, `/api/health`, reports.
- **1 sat via L402:** `/api/decide` (personalized GO/NO-GO + pathfinding) and `/api/profile`, `/api/agent/:hash/*`, `/api/verdicts`.

Free distribution funds adoption, paid `/api/decide` funds infrastructure, free reports fund accuracy. Margin is positive at any non-zero sustained call rate.

## Why SatRank should win

1. **Only NIP-85 provider bridging the Lightning payment graph into the WoT.** A user listing SatRank + Brainstorm in a single kind 10040 receives both `rank` assertions in one REQ — Lightning reliability + social trust, no extra client code.
2. **Nostr-native from day one** — same keypair, same relay list, same verification path for kind 0, 10040, 30382 (Stream A + B), 5900/6900 and NIP-05.
3. **Production infrastructure, not a demo.** 13,913 nodes scored, ~89 k validated channels, ~9,630 BTC validated capacity, 921 k snapshots retained, 504 tests, Docker hardening (cap-drop-ALL, read-only FS), L402 paid gate. All open-source, all reproducible.

The Lightning Network has been waiting for its reliability oracle. NIP-85 has been waiting for its first real-world protocol bridge. SatRank is both.

---

**Project:** [satrank.dev](https://satrank.dev) · **NIP-05:** `satrank@satrank.dev` · **Contact:** contact@satrank.dev
**Service pubkey:** `5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4`
**Code:** [github.com/proofoftrust21/satrank](https://github.com/proofoftrust21/satrank) · **License:** AGPL-3.0
**Long version:** [`IMPACT-STATEMENT-FULL.md`](IMPACT-STATEMENT-FULL.md)
