// C1 smoke test — structure compiles, public exports exist, SatRank
// constructor validates apiBase. Logic tests land in C2-C8.
import { describe, it, expect } from 'vitest';
import {
  SatRank,
  SatRankError,
  ValidationSatRankError,
  WalletError,
} from '../src/index';

describe('SDK 1.0 — scaffolding', () => {
  it('exports SatRank and the error hierarchy', () => {
    expect(SatRank).toBeDefined();
    expect(SatRankError).toBeDefined();
    expect(new ValidationSatRankError('bad')).toBeInstanceOf(SatRankError);
  });

  it('SatRank constructor trims trailing slash from apiBase', () => {
    const sr = new SatRank({ apiBase: 'https://satrank.dev/' });
    expect(sr._options().apiBase).toBe('https://satrank.dev');
  });

  it('rejects empty apiBase', () => {
    expect(() => new SatRank({ apiBase: '' })).toThrow(/apiBase is required/);
  });

  it('fulfill / listCategories / resolveIntent all throw not-implemented in C1', async () => {
    const sr = new SatRank({ apiBase: 'https://satrank.dev' });
    await expect(
      sr.fulfill({ intent: { category: 'data' }, budget_sats: 10 }),
    ).rejects.toThrow(/not implemented/);
    await expect(sr.listCategories()).rejects.toThrow(/not implemented/);
    await expect(sr.resolveIntent({ category: 'data' })).rejects.toThrow(
      /not implemented/,
    );
  });

  it('WalletError is a plain Error subclass (not a SatRankError)', () => {
    const err = new WalletError('no route', 'NO_ROUTE');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SatRankError);
    expect(err.code).toBe('NO_ROUTE');
  });
});
