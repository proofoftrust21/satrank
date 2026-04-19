// Covers the minimal amount decoder used by budget enforcement. Known vectors
// taken from BOLT-11 appendix (lnbc) and widely-used test harnesses (lntb).
import { describe, it, expect } from 'vitest';
import { decodeBolt11Amount, decodeBolt11 } from '../src/bolt11';

describe('bolt11 amount decoder', () => {
  it('decodes lnbc25m... → 2_500_000 sats', () => {
    const sats = decodeBolt11Amount(
      'lnbc25m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5vdhkven9v5sxyetpdees9q5sqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    );
    expect(sats).toBe(2_500_000);
  });

  it('decodes lnbc100u... → 10_000 sats', () => {
    const sats = decodeBolt11Amount('lnbc100u1pqqqqqq1abcdefg');
    expect(sats).toBe(10_000);
  });

  it('decodes lntb10u... → 1000 sats (testnet)', () => {
    const decoded = decodeBolt11(
      'lntb10u1pqqqqqq1abcdefg',
    );
    expect(decoded).toEqual({ amount_sats: 1_000, chain: 'tb' });
  });

  it('returns null for amountless invoice (no digits before mult)', () => {
    const sats = decodeBolt11Amount('lnbc1pabcdefg');
    expect(sats).toBeNull();
  });

  it('returns null for sub-sat amount (lnbc1n = 0.1 sat)', () => {
    const sats = decodeBolt11Amount('lnbc1n1pabcdefg');
    expect(sats).toBeNull();
  });

  it('accepts lnbc10n (= 1 sat — integer round-trip)', () => {
    const sats = decodeBolt11Amount('lnbc10n1pabcdefg');
    expect(sats).toBe(1);
  });

  it('throws on invalid prefix', () => {
    expect(() => decodeBolt11Amount('not-an-invoice')).toThrow(/Invalid BOLT11/);
    expect(() => decodeBolt11Amount('lnxx100u1abcdefg')).toThrow();
  });

  it('is case-insensitive on input', () => {
    const upper = decodeBolt11Amount('LNBC100U1PQQQQQQ1ABCDEFG');
    expect(upper).toBe(10_000);
  });
});
