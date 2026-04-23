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
  about: 'SatRank provides route reliability for Lightning payments. Agents declare an intent (endpoint, budget, constraints), get a Bayesian posterior with 95% credible interval, and pay 1 sat via native L402. Tiered deposits (21 to 1M sats) lock a per-request rate into the macaroon.\n\nNIP-85 kind 30382 provider: Lightning payment data meets Web of Trust. Dual publishing (Lightning-indexed + Nostr-indexed).\n\nBacked by a full bitcoind and LND node. Real probes, not gossip.',
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
