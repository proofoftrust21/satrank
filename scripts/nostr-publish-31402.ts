#!/usr/bin/env npx tsx
// Sim 8 follow-up (2026-04-30) — Publish SatRank as Nostr kind 31402
// (forgesworn proposal for L402/x402 service announcements).
//
// Publishing SatRank itself signals presence on the Nostr-native discovery
// surface and lets agents that consume kind 31402 (e.g. forgesworn/402-mcp)
// surface SatRank without going through 402index. Replaceable event keyed
// by d="satrank" — re-publishing replaces the prior announcement.
//
// Usage:
//   NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-31402.ts
//   DRY_RUN=1 NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-31402.ts
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

const KIND_31402 = 31402;
const D_TAG = 'satrank';
const SATRANK_URL = 'https://satrank.dev';

const skHex = process.env.NOSTR_PRIVATE_KEY;
const dryRun = process.env.DRY_RUN === '1';
const publishTimeoutMs = parseInt(process.env.PUBLISH_TIMEOUT_MS ?? '6000', 10);

if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<64-char hex>');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(skHex)) {
  console.error('NOSTR_PRIVATE_KEY must be 64 hex chars');
  process.exit(1);
}
const sk = hexToBytes(skHex);

const tags: string[][] = [
  ['d', D_TAG],
  ['name', 'SatRank'],
  ['about', 'Lightning trust oracle for AI agents — Bayesian rankings, p_e2e signals, advisory escalation, federation primitives, L402-only'],
  ['url', SATRANK_URL],
  ['pmi', 'l402'],
  ['pmi', 'lightning'],
  // Per-capability prices. Format observed in kind 31402 wild events:
  // ['price', name, amount, currency]. SatRank's main monetised endpoints:
  ['price', 'fresh_intent', '2', 'SAT'],
  ['price', 'probe', '5', 'SAT'],
  ['price', 'verdicts_batch', '1', 'SAT'],
  ['price', 'profile', '1', 'SAT'],
  ['price', 'report', '1', 'SAT'],
  // Discovery / topic tags. `t` is the conventional Nostr topic marker.
  ['t', 'l402'],
  ['t', 'lightning'],
  ['t', 'oracle'],
  ['t', 'trust'],
  ['t', 'agents'],
  ['source', 'self'],
  ['status', 'active'],
];

const content = JSON.stringify({
  capabilities: [
    'discovery',
    'verdict',
    'p_e2e_ranking',
    'advisory_escalation',
    'paid_probe',
    'federation_aggregation',
  ],
  protocol: 'L402',
  spec: 'https://github.com/lightninglabs/L402',
  free_endpoints: [
    'GET https://satrank.dev/api/intent',
    'GET https://satrank.dev/api/services',
    'GET https://satrank.dev/api/oracle/peers',
    'GET https://satrank.dev/api/oracle/budget',
    'POST https://satrank.dev/api/services/register (NIP-98 gated)',
  ],
  paid_endpoints: [
    'GET https://satrank.dev/api/intent?fresh=true (2 sats)',
    'POST https://satrank.dev/api/probe (5 sats)',
    'POST https://satrank.dev/api/verdicts (1 sat)',
    'GET https://satrank.dev/api/profile/{id} (1 sat)',
    'POST https://satrank.dev/api/report (1 sat)',
  ],
  version: 1,
});

const created_at = Math.floor(Date.now() / 1000);
const template = {
  kind: KIND_31402,
  created_at,
  tags,
  content,
};

const signed = finalizeEvent(template, sk);
const pubkey = getPublicKey(sk);

console.log('Kind 31402 event built:');
console.log('  pubkey:', pubkey);
console.log('  id:    ', signed.id);
console.log('  d-tag: ', D_TAG);
console.log('  url:   ', SATRANK_URL);
console.log('  pmis:  ', tags.filter(t => t[0] === 'pmi').map(t => t[1]).join(', '));

if (dryRun) {
  console.log('\nDRY_RUN=1 — not publishing. Event JSON:');
  console.log(JSON.stringify(signed, null, 2));
  process.exit(0);
}

(async () => {
  let okCount = 0;
  let failCount = 0;
  for (const url of DEFAULT_NOSTR_RELAYS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relay: any = await Promise.race([
        Relay.connect(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('connect timeout')), publishTimeoutMs),
        ),
      ]);
      try {
        await Promise.race([
          relay.publish(signed),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('publish timeout')), publishTimeoutMs),
          ),
        ]);
        okCount++;
        console.log(`  ✓ ${url}`);
      } finally {
        try { relay.close(); } catch { /* swallow */ }
      }
    } catch (err) {
      failCount++;
      console.log(`  ✗ ${url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nPublished to ${okCount}/${DEFAULT_NOSTR_RELAYS.length} relays (${failCount} failed).`);
  process.exit(okCount > 0 ? 0 : 1);
})();
