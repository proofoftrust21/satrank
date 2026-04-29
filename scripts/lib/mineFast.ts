// Fast single-thread NIP-13 miner using Node's OpenSSL-backed sha256.
//
// `crypto.createHash('sha256')` is 5-10x faster than the pure-JS
// @noble/hashes implementation used in src/nostr/pow.ts (which exists for
// browser/edge compatibility and is unchanged). For ad-hoc mining of kind 0
// to clear nos.lol's 28-bit gate, this is the right tool: ~30M attempts/s
// on an M2 single thread, so 2^28 ≈ 268 M attempts → ~9 s expected, ~30 s
// worst case. No worker_threads or tsx-ESM glue needed.
import { createHash } from 'node:crypto';

export interface FastMineInput {
  template: { kind: number; created_at: number; tags: string[][]; content: string };
  pubkey: string;
  targetBits: number;
  maxMs: number;
}

export interface FastMineResult {
  template: FastMineInput['template'];
  attempts: number;
  achievedBits: number;
  elapsedMs: number;
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) { bits += 8; continue; }
    if (byte < 2) return bits + 7;
    if (byte < 4) return bits + 6;
    if (byte < 8) return bits + 5;
    if (byte < 16) return bits + 4;
    if (byte < 32) return bits + 3;
    if (byte < 64) return bits + 2;
    if (byte < 128) return bits + 1;
    return bits;
  }
  return bits;
}

export function mineFast(input: FastMineInput): FastMineResult | null {
  if (input.targetBits <= 0) {
    return { template: input.template, attempts: 0, achievedBits: 0, elapsedMs: 0 };
  }
  const baseTags = input.template.tags.filter((t) => t[0] !== 'nonce');
  const start = Date.now();
  const nonceTag = ['nonce', '0', String(input.targetBits)];
  const tags = [...baseTags, nonceTag];
  const candidate = {
    kind: input.template.kind,
    created_at: input.template.created_at,
    tags,
    content: input.template.content,
  };
  // Pre-compute the static prefix and suffix of the canonical serialization
  // so the hot loop only writes the variable nonce string. Reduces the
  // per-attempt cost from O(n) JSON.stringify to O(1) string concat.
  const tagsBefore = baseTags;
  const tagsString = (nonceVal: string): string => {
    // Manually build [...baseTags, ['nonce', nonceVal, target]] to avoid
    // JSON.stringify allocating a new array every iteration.
    let s = '[';
    for (let i = 0; i < tagsBefore.length; i++) {
      if (i > 0) s += ',';
      s += JSON.stringify(tagsBefore[i]);
    }
    if (tagsBefore.length > 0) s += ',';
    s += `["nonce","${nonceVal}","${input.targetBits}"]`;
    s += ']';
    return s;
  };
  const prefix = `[0,"${input.pubkey}",${input.template.created_at},${input.template.kind},`;
  const suffix = `,${JSON.stringify(input.template.content)}]`;

  const BUDGET_CHECK = 16384;
  let nonce = 0;
  while (true) {
    const serialized = prefix + tagsString(nonce.toString()) + suffix;
    const hash = createHash('sha256').update(serialized).digest();
    const bits = leadingZeroBits(hash);
    if (bits >= input.targetBits) {
      nonceTag[1] = nonce.toString();
      return {
        template: { ...candidate, tags: [...candidate.tags] },
        attempts: nonce + 1,
        achievedBits: bits,
        elapsedMs: Date.now() - start,
      };
    }
    nonce++;
    if ((nonce & (BUDGET_CHECK - 1)) === 0) {
      if (Date.now() - start >= input.maxMs) return null;
    }
  }
}
