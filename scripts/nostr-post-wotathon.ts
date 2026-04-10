#!/usr/bin/env npx tsx
// Publish the #wotathon announcement from SatRank's Nostr identity
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-post-wotathon.ts
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
// @ts-expect-error — ESM subpath
import { finalizeEvent } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
useWebSocketImplementation(WS);
import { hexToBytes } from '@noble/hashes/utils';
import { getPublicKey } from 'nostr-tools/pure';
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';

const skHex = process.env.NOSTR_PRIVATE_KEY;
if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex> environment variable');
  process.exit(1);
}

const sk = hexToBytes(skHex);
const pk = getPublicKey(sk);

const content = `SatRank is the first NIP-85 provider bridging the Lightning payment graph into the Web of Trust.

Every other NIP-85 implementation scores the Nostr social graph (follows, mutes, zaps). SatRank scores payment reliability — the thing you actually need before sending a zap.

— Dual publishing —

Stream A (Lightning-indexed, d=ln_pubkey): ~2,400 kind 30382:rank assertions per 6h cycle, covering ~13,900 active Lightning nodes with score ≥ 30. Real probe data from our own bitcoind+LND full node — not gossip. ~60% of the Lightning graph is phantoms; SatRank tells you which nodes are actually alive.

Stream B (strict Nostr-indexed, d=nostr_pubkey): 65 spec-conformant events built by mining NIP-57 zap receipts (kind 9735) across 6 relays, decoding BOLT11 to recover payee pubkeys, and cross-referencing with SatRank's agents table. d-tag is the 32-byte Nostr pubkey as NIP-85 strictly requires. Custodial wallets filtered out via alias blacklist + shared-ln_pk heuristic.

+ 1 self-declaration (kind 10040) listing SatRank as its own trusted provider for 30382:rank on damus, nos.lol, primal.

— Query our trusted assertions —
["REQ", "satrank", {"kinds":[30382], "authors":["${pk}"]}]

— Declare SatRank as your trusted provider (kind 10040) —
["30382:rank", "${pk}", "wss://relay.damus.io"]

Code:  https://github.com/proofoftrust21/satrank
Docs:  https://satrank.dev/methodology#declare-provider

Built for the agentic economy. Submitted to the WoT-a-thon for the NIP-85 Excellence prize.

#wotathon #nostr #lightning #weboftrust #nip85`;

const event = finalizeEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['t', 'wotathon'],
    ['t', 'nostr'],
    ['t', 'lightning'],
    ['t', 'weboftrust'],
    ['t', 'nip85'],
  ],
  content,
}, sk);

const RELAYS = DEFAULT_NOSTR_RELAYS;

async function publish() {
  console.log(`Publishing #wotathon post from ${pk.slice(0, 16)}...`);
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
  console.log('Done. Event ID:', event.id);
}

publish().catch(console.error);
