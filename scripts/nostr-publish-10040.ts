#!/usr/bin/env npx tsx
// Publish SatRank's self-declaration kind 10040 — NIP-85 Trusted Provider
// list. Declares that SatRank trusts its own service pubkey as the
// provider for `30382:rank` on each of the canonical relays.
//
// Why self-declaration? NIP-85's kind 10040 is published BY users to
// list the providers they trust. A provider publishing one for itself
// is symbolic — it proves the key is alive, demonstrates the exact
// tag shape users should copy, and gives clients an on-chain example
// they can query. The service pubkey is the signer and is also listed
// as the provider in the tags, which is consistent with how single-
// keypair NIP-85 services behave.
//
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-10040.ts
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
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
const pk = getPublicKey(sk);

// One tag per (provider, relay) combo per the NIP-85 example. Same
// provider pubkey across relays — consumers pick whichever relay is
// reachable for them.
const tags: string[][] = DEFAULT_NOSTR_RELAYS.map((relay) => ['30382:rank', pk, relay]);

const event = finalizeEvent(
  {
    kind: 10040,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  },
  sk,
);

async function publish(): Promise<void> {
  console.log(`Publishing SatRank self-declaration (kind 10040) from ${pk.slice(0, 16)}...`);
  console.log(`  event_id: ${event.id}`);
  console.log('  tags:');
  for (const t of tags) console.log(`    ${JSON.stringify(t)}`);
  console.log('');

  let ok = 0;
  let fail = 0;
  for (const url of DEFAULT_NOSTR_RELAYS) {
    try {
      const relay = await Relay.connect(url);
      await relay.publish(event);
      relay.close();
      console.log(`OK   ${url}`);
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL ${url}: ${msg}`);
      fail++;
    }
  }

  console.log('');
  console.log(`result: ${ok} ok, ${fail} fail`);
  console.log(`event_id=${event.id}`);
}

publish().catch(console.error);
