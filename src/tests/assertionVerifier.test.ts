// Phase 6.0 — verify_assertion : tests purs avec events Nostr réels signés.
import { describe, it, expect } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
// nostr-tools / @noble use crypto.getRandomValues for signing nonces. Vitest's
// node env doesn't expose it by default — polyfill before importing modules
// that pull in @noble/curves.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
// @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { verifyAssertion } from '../utils/assertionVerifier';

// Test keys : random bytes via node:crypto (vitest n'expose pas
// crypto.getRandomValues sans polyfill). 32 bytes valides pour secp256k1
// avec quasi-certitude > 2^-128 — acceptable pour des tests unitaires.
const ORACLE_SK = new Uint8Array(randomBytes(32));
const OTHER_SK = new Uint8Array(randomBytes(32));

function signEvent(sk: Uint8Array, kind: number, tags: string[][], content: string, createdAt: number) {
  const template = { kind, created_at: createdAt, tags, content } as Parameters<typeof finalizeEvent>[0];
  return finalizeEvent(template, sk) as {
    id: string; pubkey: string; created_at: number; kind: number;
    tags: string[][]; content: string; sig: string;
  };
}

describe('verifyAssertion (Phase 6.0)', () => {
  it('valid kind 30782 trust assertion → passes all checks', () => {
    const now = 1_700_000_000;
    const validUntil = now + 3600;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [
        ['d', 'satrank-trust:abc123'],
        ['valid_until', String(validUntil)],
        ['p_e2e', '0.85'],
      ],
      JSON.stringify({ p_e2e: 0.85, n_obs: 50 }),
      now,
    );
    const result = verifyAssertion(event, { now_sec: now });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.kind).toBe(30782);
    expect(result.valid_until).toBe(validUntil);
  });

  it('valid kind 30783 calibration event → window_end + 14d as TTL', () => {
    const now = 1_700_000_000;
    const windowEnd = now - 86400; // ended yesterday — TTL = +14 days
    const event = signEvent(
      ORACLE_SK,
      30783,
      [
        ['d', 'satrank-calibration'],
        ['window_end', String(windowEnd)],
        ['delta_mean', '0.0345'],
      ],
      JSON.stringify({ aggregate: { delta_mean: 0.0345 } }),
      now,
    );
    const result = verifyAssertion(event, { now_sec: now });
    expect(result.valid).toBe(true);
    expect(result.valid_until).toBe(windowEnd + 14 * 86400);
  });

  it('expired assertion → issue "expired"', () => {
    const now = 1_700_000_000;
    const validUntil = now - 60; // expired 1 min ago
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['d', 'satrank-trust:expired'], ['valid_until', String(validUntil)]],
      '{}',
      now,
    );
    const result = verifyAssertion(event, { now_sec: now });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('expired');
  });

  it('signature tampered → signature_invalid', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['d', 'satrank-trust:tampered'], ['valid_until', String(now + 3600)]],
      'original',
      now,
    );
    // nostr-tools cache le résultat verifyEvent dans un Symbol enumerable
    // sur l'event. Object spread le copierait → verify retourne true cached.
    // JSON-roundtrip strip les Symbol-keyed properties.
    const flipped = event.sig.startsWith('a')
      ? 'b' + event.sig.slice(1)
      : 'a' + event.sig.slice(1);
    const tampered = JSON.parse(JSON.stringify({ ...event, sig: flipped }));
    const result = verifyAssertion(tampered, { now_sec: now });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('signature_invalid');
  });

  it('expected oracle pubkey mismatch → oracle_pubkey_mismatch', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['d', 'satrank-trust:wrong-oracle'], ['valid_until', String(now + 3600)]],
      '{}',
      now,
    );
    const expectedOther = getPublicKey(OTHER_SK) as string;
    const result = verifyAssertion(event, { now_sec: now, expected_oracle_pubkey: expectedOther });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('oracle_pubkey_mismatch');
  });

  it('expected oracle pubkey match → passes', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['d', 'satrank-trust:match'], ['valid_until', String(now + 3600)]],
      '{}',
      now,
    );
    const expectedSame = getPublicKey(ORACLE_SK) as string;
    const result = verifyAssertion(event, { now_sec: now, expected_oracle_pubkey: expectedSame });
    expect(result.valid).toBe(true);
  });

  it('unsupported kind → kind_unsupported', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30382, // node endorsement, not 30782/30783
      [['d', 'whatever']],
      '{}',
      now,
    );
    const result = verifyAssertion(event, { now_sec: now });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('kind_unsupported');
  });

  it('missing d-tag → missing_d_tag', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['valid_until', String(now + 3600)]], // no d
      '{}',
      now,
    );
    const result = verifyAssertion(event, { now_sec: now });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('missing_d_tag');
  });

  it('multi-failure: sig invalid + expired + wrong oracle → all 3 issues reported', () => {
    const now = 1_700_000_000;
    const event = signEvent(
      ORACLE_SK,
      30782,
      [['d', 'satrank-trust:multifail'], ['valid_until', String(now - 60)]],
      'original',
      now,
    );
    const expectedOther = getPublicKey(OTHER_SK) as string;
    const flipped = event.sig.startsWith('0') ? '1' + event.sig.slice(1) : '0' + event.sig.slice(1);
    const tampered = JSON.parse(JSON.stringify({ ...event, sig: flipped }));
    const result = verifyAssertion(tampered, {
      now_sec: now,
      expected_oracle_pubkey: expectedOther,
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining(['signature_invalid', 'expired', 'oracle_pubkey_mismatch']),
    );
  });
});
