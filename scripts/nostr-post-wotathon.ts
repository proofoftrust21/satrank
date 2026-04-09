#!/usr/bin/env npx tsx
// Publish the #wotathon announcement from SatRank's Nostr identity
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-post-wotathon.ts
// @ts-expect-error — ESM subpath
import { finalizeEvent } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';
import { getPublicKey } from 'nostr-tools/pure';

const skHex = process.env.NOSTR_PRIVATE_KEY;
if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex> environment variable');
  process.exit(1);
}

const sk = hexToBytes(skHex);
const pk = getPublicKey(sk);

const content = `SatRank now publishes trust scores for 13,900 Lightning Network nodes as NIP-85 Trusted Assertions (kind 30382).

Each node gets a composite score (0-100), verdict (SAFE/RISKY/UNKNOWN), reachability status, and five scoring components — based on real probe data from our Lightning node, not social signals.

60% of Lightning nodes are phantoms. SatRank tells you which ones are alive.

Query our assertions: kind 30382, author: ${pk}

https://satrank.dev

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

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

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
