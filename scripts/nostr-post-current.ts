#!/usr/bin/env npx tsx
// Publish the current-state SatRank pitch as a kind 1 note.
//
// The previous kind 1 in the feed (event 7f8710313d06…, 2026-04-10) frames
// SatRank as "first NIP-85 provider bridging the Lightning payment graph
// into the Web of Trust". That's the WoT-a-thon era pitch — accurate then,
// narrow now. This script publishes a fresh kind 1 that reflects the live
// state: 5-stage L402 posterior, federation, MCP+DVM, NIP-98 self-register,
// SDKs. njump.me and similar viewers lead with the most recent kind 1, so
// publishing this once moves the WoT-a-thon framing off the front of the
// public profile.
//
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-post-current.ts
//
// nos.lol historically accepts kind 1 from this pubkey without PoW (the
// 2026-04-10 event has no leading zero bits). Skip mining unless a relay
// rejects the publish.
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
useWebSocketImplementation(WS);
import { hexToBytes } from '@noble/hashes/utils';
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';

const skHex = process.env.NOSTR_PRIVATE_KEY;
if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex> environment variable');
  process.exit(1);
}

const sk = hexToBytes(skHex);
const pk = getPublicKey(sk);

const content = `SatRank — sovereign trust oracle for the Lightning agentic economy.

We measure every L402 endpoint, decompose the contract into 5 Beta stages (challenge / invoice / payment / delivery / quality), and ship the per-stage posterior + a chain-rule p_e2e with 95% CI on every /api/intent response. Agents see which step is likely to fail, not just an aggregate score.

Weekly signed calibration history on Nostr (kind 30783) — predicted vs observed delta on a rolling 7-day window. The moat. Per-endpoint kind 30782 transferable assertions (NIP-33). Kind 30784 oracle announcements for federation. Kind 7402 crowd outcomes from any agent (Sybil-resistant: PoW + identity age + preimage proof).

Three agent-native surfaces:
- HTTP REST + OpenAPI 3.1
- MCP server (Claude / ChatGPT / Cursor) — tools include intent + verify_assertion
- NIP-90 DVM (kind 5900 → 6900) — j: trust-check, j: intent-resolve

L402 operators: list your endpoint NIP-98-signed at POST /api/services/register. First signer claims the URL; PATCH/DELETE on the same path for owner updates and soft-delete. Audit-logged. Free.

SDKs:
- npm install @satrank/sdk (TypeScript, zero deps, LND/NWC/LNURL wallets)
- pip install satrank (Python, single dep: httpx)

Backed by our own bitcoind full node + LND. Real probes, real preimages, not gossip. Federation is live: any operator can run a SatRank-compatible oracle, cross-attest calibration, and have agents aggregate via Bayesian model averaging.

https://satrank.dev — code: https://github.com/proofoftrust21/satrank — docs: https://satrank.dev/api/docs — AGPL-3.0

#bitcoin #lightning #l402 #nostr #ai #agents`;

const event = finalizeEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['t', 'bitcoin'],
    ['t', 'lightning'],
    ['t', 'l402'],
    ['t', 'nostr'],
    ['t', 'ai'],
    ['t', 'agents'],
  ],
  content,
}, sk);

const RELAYS = DEFAULT_NOSTR_RELAYS;

async function publish(): Promise<void> {
  console.log(`Publishing current-state pitch (kind 1) from ${pk.slice(0, 16)}…`);
  console.log('');
  console.log(content);
  console.log('');

  for (const url of RELAYS) {
    try {
      const relay = await Relay.connect(url);
      await relay.publish(event);
      relay.close();
      console.log(`Published to ${url}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Failed on ${url}: ${msg}`);
    }
  }

  console.log('');
  console.log('Event id:', event.id);
}

publish().catch(console.error);
