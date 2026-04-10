// NIP-13 Proof-of-Work mining for Nostr events.
//
// Why this exists: strfry relays (damus.io, nos.lol) can be configured to
// require N leading-zero bits on the event id of certain kinds for spam
// resistance. nos.lol observed in production: "pow: 28 bits needed" on
// kind 6900 (NIP-90 DVM job results). NIP-13 defines the convention:
// add a `nonce` tag, vary the counter until the event id (sha256 of the
// canonical serialization) has at least `targetBits` leading zero bits.
//
// This module is single-threaded on purpose. For 28-bit targets the
// expected attempt count is ~2^28 ≈ 268M which is impractical inline
// during a sub-3s DVM response, so callers MUST pass a `maxMs` budget
// and gracefully fall back when the miner returns null. For lower
// targets (e.g. 16-22 bits) the miner finishes in tens to hundreds of
// milliseconds and the result can be published opportunistically.
//
// Cost reference (single-thread, @noble/hashes/sha256, MacBook Pro M2):
//   16 bits ≈ 65 k attempts ≈ 20 ms
//   20 bits ≈ 1 M attempts  ≈ 300 ms
//   24 bits ≈ 16 M attempts ≈ 5 s
//   28 bits ≈ 268 M attempts ≈ 80 s   <-- skip nos.lol on this kind
//
// Implementation note: we recompute the event id ourselves with
// @noble/hashes/sha256 inside the hot loop instead of round-tripping
// through nostr-tools' finalizeEvent each iteration. Signing happens
// exactly once at the end on the winning template, which avoids the
// schnorr-sign cost (~1 ms) being multiplied by N attempts.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface MineResult {
  // The original template with a final `nonce` tag injected. Caller still
  // needs to pass this through finalizeEvent(template, sk) to obtain the
  // signed event — that step recomputes the same id and produces sig/pubkey.
  template: EventTemplate;
  attempts: number;
  achievedBits: number;
  elapsedMs: number;
}

// Count the leading zero bits in a hex string (each hex char = 4 bits).
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    // For non-zero nibbles, count the high zero bits within the nibble.
    if (nibble < 2) return bits + 3;
    if (nibble < 4) return bits + 2;
    if (nibble < 8) return bits + 1;
    return bits;
  }
  return bits;
}

// Canonical NIP-01 serialization used to compute the event id.
// JSON.stringify produces the same shape Nostr clients expect:
//   [0, pubkey, created_at, kind, tags, content]
function serializeForId(pubkey: string, ev: EventTemplate): string {
  return JSON.stringify([0, pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

// Mine an event template until its id has at least `targetBits` leading
// zero bits, OR until `maxMs` has elapsed (whichever comes first).
//
// Returns the mined template (with a final `nonce` tag) when target is
// hit, or `null` if the time budget runs out before target. The caller
// is expected to feed the returned template into `finalizeEvent(template,
// sk)` to produce the signed event with the final id and signature.
//
// `pubkey` is required because the id depends on it via the canonical
// serialization. Pass the result of `getPublicKey(sk)`.
export function mineEvent(
  template: EventTemplate,
  pubkey: string,
  targetBits: number,
  maxMs: number,
): MineResult | null {
  if (targetBits <= 0) {
    return { template, attempts: 0, achievedBits: 0, elapsedMs: 0 };
  }
  // Strip any pre-existing nonce tag so a re-mine starts fresh.
  const baseTags = template.tags.filter((t) => t[0] !== 'nonce');
  const start = Date.now();
  let nonce = 0;
  // Mutate this slot in-place every iteration to avoid GC churn from
  // creating new arrays on the hot path.
  const nonceTag = ['nonce', '0', String(targetBits)];
  const tags = [...baseTags, nonceTag];
  const candidate: EventTemplate = {
    kind: template.kind,
    created_at: template.created_at,
    tags,
    content: template.content,
  };

  // Check the budget every 4096 attempts to avoid Date.now() overhead.
  const BUDGET_CHECK_INTERVAL = 4096;
  while (true) {
    nonceTag[1] = nonce.toString();
    const serialized = serializeForId(pubkey, candidate);
    const hash = sha256(serialized);
    const idHex = bytesToHex(hash);
    const bits = leadingZeroBits(idHex);
    if (bits >= targetBits) {
      return {
        template: { ...candidate, tags: [...candidate.tags] },
        attempts: nonce + 1,
        achievedBits: bits,
        elapsedMs: Date.now() - start,
      };
    }
    nonce++;
    if ((nonce & (BUDGET_CHECK_INTERVAL - 1)) === 0) {
      if (Date.now() - start >= maxMs) return null;
    }
  }
}
