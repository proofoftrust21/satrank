#!/usr/bin/env npx tsx
// Read-only: fetch the live kind 0 (profile) for SatRank's npub from each
// canonical relay and dump the full JSON content + created_at so we can
// audit how stale the on-chain Nostr profile is vs the local draft.
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

async function fetchProfile(url: string): Promise<{ relay: string; event: NostrEvent | null; error: string | null }> {
  try {
    const relay = await Promise.race([
      Relay.connect(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout 10s')), 10_000)),
    ]) as { subscribe: (filters: unknown[], handlers: unknown) => { close: () => void }; close: () => void };

    const event = await new Promise<NostrEvent | null>((resolve) => {
      let captured: NostrEvent | null = null;
      const sub = relay.subscribe(
        [{ kinds: [0], authors: [PUBKEY], limit: 1 }],
        {
          onevent(ev: NostrEvent) { if (!captured) captured = ev; },
          oneose() { try { sub.close(); } catch { /* ignore */ } resolve(captured); },
        },
      );
      setTimeout(() => { try { sub.close(); } catch { /* ignore */ } resolve(captured); }, 6_000);
    });
    try { relay.close(); } catch { /* ignore */ }
    return { relay: url, event, error: null };
  } catch (err: unknown) {
    return { relay: url, event: null, error: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  for (const r of RELAYS) {
    const res = await fetchProfile(r);
    console.log(`\n=== ${res.relay} ===`);
    if (res.error) { console.log(`ERROR: ${res.error}`); continue; }
    if (!res.event) { console.log('NO EVENT'); continue; }
    const created = new Date(res.event.created_at * 1000).toISOString();
    console.log(`event.id     : ${res.event.id}`);
    console.log(`created_at   : ${created}`);
    try {
      const profile = JSON.parse(res.event.content);
      console.log('content (parsed):');
      console.log(JSON.stringify(profile, null, 2));
    } catch {
      console.log(`content (raw): ${res.event.content}`);
    }
  }
})();
