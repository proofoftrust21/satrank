#!/usr/bin/env npx tsx
// Publishes ONE strict NIP-85 kind 30382 event for SatRank's own Lightning
// node, indexed by SatRank's Nostr service pubkey (d-tag = 32-byte Nostr
// pubkey as the spec requires).
//
// This is the simplest path to strict NIP-85 conformance: we always know
// the mapping between our own Nostr identity and our own Lightning node,
// so we can publish a strictly-compliant assertion with zero external
// data. It's the "proof that we can do it" event.
//
// Usage:
//   NOSTR_PRIVATE_KEY=<hex>  npx tsx scripts/nostr-publish-self-declaration.ts
//     → builds the event, signs it, publishes to the 3 canonical relays
//
//   DRY_RUN=1 NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-self-declaration.ts
//     → builds + signs + prints the event but does NOT publish
//
// The event is separate from the standard d=<lightning_pubkey> stream
// the publisher cron emits every 6 h. We publish this once manually (or
// on a cron, if later integrated into the crawler) because SatRank's own
// node score changes slowly.
import { webcrypto } from 'node:crypto';
// Node 18 lacks a global `crypto.getRandomValues`; @noble/curves (via
// nostr-tools) requires it for schnorr signing. Polyfill before any
// nostr-tools import.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';
import { existsSync } from 'node:fs';
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';
import { VERDICT_SAFE_THRESHOLD } from '../src/config/scoring';

const skHex = process.env.NOSTR_PRIVATE_KEY;
const dbPath = process.env.DB_PATH ?? './data/satrank.db';
const dryRun = process.env.DRY_RUN === '1';

if (!skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<64-char hex>');
  process.exit(1);
}

const SATRANK_LN_PUBKEY = '024b550337d6c46e94fed5fa31f1f5ee165b0a11c8d3a30160ee8816bc81d9f5af';

// Score data comes from one of two sources, in priority order:
//  1. The SQLite database at `$DB_PATH` (if the file exists). This is the
//     authoritative path when running from the prod api container (which
//     has the volume bind-mounted at /app/data/satrank.db) or from any
//     host with a synced copy.
//  2. Environment variables SCORE + SCORE_COMPONENTS_JSON. Used when a
//     DB is not accessible (e.g. running the script locally against a
//     fresh checkout). Lets the operator feed score data explicitly.
interface SelfScore {
  alias: string;
  score: number;
  components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
  source: 'db' | 'env';
}

function loadFromDb(): SelfScore | null {
  if (!existsSync(dbPath)) return null;
  // Dynamic require — better-sqlite3 is a native module and the import
  // fails loudly if the DB file is missing. Lazy-loading keeps the env
  // fallback clean.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const agent = db
      .prepare('SELECT public_key_hash, public_key, alias, avg_score FROM agents WHERE public_key = ?')
      .get(SATRANK_LN_PUBKEY) as
      | { public_key_hash: string; public_key: string; alias: string | null; avg_score: number }
      | undefined;
    if (!agent) return null;
    const snap = db
      .prepare('SELECT components FROM score_snapshots WHERE agent_hash = ? ORDER BY computed_at DESC LIMIT 1')
      .get(agent.public_key_hash) as { components: string } | undefined;
    let components = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };
    if (snap) {
      try { components = JSON.parse(snap.components); } catch { /* keep defaults */ }
    }
    return {
      alias: agent.alias ?? 'SatRank',
      score: Math.round(agent.avg_score),
      components,
      source: 'db',
    };
  } finally {
    db.close();
  }
}

function loadFromEnv(): SelfScore | null {
  const scoreStr = process.env.SCORE;
  const componentsStr = process.env.SCORE_COMPONENTS_JSON;
  if (!scoreStr || !componentsStr) return null;
  try {
    const components = JSON.parse(componentsStr);
    return {
      alias: process.env.SCORE_ALIAS ?? 'SatRank',
      score: Math.round(Number(scoreStr)),
      components,
      source: 'env',
    };
  } catch {
    return null;
  }
}

const self = loadFromDb() ?? loadFromEnv();
if (!self) {
  console.error(
    'No score data available.\n' +
      '  Either point DB_PATH at a SatRank sqlite file that has the SatRank node scored,\n' +
      '  or set SCORE and SCORE_COMPONENTS_JSON env vars, e.g.:\n' +
      '    SCORE=22 SCORE_COMPONENTS_JSON=\'{"volume":18,"reputation":5,"seniority":1,"regularity":90,"diversity":18}\' \\\n' +
      '      NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-self-declaration.ts',
  );
  process.exit(1);
}
const { alias, components } = self;
const score = self.score;
console.log(`  score data loaded from: ${self.source}`);
const verdict =
  score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : score >= 30 ? 'UNKNOWN' : 'RISKY';

const sk = hexToBytes(skHex);
const satrankNostrPubkey = getPublicKey(sk);

// Strict NIP-85 kind 30382 event.
// Notable differences from the standard stream:
// - `d` = Nostr pubkey (32-byte hex, the strict-spec subject key)
// - `ln_pubkey` extra tag explicitly carries the Lightning node pubkey
//   so clients that want to reach the underlying node can do so
// - `subject_type` = "self_declaration" so consumers can tell these
//   apart from mined mappings
const template = {
  kind: 30382,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['d', satrankNostrPubkey],
    ['rank', String(score)],
    ['ln_pubkey', SATRANK_LN_PUBKEY],
    ['subject_type', 'self_declaration'],
    ['alias', alias],
    ['score', String(score)],
    ['verdict', verdict],
    ['volume', String(components.volume)],
    ['reputation', String(components.reputation)],
    ['seniority', String(components.seniority)],
    ['regularity', String(components.regularity)],
    ['diversity', String(components.diversity)],
  ],
  content: '',
};

const signed = finalizeEvent(template, sk);

console.log('=== Strict NIP-85 self-declaration event ===');
console.log(JSON.stringify(signed, null, 2));
console.log('');
console.log(`  Nostr pubkey (d tag):      ${satrankNostrPubkey}`);
console.log(`  Lightning pubkey:          ${SATRANK_LN_PUBKEY}`);
console.log(`  Score:                     ${score}`);
console.log(`  Verdict:                   ${verdict}`);
console.log(`  Components:                ${JSON.stringify(components)}`);
console.log('');

if (dryRun) {
  console.log('DRY_RUN=1 set — not publishing');
  process.exit(0);
}

async function publish(): Promise<void> {
  const relays = DEFAULT_NOSTR_RELAYS;
  let ok = 0;
  let fail = 0;
  for (const url of relays) {
    try {
      const relay = await Relay.connect(url);
      await relay.publish(signed);
      relay.close();
      console.log(`  [OK]   ${url}`);
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${url}: ${msg}`);
      fail++;
    }
  }
  console.log('');
  console.log(`Result: ${ok}/${relays.length} relays accepted the event`);
  console.log(`Event id: ${signed.id}`);
}

publish().catch((err) => {
  console.error(err);
  process.exit(1);
});
