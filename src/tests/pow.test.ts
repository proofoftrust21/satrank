import { describe, it, expect } from 'vitest';
import { leadingZeroBits, mineEvent } from '../nostr/pow';

describe('pow / leadingZeroBits', () => {
  it('returns 0 for a hex string starting with f', () => {
    expect(leadingZeroBits('ffffffff')).toBe(0);
  });
  it('returns 4 for a hex string starting with 0f', () => {
    expect(leadingZeroBits('0fffffff')).toBe(4);
  });
  it('returns 8 for a hex string starting with 00ff', () => {
    expect(leadingZeroBits('00ffffff')).toBe(8);
  });
  it('returns 12 for 000f', () => {
    expect(leadingZeroBits('000fffff')).toBe(12);
  });
  it('handles a within-nibble count: 03 → 6 bits', () => {
    expect(leadingZeroBits('03ffffff')).toBe(6);
  });
  it('handles 01 → 7 bits', () => {
    expect(leadingZeroBits('01ffffff')).toBe(7);
  });
  it('returns full length for an all-zero hex string', () => {
    expect(leadingZeroBits('00000000')).toBe(32);
  });
});

describe('pow / mineEvent', () => {
  // A throwaway pubkey — the miner only needs it for serialization, it
  // does not validate the key against any signature.
  const pubkey = '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4';
  const baseTemplate = {
    kind: 1,
    created_at: 1700000000,
    tags: [['t', 'test']],
    content: 'pow miner unit test',
  };

  it('mines a low target (8 bits) under a generous budget', () => {
    const result = mineEvent(baseTemplate, pubkey, 8, 5_000);
    expect(result).not.toBeNull();
    expect(result!.achievedBits).toBeGreaterThanOrEqual(8);
    // Final tags should include the nonce tag with the [nonce, target] shape
    const nonceTag = result!.template.tags.find((t) => t[0] === 'nonce');
    expect(nonceTag).toBeDefined();
    expect(nonceTag![2]).toBe('8');
    // Original tags must be preserved
    expect(result!.template.tags.find((t) => t[0] === 't')).toEqual(['t', 'test']);
  });

  it('returns null when the budget is too small to hit a high target', () => {
    // 32 bits ≈ 4 billion attempts; impossible in 50 ms.
    const result = mineEvent(baseTemplate, pubkey, 32, 50);
    expect(result).toBeNull();
  });

  it('strips a pre-existing nonce tag before re-mining', () => {
    const tplWithNonce = {
      ...baseTemplate,
      tags: [...baseTemplate.tags, ['nonce', '99999', '4']],
    };
    const result = mineEvent(tplWithNonce, pubkey, 4, 1_000);
    expect(result).not.toBeNull();
    const nonceTags = result!.template.tags.filter((t) => t[0] === 'nonce');
    expect(nonceTags).toHaveLength(1);
    // Re-mined nonce target should be the new one (4), not the stale 99999
    expect(nonceTags[0][2]).toBe('4');
  });

  it('returns target unchanged when targetBits <= 0', () => {
    const result = mineEvent(baseTemplate, pubkey, 0, 1_000);
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(0);
    expect(result!.template.tags.find((t) => t[0] === 'nonce')).toBeUndefined();
  });
});
