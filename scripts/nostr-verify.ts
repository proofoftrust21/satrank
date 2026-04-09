#!/usr/bin/env npx tsx
// Verifies SatRank's Nostr presence end-to-end by querying each canonical
// relay for the three kinds SatRank cares about:
//
//   kind 0      — profile metadata (NIP-01)
//   kind 30382  — trusted assertions for Lightning nodes (NIP-85)
//   kind 10040  — self-declaration as a trusted provider (NIP-85 appendix)
//
// Usage:
//   NOSTR_PUBKEY=<hex>  npx tsx scripts/nostr-verify.ts          # single pubkey
//                       npx tsx scripts/nostr-verify.ts          # falls back to SatRank's service pubkey
//
// No signing key is required — the script is pure reader: it opens a
// REQ subscription on each relay, collects events for a fixed window,
// closes the subscription, and prints a per-relay summary plus totals.
// Non-zero exit if any of the three kinds is missing across every relay.
//
// This is what we point the WoT-a-thon jury at when they ask "is the
// kind 10040 circuit really live, or is it just documented?".
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import WebSocket from 'ws';
import { DEFAULT_NOSTR_RELAYS } from '../src/nostr/relays';

// Node 18 lacks a global WebSocket — plug in ws so nostr-tools can connect.
// Node 22 (production container) provides a built-in global; leaving the
// implementation override in is harmless there.
useWebSocketImplementation(WebSocket);

const SATRANK_SERVICE_PUBKEY =
  '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4';

const pubkey = (process.env.NOSTR_PUBKEY ?? SATRANK_SERVICE_PUBKEY).trim();
if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
  console.error('NOSTR_PUBKEY must be a 64-char hex pubkey');
  process.exit(1);
}

const RELAYS = DEFAULT_NOSTR_RELAYS;
const KINDS: { kind: number; label: string; limit: number }[] = [
  { kind: 0, label: 'profile metadata', limit: 1 },
  { kind: 30382, label: 'trusted assertions (NIP-85)', limit: 5 },
  { kind: 10040, label: 'trusted provider self-declaration (NIP-85)', limit: 2 },
];

interface NostrEvent {
  id: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

interface KindResult {
  kind: number;
  label: string;
  count: number;
  firstEvent: NostrEvent | null;
}

interface RelayResult {
  relay: string;
  connected: boolean;
  error: string | null;
  byKind: KindResult[];
}

async function queryRelay(url: string): Promise<RelayResult> {
  const result: RelayResult = {
    relay: url,
    connected: false,
    error: null,
    byKind: KINDS.map((k) => ({
      kind: k.kind,
      label: k.label,
      count: 0,
      firstEvent: null,
    })),
  };

  let relay: { subscribe: Function; close: () => void } | null = null;
  try {
    relay = await Promise.race([
      Relay.connect(url),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('connect timeout (10s)')), 10_000),
      ),
    ]) as { subscribe: Function; close: () => void };
    result.connected = true;
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  // One subscription per kind so one relay rejecting a single kind does
  // not collapse the whole check.
  for (const { kind, limit } of KINDS) {
    const entry = result.byKind.find((k) => k.kind === kind)!;
    await new Promise<void>((resolve) => {
      const sub = relay!.subscribe(
        [{ kinds: [kind], authors: [pubkey], limit }],
        {
          onevent(ev: NostrEvent) {
            entry.count += 1;
            if (entry.firstEvent === null) entry.firstEvent = ev;
          },
          oneose() {
            try { sub.close(); } catch { /* ignore */ }
            resolve();
          },
        },
      );
      // Belt and suspenders: some relays never send EOSE.
      setTimeout(() => {
        try { sub.close(); } catch { /* ignore */ }
        resolve();
      }, 6_000);
    });
  }

  try { relay.close(); } catch { /* ignore */ }
  return result;
}

function summarizeEvent(event: NostrEvent): string {
  if (event.kind === 0) {
    try {
      const profile = JSON.parse(event.content);
      const name = profile.name ?? profile.display_name ?? '(unnamed)';
      const nip05 = profile.nip05 ? ` nip05=${profile.nip05}` : '';
      return `name=${name}${nip05}`;
    } catch {
      return '(invalid JSON content)';
    }
  }
  if (event.kind === 30382) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const rank = event.tags.find((t) => t[0] === 'rank')?.[1];
    const verdict = event.tags.find((t) => t[0] === 'verdict')?.[1];
    const alias = event.tags.find((t) => t[0] === 'alias')?.[1] ?? '';
    return `d=${d.slice(0, 16)}... rank=${rank ?? '?'} verdict=${verdict ?? '?'} alias=${alias}`;
  }
  if (event.kind === 10040) {
    const rows = event.tags
      .filter((t) => t[0]?.startsWith('30382:'))
      .map((t) => `${t[0]}→${t[2] ?? ''}`);
    return rows.length ? rows.join(' | ') : '(no 30382 rows)';
  }
  return `(kind ${event.kind})`;
}

async function main(): Promise<void> {
  console.log(`SatRank Nostr presence verification`);
  console.log(`  pubkey: ${pubkey}`);
  console.log(`  relays: ${RELAYS.join(', ')}`);
  console.log('');

  const results = await Promise.all(RELAYS.map(queryRelay));
  const totals: Record<number, number> = { 0: 0, 10040: 0, 30382: 0 };

  for (const r of results) {
    console.log(`-- ${r.relay} --`);
    if (!r.connected) {
      console.log(`  FAIL: ${r.error ?? 'unknown error'}`);
      console.log('');
      continue;
    }
    for (const k of r.byKind) {
      totals[k.kind] = (totals[k.kind] ?? 0) + k.count;
      console.log(
        `  kind ${String(k.kind).padEnd(5)} (${k.label}): ${k.count} event${k.count === 1 ? '' : 's'}`,
      );
      if (k.firstEvent) {
        const created = new Date(k.firstEvent.created_at * 1000).toISOString();
        console.log(`    sample id:      ${k.firstEvent.id}`);
        console.log(`    sample created: ${created}`);
        console.log(`    sample data:    ${summarizeEvent(k.firstEvent)}`);
      }
    }
    console.log('');
  }

  console.log('-- totals across relays --');
  for (const { kind, label } of KINDS) {
    console.log(`  kind ${String(kind).padEnd(5)} (${label}): ${totals[kind] ?? 0}`);
  }

  const missing: number[] = [];
  for (const { kind } of KINDS) if ((totals[kind] ?? 0) === 0) missing.push(kind);

  console.log('');
  if (missing.length === 0) {
    console.log('All three kinds present across at least one relay.');
  } else {
    console.log(`Missing: kind ${missing.join(', ')} not found on any relay.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
