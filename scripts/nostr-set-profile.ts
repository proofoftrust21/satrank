#!/usr/bin/env npx tsx
// Set the SatRank Nostr profile (kind 0)
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-set-profile.ts
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
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';

const skHex = process.env.NOSTR_PRIVATE_KEY;
if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex> environment variable');
  process.exit(1);
}

const sk = hexToBytes(skHex);

const profile = {
  name: 'SatRank',
  display_name: 'SatRank',
  about: 'Route reliability for Lightning payments. NIP-85 kind 30382:rank provider — the only one bridging Lightning payment data into the Web of Trust.\n\nDual publishing: ~2,400 Lightning-indexed events per 6h cycle (d=ln_pubkey, ~13,900 nodes scored) + strict Nostr-indexed events (d=nostr_pubkey) built by mining NIP-57 zap receipts across 6 relays.\n\nBacked by a full bitcoind+LND node — not gossip. ~60% of the Lightning graph is phantoms; SatRank tells you which nodes are actually alive. Built for the agentic economy.',
  website: 'https://satrank.dev',
  nip05: 'satrank@satrank.dev',
  lud16: 'wavykettle725@walletofsatoshi.com',
  picture: 'https://satrank.dev/logo.png',
  banner: '',
};

const event = finalizeEvent({
  kind: 0,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: JSON.stringify(profile),
}, sk);

const RELAYS = DEFAULT_NOSTR_RELAYS;

async function publish() {
  console.log('Publishing SatRank profile (kind 0)...');
  console.log(JSON.stringify(profile, null, 2));
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
  console.log('Profile event ID:', event.id);
}

publish().catch(console.error);
