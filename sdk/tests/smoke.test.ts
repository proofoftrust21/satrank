// Structural smoke — validates public exports and constructor guardrails.
// Behavior tests live in the per-feature test files (apiClient, bolt11, ...).
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
    const sr = new SatRank({
      apiBase: 'https://satrank.dev/',
      fetch: () => Promise.resolve(new Response('{}')),
    });
    expect(sr._options().apiBase).toBe('https://satrank.dev');
  });

  it('rejects empty apiBase', () => {
    expect(
      () =>
        new SatRank({
          apiBase: '',
          fetch: () => Promise.resolve(new Response('{}')),
        }),
    ).toThrow(/apiBase is required/);
  });

  it('fulfill rejects invalid inputs at the boundary', async () => {
    const sr = new SatRank({
      apiBase: 'https://satrank.dev',
      fetch: () => Promise.resolve(new Response('{}')),
    });
    // @ts-expect-error deliberately wrong shape
    await expect(sr.fulfill({ budget_sats: 10 })).rejects.toThrow(
      /intent\.category/,
    );
    await expect(
      sr.fulfill({ intent: { category: 'data' }, budget_sats: 0 }),
    ).rejects.toThrow(/budget_sats must be > 0/);
  });

  it('WalletError is a plain Error subclass (not a SatRankError)', () => {
    const err = new WalletError('no route', 'NO_ROUTE');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SatRankError);
    expect(err.code).toBe('NO_ROUTE');
  });
});
