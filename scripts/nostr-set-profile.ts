#!/usr/bin/env npx tsx
// Set the SatRank Nostr profile (kind 0).
//
// nos.lol's strfry requires NIP-13 PoW on kind 0 from new pubkeys (~28 bits
// observed). The previous publish (2026-04-28) ran with 29 leading zero
// bits. We mine the same target inline before signing so all three relays
// (damus.io, nos.lol, primal.net) accept the event.
//
// Single-thread cost on M2: ~80s for 28 bits, ~160s for 29. Acceptable for
// a once-a-week profile bump; nothing in the hot path here.
//
// Usage: NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-set-profile.ts
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
import { mineEvent, leadingZeroBits } from '../src/nostr/pow';
import { mineParallel } from './lib/mineParallel';
import { mineFast } from './lib/mineFast';

const skHex = process.env.NOSTR_PRIVATE_KEY;
if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex> environment variable');
  process.exit(1);
}

const sk = hexToBytes(skHex);
const pubkey = getPublicKey(sk);

const profile = {
  name: 'SatRank',
  display_name: 'SatRank',
  about:
    'Sovereign, federated trust oracle for the Lightning agentic economy.\n\n' +
    'Every L402 endpoint is decomposed into a 5-stage Beta posterior — challenge / invoice / payment / delivery / quality — composed via chain rule into p_e2e with 95% CI per stage. Agents read which step is likely to fail, not just an aggregate score.\n\n' +
    'Open self-listing for L402 operators: POST /api/services/register, NIP-98-signed. First signer claims the URL; PATCH/DELETE on the same path for owner updates and soft-delete. Audit-logged. Free.\n\n' +
    'Weekly signed calibration history (kind 30783) is the moat — predicted vs observed delta on a rolling 7-day window. Per-endpoint kind 30782 transferable assertions (NIP-33). Kind 30784 oracle announcements for federation. Kind 7402 crowd outcomes from any agent (Sybil-resistant: PoW + identity age + preimage proof).\n\n' +
    'Three agent-native protocols: HTTP REST, MCP server (Claude / ChatGPT / Cursor), NIP-90 DVM (kind 5900/6900). Run your own SatRank-compatible oracle and cross-attest.\n\n' +
    'SDKs: `@satrank/sdk` on npm (TypeScript, zero deps), `satrank` on PyPI (Python, single dep: httpx).\n\n' +
    'Backed by our own bitcoind full node + LND. Real probes, real preimages, not gossip.',
  website: 'https://satrank.dev',
  nip05: 'satrank@satrank.dev',
  lud16: 'wavykettle725@walletofsatoshi.com',
  picture: 'https://satrank.dev/logo.png',
  banner: '',
};

const TARGET_BITS = Number(process.env.POW_TARGET_BITS ?? 28);
const MAX_MINE_MS = Number(process.env.POW_MAX_MS ?? 5 * 60_000);

async function publish(): Promise<void> {
  console.log('Publishing SatRank profile (kind 0)...');
  console.log(JSON.stringify(profile, null, 2));
  console.log('');

  const mode = (process.env.POW_MODE ?? 'fast').toLowerCase();
  const workers = Number(process.env.POW_WORKERS ?? 0) || undefined;
  console.log(`Mining NIP-13 PoW (target ${TARGET_BITS} bits, max ${Math.round(MAX_MINE_MS / 1000)}s, mode=${mode})...`);
  const mineStart = Date.now();
  const template = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(profile),
  };
  const mined = mode === 'parallel'
    ? await mineParallel({ template, pubkey, targetBits: TARGET_BITS, maxMs: MAX_MINE_MS, workers })
    : mode === 'noble'
      ? mineEvent(template, pubkey, TARGET_BITS, MAX_MINE_MS)
      : mineFast({ template, pubkey, targetBits: TARGET_BITS, maxMs: MAX_MINE_MS });
  if (!mined) {
    console.error(`PoW timeout after ${Math.round((Date.now() - mineStart) / 1000)}s — relax POW_TARGET_BITS or raise POW_MAX_MS`);
    process.exit(1);
  }
  console.log(`Mined: ${mined.achievedBits} leading zero bits in ${mined.elapsedMs} ms (${mined.attempts.toLocaleString()} attempts)`);

  const event = finalizeEvent(mined.template, sk);
  if (leadingZeroBits(event.id) < TARGET_BITS) {
    console.error(`Sanity check failed: signed event id ${event.id} has fewer than ${TARGET_BITS} leading zero bits`);
    process.exit(1);
  }
  console.log(`Signed event id: ${event.id}`);
  console.log('');

  const relays = DEFAULT_NOSTR_RELAYS;
  for (const url of relays) {
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
}

publish().catch(console.error);
