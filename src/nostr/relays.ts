// Canonical Nostr relay list for SatRank. Single source of truth —
// imported by src/config.ts (zod default for NOSTR_RELAYS), the NIP-05
// handler in src/app.ts, and the three scripts in scripts/nostr-*.ts.
// Update here and all consumers follow.
//
// This file must stay pure: no dotenv, no zod, no runtime side effects.
// Scripts import it without triggering the full config pipeline.

export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export const DEFAULT_NOSTR_RELAYS_CSV: string = DEFAULT_NOSTR_RELAYS.join(',');
