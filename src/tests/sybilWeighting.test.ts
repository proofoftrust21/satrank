// Phase 8.1 — Sybil weighting : tests purs.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  countLeadingZeroBits,
  verifyPreimage,
  computeSybilWeight,
  BASE_WEIGHT,
  MAX_POW_FACTOR,
  MAX_AGE_FACTOR,
  PREIMAGE_FACTOR_VALID,
  PREIMAGE_FACTOR_NONE,
} from '../utils/sybilWeighting';

describe('countLeadingZeroBits', () => {
  // Security C2 — strict 64-char enforcement. Tous les inputs sont des
  // event ids Nostr valides (sha256 = 32 bytes = 64 hex chars).
  it('returns 0 for hex starting with 8 (1000)', () => {
    expect(countLeadingZeroBits('8' + 'f'.repeat(63))).toBe(0);
  });

  it('returns 1 for hex starting with 4 (0100)', () => {
    expect(countLeadingZeroBits('4' + 'f'.repeat(63))).toBe(1);
  });

  it('returns 4 for hex starting with 08 (0000 1000)', () => {
    expect(countLeadingZeroBits('08' + 'f'.repeat(62))).toBe(4);
  });

  it('returns 8 for hex starting with 008', () => {
    expect(countLeadingZeroBits('008' + 'f'.repeat(61))).toBe(8);
  });

  it('returns 28 for 7 leading zero hex chars + 8', () => {
    expect(countLeadingZeroBits('00000008' + 'f'.repeat(56))).toBe(28);
  });

  it('returns 0 on non-hex input', () => {
    expect(countLeadingZeroBits('xyz')).toBe(0);
  });

  it('Security C2 — returns 0 on short hex input (anti-PoW-bypass)', () => {
    // Un short input avec leading zeros NE compte PAS comme PoW. Doit
    // return 0 même si '0000' a 16 leading zero bits sémantiquement.
    expect(countLeadingZeroBits('0000')).toBe(0);
    expect(countLeadingZeroBits('00000000')).toBe(0);
    expect(countLeadingZeroBits('0'.repeat(63))).toBe(0); // 1 char short
  });

  it('Security C2 — returns 0 on > 64 chars (defensive)', () => {
    expect(countLeadingZeroBits('0'.repeat(65))).toBe(0);
  });
});

describe('verifyPreimage', () => {
  it('returns true when sha256(preimage) === paymentHash', () => {
    const preimage = 'a'.repeat(64);
    const expectedHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    expect(verifyPreimage(preimage, expectedHash)).toBe(true);
  });

  it('returns false on sha256 mismatch', () => {
    const preimage = 'a'.repeat(64);
    expect(verifyPreimage(preimage, 'b'.repeat(64))).toBe(false);
  });

  it('returns false on malformed preimage', () => {
    expect(verifyPreimage('not-hex', 'a'.repeat(64))).toBe(false);
  });

  it('returns false on malformed payment hash', () => {
    expect(verifyPreimage('a'.repeat(64), 'too-short')).toBe(false);
  });
});

describe('computeSybilWeight', () => {
  const NOW = 1_700_000_000;

  it('minimum weight: no PoW, no identity, no preimage = base only', () => {
    const result = computeSybilWeight({
      event_id: 'f'.repeat(64), // 0 leading zero bits
      identity_first_seen_sec: NOW, // 0 days
      now_sec: NOW,
    });
    expect(result.verified_pow_bits).toBe(0);
    expect(result.pow_factor).toBe(1.0);
    expect(result.identity_age_factor).toBe(1.0);
    expect(result.preimage_factor).toBe(PREIMAGE_FACTOR_NONE);
    expect(result.effective_weight).toBe(BASE_WEIGHT * 1 * 1 * 1);
  });

  it('full PoW factor at 32 bits', () => {
    const result = computeSybilWeight({
      event_id: '00000000' + 'f'.repeat(56), // 32 leading zero bits
      identity_first_seen_sec: NOW,
      now_sec: NOW,
    });
    expect(result.verified_pow_bits).toBe(32);
    expect(result.pow_factor).toBe(MAX_POW_FACTOR);
  });

  it('intermediate PoW factor at 16 bits', () => {
    const result = computeSybilWeight({
      event_id: '0000' + 'f'.repeat(60),
      identity_first_seen_sec: NOW,
      now_sec: NOW,
    });
    expect(result.verified_pow_bits).toBe(16);
    expect(result.pow_factor).toBeCloseTo(1.5, 5); // 1 + 16/32
  });

  it('full identity-age factor at 30 days', () => {
    const result = computeSybilWeight({
      event_id: 'f'.repeat(64),
      identity_first_seen_sec: NOW - 30 * 86400,
      now_sec: NOW,
    });
    expect(result.identity_age_factor).toBe(MAX_AGE_FACTOR);
  });

  it('caps identity-age factor at 2.0 even for very old keys', () => {
    const result = computeSybilWeight({
      event_id: 'f'.repeat(64),
      identity_first_seen_sec: NOW - 365 * 86400,
      now_sec: NOW,
    });
    expect(result.identity_age_factor).toBe(MAX_AGE_FACTOR);
  });

  it('applies preimage factor 2.0 when preimage matches payment_hash', () => {
    const preimage = 'a'.repeat(64);
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    const result = computeSybilWeight({
      event_id: 'f'.repeat(64),
      identity_first_seen_sec: NOW,
      now_sec: NOW,
      preimage_hex: preimage,
      payment_hash_hex: paymentHash,
    });
    expect(result.preimage_verified).toBe(true);
    expect(result.preimage_factor).toBe(PREIMAGE_FACTOR_VALID);
  });

  it('preimage factor stays 1.0 when sha256 mismatch', () => {
    const result = computeSybilWeight({
      event_id: 'f'.repeat(64),
      identity_first_seen_sec: NOW,
      now_sec: NOW,
      preimage_hex: 'a'.repeat(64),
      payment_hash_hex: 'b'.repeat(64), // doesn't match
    });
    expect(result.preimage_verified).toBe(false);
    expect(result.preimage_factor).toBe(PREIMAGE_FACTOR_NONE);
  });

  it('Security C2 — short event id forces pow_factor=1.0 (anti-bypass)', () => {
    // Avant C2 : '0000' avait 16 leading zero bits → pow_factor 1.5.
    // Après C2 : countLeadingZeroBits enforce 64-char → 0 bits.
    const result = computeSybilWeight({
      event_id: '0000',
      identity_first_seen_sec: NOW,
      now_sec: NOW,
    });
    expect(result.verified_pow_bits).toBe(0);
    expect(result.pow_factor).toBe(1.0);
    expect(result.effective_weight).toBe(BASE_WEIGHT);
  });

  it('max weight ≈ 2.4 with all 3 boosts', () => {
    const preimage = 'a'.repeat(64);
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    const result = computeSybilWeight({
      event_id: '00000000' + 'f'.repeat(56), // 32 bits PoW
      identity_first_seen_sec: NOW - 60 * 86400, // 2 months
      now_sec: NOW,
      preimage_hex: preimage,
      payment_hash_hex: paymentHash,
    });
    // 0.3 × 2 × 2 × 2 = 2.4
    expect(result.effective_weight).toBeCloseTo(2.4, 5);
  });
});
