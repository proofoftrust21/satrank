// Phase 8.1 — SignerService unit tests.
import { describe, it, expect } from 'vitest';
import { SignerService, generateSigningKeypair, canonicalJson } from '../services/signerService';
import { ed25519 } from '@noble/curves/ed25519.js';

describe('SignerService (Phase 8.1)', () => {
  it('isAvailable=false when env vars missing', () => {
    const s = new SignerService({});
    expect(s.isAvailable()).toBe(false);
  });

  it('rejects mismatched private/public keys', () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const s = new SignerService({ privateKeyHex: a.privateKeyHex, publicKeyHex: b.publicKeyHex });
    expect(s.isAvailable()).toBe(false);
  });

  it('signs + verifies a payload round-trip', () => {
    const kp = generateSigningKeypair();
    const s = new SignerService({ privateKeyHex: kp.privateKeyHex, publicKeyHex: kp.publicKeyHex });
    expect(s.isAvailable()).toBe(true);
    const payload = JSON.stringify({ a: 1, b: 'hello' });
    const signed = s.sign(payload);
    expect(signed.satrank_pubkey).toBe(kp.publicKeyHex);
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(s.verify(payload, signed.signature)).toBe(true);
    // Tampering the payload breaks the verification.
    expect(s.verify(payload + ' tamper', signed.signature)).toBe(false);
  });

  it('verify works with externally-supplied pubkey (offline pattern)', () => {
    const kp = generateSigningKeypair();
    const s = new SignerService({ privateKeyHex: kp.privateKeyHex, publicKeyHex: kp.publicKeyHex });
    const signed = s.sign('test');
    // Simulate a verifier with no signer service — just the pubkey + signature.
    const sigBytes = Buffer.from(signed.signature, 'base64');
    const pkBytes = Buffer.from(kp.publicKeyHex, 'hex');
    expect(ed25519.verify(sigBytes, Buffer.from('test', 'utf8'), pkBytes)).toBe(true);
  });

  it('canonicalJson sorts keys deterministically at every depth', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ b: { y: 2, x: 1 }, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"b":{"x":1,"y":2}}');
    // Same logical content, different input key order ⇒ identical bytes.
    const c1 = canonicalJson({ a: 1, b: { c: 2, d: 3 } });
    const c2 = canonicalJson({ b: { d: 3, c: 2 }, a: 1 });
    expect(c1).toBe(c2);
  });

  it('canonicalJson handles null + primitives + arrays', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');  // arrays preserve order
  });
});
