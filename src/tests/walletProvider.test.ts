import { describe, it, expect } from 'vitest';
import { WALLET_PROVIDERS, VALID_PROVIDERS } from '../config/walletProviders';
import { z } from 'zod';

describe('walletProviders config', () => {
  it('contains all expected providers', () => {
    const expected = ['phoenix', 'wos', 'strike', 'blink', 'breez', 'zeus', 'coinos', 'cashapp'];
    for (const p of expected) {
      expect(WALLET_PROVIDERS[p]).toBeDefined();
    }
  });

  it('VALID_PROVIDERS matches WALLET_PROVIDERS keys', () => {
    expect(VALID_PROVIDERS).toEqual(Object.keys(WALLET_PROVIDERS));
  });

  it('all pubkeys are valid 66-char compressed pubkeys', () => {
    for (const [name, pub] of Object.entries(WALLET_PROVIDERS)) {
      expect(pub, `${name} pubkey length`).toHaveLength(66);
      expect(pub, `${name} pubkey prefix`).toMatch(/^(02|03)/);
      expect(pub, `${name} pubkey hex`).toMatch(/^[a-f0-9]{66}$/);
    }
  });

  it('no duplicate pubkeys', () => {
    const pubs = Object.values(WALLET_PROVIDERS);
    expect(new Set(pubs).size).toBe(pubs.length);
  });
});

describe('decideSchema with walletProvider/callerNodePubkey', () => {
  // Re-create the schema here to avoid importing express-dependent modules
  const lnPubkeySchema = z.string().regex(/^(02|03)[a-f0-9]{64}$/, '66-char compressed Lightning pubkey');
  const agentIdentifierSchema = z.string().regex(
    /^(?:[a-f0-9]{64}|(02|03)[a-f0-9]{64})$/,
  );
  const decideSchema = z.object({
    target: agentIdentifierSchema,
    caller: agentIdentifierSchema,
    amountSats: z.number().int().positive().optional(),
    walletProvider: z.enum(VALID_PROVIDERS as [string, ...string[]]).optional(),
    callerNodePubkey: lnPubkeySchema.optional(),
  });

  const validTarget = 'a'.repeat(64);
  const validCaller = 'b'.repeat(64);
  const validPubkey = '03' + 'c'.repeat(64);

  it('accepts request without walletProvider or callerNodePubkey', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller });
    expect(result.success).toBe(true);
  });

  it('accepts valid walletProvider', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, walletProvider: 'phoenix' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.walletProvider).toBe('phoenix');
  });

  it('rejects invalid walletProvider', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, walletProvider: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts valid callerNodePubkey', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, callerNodePubkey: validPubkey });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.callerNodePubkey).toBe(validPubkey);
  });

  it('rejects invalid callerNodePubkey (wrong prefix)', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, callerNodePubkey: '04' + 'c'.repeat(64) });
    expect(result.success).toBe(false);
  });

  it('rejects invalid callerNodePubkey (wrong length)', () => {
    const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, callerNodePubkey: '03' + 'c'.repeat(32) });
    expect(result.success).toBe(false);
  });

  it('accepts both walletProvider and callerNodePubkey (callerNodePubkey takes priority in controller)', () => {
    const result = decideSchema.safeParse({
      target: validTarget, caller: validCaller,
      walletProvider: 'wos', callerNodePubkey: validPubkey,
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid provider names', () => {
    for (const provider of VALID_PROVIDERS) {
      const result = decideSchema.safeParse({ target: validTarget, caller: validCaller, walletProvider: provider });
      expect(result.success, `provider ${provider}`).toBe(true);
    }
  });
});

describe('walletProvider → pubkey resolution', () => {
  function resolveSource(callerNodePubkey?: string, walletProvider?: string): string | undefined {
    return callerNodePubkey ?? (walletProvider ? WALLET_PROVIDERS[walletProvider] : undefined);
  }

  it('callerNodePubkey takes priority over walletProvider', () => {
    const customPubkey = '03' + 'f'.repeat(64);
    expect(resolveSource(customPubkey, 'phoenix')).toBe(customPubkey);
  });

  it('walletProvider resolves to correct pubkey', () => {
    expect(resolveSource(undefined, 'phoenix')).toBe('03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f');
  });

  it('no provider returns undefined', () => {
    expect(resolveSource(undefined, undefined)).toBeUndefined();
  });
});
