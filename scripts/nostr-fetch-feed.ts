#!/usr/bin/env npx tsx
// Read-only: list recent kind 1 (notes), 30382 (legacy NIP-85), 30382/30383
// (multi-kind), 30782/30783/30784/7402 events authored by SatRank's npub.
// Used to audit what njump.me / other Nostr clients display as the public
// face of the oracle.
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
useWebSocketImplementation(WS);

const PUBKEY = '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4';
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

interface NostrEvent {
  id: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

async function fetchKind(url: string, kind: number, limit: number): Promise<{ events: NostrEvent[]; error: string | null }> {
  try {
    const relay = await Promise.race([
      Relay.connect(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout 10s')), 10_000)),
    ]) as { subscribe: (filters: unknown[], handlers: unknown) => { close: () => void }; close: () => void };

    const events = await new Promise<NostrEvent[]>((resolve) => {
      const out: NostrEvent[] = [];
      const sub = relay.subscribe(
        [{ kinds: [kind], authors: [PUBKEY], limit }],
        {
          onevent(ev: NostrEvent) { out.push(ev); },
          oneose() { try { sub.close(); } catch { /* ignore */ } resolve(out); },
        },
      );
      setTimeout(() => { try { sub.close(); } catch { /* ignore */ } resolve(out); }, 6_000);
    });
    try { relay.close(); } catch { /* ignore */ }
    return { events, error: null };
  } catch (err: unknown) {
    return { events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  // Check the most-public-facing kinds first.
  const KINDS: { kind: number; label: string; limit: number }[] = [
    { kind: 1, label: 'note (text)', limit: 10 },
    { kind: 30382, label: 'NIP-85 endorsement (legacy + multi-kind)', limit: 3 },
    { kind: 30782, label: 'trust assertion', limit: 3 },
    { kind: 30783, label: 'calibration', limit: 3 },
    { kind: 30784, label: 'oracle announcement', limit: 3 },
    { kind: 10040, label: 'NIP-85 self-declaration', limit: 1 },
  ];

  // Aggregate across the 3 relays, dedup by id.
  for (const { kind, label, limit } of KINDS) {
    const merged = new Map<string, NostrEvent>();
    for (const r of RELAYS) {
      const res = await fetchKind(r, kind, limit);
      for (const ev of res.events) merged.set(ev.id, ev);
    }
    const sorted = Array.from(merged.values()).sort((a, b) => b.created_at - a.created_at);
    console.log(`\n=== kind ${kind} — ${label} (${sorted.length} unique across relays) ===`);
    for (const ev of sorted.slice(0, limit)) {
      const created = new Date(ev.created_at * 1000).toISOString();
      const preview = ev.content.length > 220 ? ev.content.slice(0, 220) + '…' : ev.content;
      console.log(`  - ${created}  id=${ev.id.slice(0, 12)}…  tags=${ev.tags.length}  content: ${preview.replace(/\n/g, ' / ')}`);
    }
  }
})();
