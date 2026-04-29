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
  about: 'Sovereign, federated trust oracle for the Lightning agentic economy.\n\nEvery L402 endpoint is decomposed into a 5-stage Beta posterior — challenge / invoice / payment / delivery / quality — composed via chain rule into p_e2e with 95% CI per stage. Agents read which step is likely to fail, not just an aggregate score.\n\nWeekly signed calibration history (kind 30783) is the moat — predicted vs observed delta on a rolling 7-day window. Per-endpoint kind 30782 transferable assertions (NIP-33). Kind 30784 oracle announcements for federation. Kind 7402 crowd outcomes from any agent (Sybil-resistant: PoW + identity age + preimage proof).\n\nThree agent-native protocols: HTTP REST, MCP server (Claude / ChatGPT / Cursor), NIP-90 DVM (kind 5900/6900). Run your own SatRank-compatible oracle and federate — see docs/OPERATOR_QUICKSTART.md.\n\nBacked by our own bitcoind full node + LND. Real probes, real preimages, not gossip.',
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
