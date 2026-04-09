#!/usr/bin/env npx tsx
// Publishes strict NIP-85 kind 30382 events indexed by Nostr pubkey
// (d-tag = 32-byte Nostr pubkey as the spec requires), built from the
// mining output of `scripts/nostr-mine-zap-mappings.ts`.
//
// For each mined (nostr_pubkey, ln_pubkey) mapping:
//   1. Look up the ln_pubkey in SatRank's agents table
//   2. Skip if not indexed, stale, or score below threshold
//   3. Fetch the latest score snapshot for the components
//   4. Build a kind 30382 event:
//        d = nostr_pubkey  (strict NIP-85 subject)
//        rank, score, verdict, 5 components (same as the lightning-indexed stream)
//        ln_pubkey, subject_type="mined_mapping", zap_count  (extension tags
//                                                             for traceability)
//   5. Sign with SatRank's private key
//   6. Publish to all 3 canonical relays in parallel, or DRY_RUN and print.
//
// Usage:
//   # dry-run (no publish, just print the N events + yield stats)
//   DRY_RUN=1 npx tsx scripts/nostr-publish-nostr-indexed.ts
//
//   # real publish
//   NOSTR_PRIVATE_KEY=<hex> npx tsx scripts/nostr-publish-nostr-indexed.ts
//
// Env vars:
//   MAPPINGS_FILE  — path to mining JSON (default scripts/nostr-mappings.json)
//   DB_PATH        — path to SatRank sqlite (default ./data/satrank.db)
//   MIN_SCORE      — minimum avg_score to publish (default 30, same as publisher.ts)
//   DRY_RUN        — if '1', print events instead of publishing
//
// NO EVENTS ARE PUBLISHED when DRY_RUN=1 or when NOSTR_PRIVATE_KEY is unset.

import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';
import { VERDICT_SAFE_THRESHOLD } from '../src/config/scoring';

const mappingsFile = process.env.MAPPINGS_FILE ?? 'scripts/nostr-mappings.json';
const dbPath = process.env.DB_PATH ?? './data/satrank.db';
const agentsJsonPath = process.env.AGENTS_JSON; // alternative to DB query
const minScore = Number(process.env.MIN_SCORE ?? '30');
const dryRun = process.env.DRY_RUN === '1';
const skHex = process.env.NOSTR_PRIVATE_KEY;

if (!dryRun && !skHex) {
  console.error('Set NOSTR_PRIVATE_KEY=<hex>, or DRY_RUN=1 to preview events without publishing.');
  process.exit(1);
}

if (!existsSync(mappingsFile)) {
  console.error(`Mappings file not found: ${mappingsFile}`);
  console.error('Run scripts/nostr-mine-zap-mappings.ts first to produce it.');
  process.exit(1);
}

// Two data-source modes:
//  a) AGENTS_JSON path — pre-exported subset of the agents table as JSON.
//     Useful when running from a host that can't open the DB directly
//     (e.g. a Mac without the prod volume). Each entry has the same
//     shape as the AgentRow/SnapshotRow below.
//  b) DB_PATH — direct sqlite3 query. Used on prod and anywhere with a
//     synced DB copy.
const useAgentsJson = agentsJsonPath && existsSync(agentsJsonPath);
if (!useAgentsJson && !existsSync(dbPath)) {
  console.error(`Neither AGENTS_JSON (${agentsJsonPath ?? 'unset'}) nor DB_PATH (${dbPath}) is accessible.`);
  console.error('Either set AGENTS_JSON to a pre-exported JSON file, or DB_PATH to a sqlite file.');
  process.exit(1);
}

interface MiningOutput {
  generated_at: string;
  relays_used: string[];
  receipts_scanned: number;
  receipts_decodable: number;
  distinct_ln_pks: number;
  custodial_threshold: number;
  ln_pk_distribution: Record<string, number>;
  self_hosted_mappings: Array<{
    ln_pubkey: string;
    nostr_pubkeys: string[];
    zap_count: number;
  }>;
}

const mining: MiningOutput = JSON.parse(readFileSync(mappingsFile, 'utf8'));
console.log(`Loaded ${mining.self_hosted_mappings.length} self-hosted candidate mappings from ${mappingsFile}`);
console.log(`(mining generated at ${mining.generated_at})`);
console.log(`data source: ${useAgentsJson ? `AGENTS_JSON=${agentsJsonPath}` : `DB_PATH=${dbPath}`}`);
console.log('');

interface AgentRow {
  public_key_hash: string;
  public_key: string;
  alias: string | null;
  avg_score: number;
  stale: number;
}
interface SnapshotRow {
  components: string;
}

interface AgentWithSnapshot {
  agent: AgentRow;
  snap: SnapshotRow | undefined;
}

// Load data from either JSON or sqlite.
let findAgentAndSnap: (lnPubkey: string) => AgentWithSnapshot | null;
let closeDb: () => void = () => { /* noop */ };

if (useAgentsJson) {
  const entries = JSON.parse(readFileSync(agentsJsonPath!, 'utf8')) as Array<{
    hash: string;
    ln_pubkey: string;
    alias: string | null;
    avg_score: number;
    stale: number;
    components: string;
  }>;
  const byLnPk = new Map(entries.map((e) => [e.ln_pubkey, e]));
  findAgentAndSnap = (lnPubkey: string): AgentWithSnapshot | null => {
    const row = byLnPk.get(lnPubkey);
    if (!row) return null;
    return {
      agent: {
        public_key_hash: row.hash,
        public_key: row.ln_pubkey,
        alias: row.alias,
        avg_score: row.avg_score,
        stale: row.stale,
      },
      snap: row.components ? { components: row.components } : undefined,
    };
  };
  console.log(`  loaded ${entries.length} agent rows from JSON`);
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const findAgent = db.prepare(
    'SELECT public_key_hash, public_key, alias, avg_score, stale FROM agents WHERE public_key = ?',
  );
  const findSnapshot = db.prepare(
    'SELECT components FROM score_snapshots WHERE agent_hash = ? ORDER BY computed_at DESC LIMIT 1',
  );
  findAgentAndSnap = (lnPubkey: string): AgentWithSnapshot | null => {
    const agent = findAgent.get(lnPubkey) as AgentRow | undefined;
    if (!agent) return null;
    const snap = findSnapshot.get(agent.public_key_hash) as SnapshotRow | undefined;
    return { agent, snap };
  };
  closeDb = () => db.close();
  console.log('  connected to sqlite DB');
}

interface PublishCandidate {
  nostrPubkey: string;
  lnPubkey: string;
  alias: string;
  score: number;
  components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
  zapCount: number;
  allNostrPubkeys: string[];
}

// Alias patterns that strongly indicate custodial / LSP / wallet
// infrastructure rather than a personal self-hosted node. Even if only 1
// Nostr pubkey shows up as the zap recipient in our sample, an alias
// matching one of these is almost certainly not a personal operator.
// Case-insensitive. Match on substring.
const CUSTODIAL_ALIAS_PATTERNS: RegExp[] = [
  /\bwallet of satoshi\b/i, /\bwos\b/i,
  /\balby\b/i, /\bgetalby/i,
  /\bstrike\b/i,
  /\.cash\b/i, /\bcashu\b/i, /\bmint\b/i, /\becash\b/i,
  /\bminibits\b/i,
  /\bzeus\b/i, /^zlnd\d*/i, /^lndus\d*/i, /^lndeu\d*/i, /^lndap\d*/i,
  /\bzaphq\b/i, /\bzap wallet\b/i,
  /\bolympus\b/i,
  /\bcoordinator\b/i, /\blsp\b/i,
  /\bphoenix\b/i, /\bbreez\b/i, /\bmuun\b/i,
  /\bprimal\b/i, /\bnwc\b/i,
  /\bfountain\b/i, /\bnostr wallet\b/i,
  /\bwavlake\b/i, /\bfedi\b/i,
  /\bfewsats\b/i, /\blightspark\b/i, /\bvoltage\b/i,
];

function looksCustodial(alias: string | null | undefined): boolean {
  if (!alias) return false;
  return CUSTODIAL_ALIAS_PATTERNS.some((rx) => rx.test(alias));
}

const candidates: PublishCandidate[] = [];
const dropped = {
  not_in_db: 0,
  stale: 0,
  zero_score: 0,
  below_min: 0,
  no_snapshot: 0,
  custodial_alias: 0,
  shared_ln_pk: 0,
};

// Stricter mapping filter: we only publish events where EXACTLY 1 nostr
// pubkey maps to a given ln_pubkey in the mining sample. Anything else is
// either a shared wallet, small custodial, or coordinated operation —
// cases where attributing the Lightning score to each individual user is
// ambiguous. Set env var ALLOW_SHARED_LNPK=1 to relax and allow <=5 nostr
// pks per ln_pk (the mining's self_hosted_mappings upper bound).
const allowSharedLnpk = process.env.ALLOW_SHARED_LNPK === '1';

for (const mapping of mining.self_hosted_mappings) {
  const row = findAgentAndSnap(mapping.ln_pubkey);
  if (!row) { dropped.not_in_db++; continue; }
  const { agent, snap } = row;
  if (agent.stale === 1) { dropped.stale++; continue; }
  if (agent.avg_score === 0) { dropped.zero_score++; continue; }
  if (agent.avg_score < minScore) { dropped.below_min++; continue; }
  if (!snap) { dropped.no_snapshot++; continue; }
  if (looksCustodial(agent.alias)) { dropped.custodial_alias++; continue; }
  if (!allowSharedLnpk && mapping.nostr_pubkeys.length > 1) { dropped.shared_ln_pk++; continue; }
  let components = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };
  try { components = JSON.parse(snap.components); } catch { /* keep defaults */ }
  for (const nostrPubkey of mapping.nostr_pubkeys) {
    candidates.push({
      nostrPubkey,
      lnPubkey: mapping.ln_pubkey,
      alias: agent.alias ?? mapping.ln_pubkey.slice(0, 16),
      score: Math.round(agent.avg_score),
      components,
      zapCount: mapping.zap_count,
      allNostrPubkeys: mapping.nostr_pubkeys,
    });
  }
}

console.log(`Filter results:`);
console.log(`  mined candidates:         ${mining.self_hosted_mappings.length}`);
console.log(`  dropped (not in DB):      ${dropped.not_in_db}`);
console.log(`  dropped (stale):          ${dropped.stale}`);
console.log(`  dropped (score=0):        ${dropped.zero_score}`);
console.log(`  dropped (score<${minScore}):       ${dropped.below_min}`);
console.log(`  dropped (no snapshot):    ${dropped.no_snapshot}`);
console.log(`  dropped (custodial alias): ${dropped.custodial_alias}`);
console.log(`  dropped (shared ln_pk):   ${dropped.shared_ln_pk}   (relax with ALLOW_SHARED_LNPK=1)`);
console.log(`  → events to publish:      ${candidates.length}`);
console.log('');

if (candidates.length === 0) {
  console.log('No candidates pass filters — nothing to publish.');
  closeDb();
  process.exit(0);
}

// Build events for each candidate. We use a throwaway key if DRY_RUN — the
// event is not signed for real so the signature is deterministic garbage,
// but the structure (tags, d, content) is 100% the production shape.
const sk = hexToBytes(
  skHex ?? '0000000000000000000000000000000000000000000000000000000000000001',
);
const signerPubkey = getPublicKey(sk);
console.log(`  signer pubkey: ${signerPubkey}${dryRun ? ' (DRY_RUN — not SatRank)' : ''}`);
console.log('');

interface SignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
  id: string;
  sig: string;
}

const events: SignedEvent[] = [];
for (const c of candidates) {
  const verdict =
    c.score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : c.score >= 30 ? 'UNKNOWN' : 'RISKY';
  const template = {
    kind: 30382,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', c.nostrPubkey],
      ['rank', String(c.score)],
      ['ln_pubkey', c.lnPubkey],
      ['subject_type', 'mined_mapping'],
      ['source', 'nip57_zap_receipt'],
      ['zap_count', String(c.zapCount)],
      ['alias', c.alias],
      ['score', String(c.score)],
      ['verdict', verdict],
      ['volume', String(c.components.volume)],
      ['reputation', String(c.components.reputation)],
      ['seniority', String(c.components.seniority)],
      ['regularity', String(c.components.regularity)],
      ['diversity', String(c.components.diversity)],
    ],
    content: '',
  };
  events.push(finalizeEvent(template, sk) as SignedEvent);
}
console.log(`Built ${events.length} signed kind 30382 events.`);
console.log('');
console.log('Sample event (first candidate):');
console.log(JSON.stringify(events[0], null, 2));
console.log('');
console.log('All candidates summary:');
for (const c of candidates) {
  const sameNodeTag = c.allNostrPubkeys.length > 1 ? ` (shared with ${c.allNostrPubkeys.length - 1} other nostr pk)` : '';
  console.log(
    `  ${c.nostrPubkey.slice(0, 16)}...  ← ${c.alias.padEnd(24)} ` +
    `score=${String(c.score).padStart(3)} zaps=${String(c.zapCount).padStart(3)}${sameNodeTag}`,
  );
}
console.log('');

closeDb();

if (dryRun) {
  console.log(`DRY_RUN=1 — not publishing. ${events.length} events ready.`);
  process.exit(0);
}

async function publishAll(): Promise<void> {
  const relays = DEFAULT_NOSTR_RELAYS;
  const connected: { url: string; relay: { publish: Function; close: () => void } }[] = [];
  for (const url of relays) {
    try {
      const relay = (await Promise.race([
        Relay.connect(url),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 10_000)),
      ])) as { publish: Function; close: () => void };
      connected.push({ url, relay });
      console.log(`  relay up: ${url}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  relay DOWN: ${url} (${msg})`);
    }
  }
  if (connected.length === 0) {
    console.error('No relays reachable — aborting.');
    process.exit(1);
  }
  console.log('');

  let totalOk = 0;
  let totalFail = 0;
  for (const ev of events) {
    const results = await Promise.allSettled(
      connected.map(async ({ url, relay }) => {
        try {
          await Promise.race([
            relay.publish(ev),
            new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), 5_000)),
          ]);
          return { url, ok: true };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { url, ok: false, error: msg };
        }
      }),
    );
    const okCount = results.filter((r) => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok).length;
    if (okCount > 0) {
      totalOk++;
      console.log(`  [OK]   ${ev.tags.find((t) => t[0] === 'd')?.[1].slice(0, 16)}... — ${okCount}/${connected.length} relays`);
    } else {
      totalFail++;
      const failures = results.map((r) => r.status === 'fulfilled' ? r.value : { url: '?', ok: false, error: 'rejected' });
      console.log(`  [FAIL] ${ev.tags.find((t) => t[0] === 'd')?.[1].slice(0, 16)}... — ${JSON.stringify(failures)}`);
    }
  }
  console.log('');
  console.log(`Publish result: ${totalOk} succeeded, ${totalFail} failed`);
  for (const { relay } of connected) {
    try { relay.close(); } catch { /* ignore */ }
  }
}

publishAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
