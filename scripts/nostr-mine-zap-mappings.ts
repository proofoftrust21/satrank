#!/usr/bin/env npx tsx
// Nostr zap-receipt mining — builds a Lightning pubkey ↔ Nostr pubkey
// mapping by walking NIP-57 kind 9735 zap receipts across a set of relays,
// decoding the embedded BOLT11 invoice to recover the payee node pubkey,
// and cross-referencing it with the zap recipient's Nostr pubkey from the
// `p` tag.
//
// Output: a JSON mapping file at scripts/nostr-mappings.json with the
// structure:
//   {
//     "generated_at": "2026-04-09T...",
//     "relays_used": ["wss://...", ...],
//     "receipts_scanned": 5423,
//     "receipts_decodable": 5310,
//     "distinct_ln_pks": 487,
//     "ln_pk_distribution": { "1 nostr": 231, "2-5 nostrs": 142, "6-20": 80, ">20 (custodial)": 34 },
//     "self_hosted_mappings": [
//       { "ln_pubkey": "02abc...", "nostr_pubkeys": ["hex1", "hex2"], "zap_count": 3 },
//       ...
//     ]
//   }
//
// The `self_hosted_mappings` list contains only entries where a single
// ln_pubkey is associated with <= SELF_HOSTED_THRESHOLD distinct Nostr
// pubkeys — a strong heuristic for "not a custodial wallet hosting many
// users". The downstream publisher (nostr-publish-nostr-indexed.ts) can
// further filter by "ln_pubkey is in SatRank's agents table with score
// >= 30".
//
// NO EVENTS ARE PUBLISHED by this script. It's read-only on Nostr.
//
// Usage:
//   npx tsx scripts/nostr-mine-zap-mappings.ts
//
// Env vars:
//   MINING_LIMIT     — max receipts to request per relay (default 2000)
//   OUTPUT_FILE      — output path (default scripts/nostr-mappings.json)
//   CUSTODIAL_THRESHOLD — above this count of distinct Nostr pks, an ln_pk
//                         is classified custodial (default 5)

import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bolt11 = require('bolt11');
useWebSocketImplementation(WS);

// The 3 canonical SatRank relays plus Primal's cache which carries the
// full Nostr event stream (higher zap volume than the canonical relays).
const RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://cache2.primal.net/v1',
];
const MINING_LIMIT = Number(process.env.MINING_LIMIT ?? '2000');
const CUSTODIAL_THRESHOLD = Number(process.env.CUSTODIAL_THRESHOLD ?? '5');
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? join(__dirname, 'nostr-mappings.json');
const SUBSCRIBE_TIMEOUT_MS = 30_000;

interface ZapEvent {
  id: string;
  pubkey: string; // the LSP/wallet provider, not the recipient
  created_at: number;
  tags: string[][];
  content: string;
}

interface RawMapping {
  nostrPubkey: string;
  lnPubkey: string;
  zapEventId: string;
  createdAt: number;
}

function extractFromReceipt(ev: ZapEvent): RawMapping | null {
  const pTag = ev.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string');
  const bolt11Tag = ev.tags.find((t) => t[0] === 'bolt11' && typeof t[1] === 'string');
  if (!pTag || !bolt11Tag) return null;
  const nostrPubkey = pTag[1];
  if (!/^[a-f0-9]{64}$/i.test(nostrPubkey)) return null;
  const invoice = bolt11Tag[1];
  try {
    const decoded = bolt11.decode(invoice);
    const lnPubkey: string | undefined = decoded.payeeNodeKey;
    if (!lnPubkey || !/^(02|03)[a-f0-9]{64}$/.test(lnPubkey)) return null;
    return {
      nostrPubkey: nostrPubkey.toLowerCase(),
      lnPubkey: lnPubkey.toLowerCase(),
      zapEventId: ev.id,
      createdAt: ev.created_at,
    };
  } catch {
    return null;
  }
}

async function fetchFromRelay(url: string, limit: number): Promise<ZapEvent[]> {
  console.log(`  connecting to ${url}...`);
  let relay: { subscribe: Function; close: () => void } | null = null;
  try {
    relay = (await Promise.race([
      Relay.connect(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 15_000)),
    ])) as { subscribe: Function; close: () => void };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [fail] ${url}: ${msg}`);
    return [];
  }

  const events: ZapEvent[] = [];
  const seen = new Set<string>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const sub = relay!.subscribe(
      [{ kinds: [9735], limit }],
      {
        onevent(ev: ZapEvent) {
          if (seen.has(ev.id)) return;
          seen.add(ev.id);
          events.push(ev);
        },
        oneose() {
          if (!resolved) {
            resolved = true;
            try { sub.close(); } catch { /* ignore */ }
            resolve();
          }
        },
      },
    );
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { sub.close(); } catch { /* ignore */ }
        resolve();
      }
    }, SUBSCRIBE_TIMEOUT_MS);
  });

  try { relay.close(); } catch { /* ignore */ }
  console.log(`  [ok]   ${url}: ${events.length} receipts`);
  return events;
}

async function main(): Promise<void> {
  console.log('Nostr zap-receipt mining');
  console.log(`  relays:               ${RELAYS.join(', ')}`);
  console.log(`  limit per relay:      ${MINING_LIMIT}`);
  console.log(`  custodial threshold:  > ${CUSTODIAL_THRESHOLD} distinct nostr pks per ln_pk`);
  console.log(`  output:               ${OUTPUT_FILE}`);
  console.log('');

  // Fetch from all relays in parallel
  const startMs = Date.now();
  const perRelayEvents = await Promise.all(RELAYS.map((url) => fetchFromRelay(url, MINING_LIMIT)));
  const elapsedMs = Date.now() - startMs;
  const totalFetched = perRelayEvents.reduce((acc, arr) => acc + arr.length, 0);
  console.log('');
  console.log(`  fetched ${totalFetched} receipts across ${RELAYS.length} relays in ${elapsedMs}ms`);

  // Global dedup: same event id might appear on multiple relays
  const uniqueById = new Map<string, ZapEvent>();
  for (const arr of perRelayEvents) {
    for (const ev of arr) uniqueById.set(ev.id, ev);
  }
  const distinctReceipts = uniqueById.size;
  console.log(`  distinct receipts (dedup by event id): ${distinctReceipts}`);

  // Decode each receipt, extract (nostr_pk, ln_pk)
  const mappings: RawMapping[] = [];
  let decodable = 0;
  let undecodable = 0;
  for (const ev of uniqueById.values()) {
    const m = extractFromReceipt(ev);
    if (m) {
      mappings.push(m);
      decodable++;
    } else {
      undecodable++;
    }
  }
  console.log(`  decodable:   ${decodable}`);
  console.log(`  undecodable: ${undecodable} (missing p/bolt11 tag, invalid invoice, or no payeeNodeKey)`);

  // Aggregate: Map<ln_pk, Set<nostr_pk>>
  const byLnPk = new Map<string, Set<string>>();
  const zapCountByLnPk = new Map<string, number>();
  for (const m of mappings) {
    if (!byLnPk.has(m.lnPubkey)) byLnPk.set(m.lnPubkey, new Set());
    byLnPk.get(m.lnPubkey)!.add(m.nostrPubkey);
    zapCountByLnPk.set(m.lnPubkey, (zapCountByLnPk.get(m.lnPubkey) ?? 0) + 1);
  }
  const distinctLnPks = byLnPk.size;
  console.log(`  distinct ln_pks found: ${distinctLnPks}`);

  // Classify: self-hosted (low count of nostr_pks) vs custodial (high count)
  const distribution: Record<string, number> = {
    '1 nostr':      0,
    '2-5 nostrs':   0,
    '6-20 nostrs':  0,
    '>20 (custodial)': 0,
  };
  const selfHosted: { ln_pubkey: string; nostr_pubkeys: string[]; zap_count: number }[] = [];
  for (const [lnPk, nostrSet] of byLnPk.entries()) {
    const n = nostrSet.size;
    const zapCount = zapCountByLnPk.get(lnPk) ?? 0;
    if (n === 1) distribution['1 nostr']++;
    else if (n <= 5) distribution['2-5 nostrs']++;
    else if (n <= 20) distribution['6-20 nostrs']++;
    else distribution['>20 (custodial)']++;
    if (n <= CUSTODIAL_THRESHOLD) {
      selfHosted.push({
        ln_pubkey: lnPk,
        nostr_pubkeys: [...nostrSet].sort(),
        zap_count: zapCount,
      });
    }
  }
  selfHosted.sort((a, b) => b.zap_count - a.zap_count);
  console.log('');
  console.log('  distribution of distinct-nostr-pks per ln_pk:');
  for (const [k, v] of Object.entries(distribution)) {
    console.log(`    ${k.padEnd(18)} ${v}`);
  }
  console.log('');
  console.log(`  self-hosted candidates (≤ ${CUSTODIAL_THRESHOLD} nostr_pks per ln_pk): ${selfHosted.length}`);
  console.log('');

  const output = {
    generated_at: new Date().toISOString(),
    relays_used: RELAYS,
    receipts_scanned: distinctReceipts,
    receipts_decodable: decodable,
    receipts_undecodable: undecodable,
    distinct_ln_pks: distinctLnPks,
    custodial_threshold: CUSTODIAL_THRESHOLD,
    ln_pk_distribution: distribution,
    self_hosted_mappings: selfHosted,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`  wrote ${OUTPUT_FILE} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);
  if (selfHosted.length > 0) {
    console.log('');
    console.log('  top 5 candidates by zap count:');
    for (const m of selfHosted.slice(0, 5)) {
      console.log(`    ln=${m.ln_pubkey.slice(0, 16)}... nostrs=[${m.nostr_pubkeys.map((p) => p.slice(0, 8)).join(',')}] zaps=${m.zap_count}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
