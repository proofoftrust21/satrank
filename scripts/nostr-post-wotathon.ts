#!/usr/bin/env npx tsx
// Publish the #wotathon announcement from SatRank's Nostr identity
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-post-wotathon.ts
// @ts-expect-error — ESM subpath
import { finalizeEvent } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';
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

Publishing kind 30382:rank every 6h for ~13,900 active Lightning nodes (~2,400 per cycle, score ≥ 30), based on real probe data from our own bitcoind+LND full node — not gossip. ~60% of the Lightning graph is phantoms; SatRank tells you which nodes are actually alive.

— Query our trusted assertions:
["REQ", "satrank", {"kinds":[30382], "authors":["${pk}"]}]

— Declare SatRank as your trusted provider (kind 10040):
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
