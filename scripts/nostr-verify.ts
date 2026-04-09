#!/usr/bin/env npx tsx
// Verify SatRank events are published on Nostr relays
// Usage: NOSTR_PUBKEY=<hex> npx tsx scripts/nostr-verify.ts
// @ts-expect-error — ESM subpath
import { Relay } from 'nostr-tools/relay';

const pubkey = process.env.NOSTR_PUBKEY;
if (!pubkey) {
  console.error('Set NOSTR_PUBKEY=<hex pubkey> environment variable');
  process.exit(1);
}

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const KIND = 30382;

async function check(url: string): Promise<number> {
  try {
    const relay = await Relay.connect(url);
    let count = 0;

    return new Promise<number>((resolve) => {
      const sub = relay.subscribe(
        [{ kinds: [KIND], authors: [pubkey!], limit: 5 }],
        {
          onevent(event: { tags: string[][]; created_at: number }) {
            count++;
            const d = event.tags.find((t: string[]) => t[0] === 'd');
            const score = event.tags.find((t: string[]) => t[0] === 'score');
            const verdict = event.tags.find((t: string[]) => t[0] === 'verdict');
            if (count <= 3) {
              console.log(`  ${d?.[1]?.slice(0, 20)}... score=${score?.[1]} verdict=${verdict?.[1]}`);
            }
          },
          oneose() {
            sub.close();
            relay.close();
            resolve(count);
          },
        },
      );

      // Timeout after 10 seconds
      setTimeout(() => { sub.close(); relay.close(); resolve(count); }, 10000);
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Failed to connect: ${msg}`);
    return 0;
  }
}

async function main() {
  console.log(`Checking kind ${KIND} events from ${pubkey.slice(0, 16)}...`);
  console.log('');

  let totalFound = 0;
  for (const url of RELAYS) {
    console.log(`${url}:`);
    const count = await check(url);
    console.log(`  → ${count} events found`);
    totalFound += count;
    console.log('');
  }

  console.log(`Total: ${totalFound} events across ${RELAYS.length} relays`);
  if (totalFound === 0) {
    console.log('No events found. The publisher may not have run yet. Wait for the next crawl cycle.');
  }
}

main().catch(console.error);
