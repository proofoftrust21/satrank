#!/usr/bin/env npx tsx
// Set the SatRank Nostr profile (kind 0)
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-set-profile.ts
// @ts-expect-error — ESM subpath
import { finalizeEvent } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';
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
  about: 'Route reliability for Lightning payments. Trust scores for ~13,900 active Lightning nodes, backed by a full bitcoind+LND node. NIP-85 kind 30382:rank provider — the only one bridging Lightning payment data into the WoT ecosystem. Built for the agentic economy.\n\n~60% of the Lightning graph is phantoms. We tell you which nodes are actually alive.',
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
