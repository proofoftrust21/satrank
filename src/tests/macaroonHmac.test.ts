// Tests HMAC-SHA256 macaroon (encode/verify) — Phase 14D.3.0.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  encodeMacaroon,
  verifyMacaroon,
  MACAROON_VERSION,
  type MacaroonPayload,
} from '../utils/macaroonHmac';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
const OTHER_SECRET = Buffer.from('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', 'hex');

function validPayload(overrides: Partial<MacaroonPayload> = {}): MacaroonPayload {
  return {
    v: 1,
    ph: 'a'.repeat(64),
    ca: 1_700_000_000,
    ps: 1,
    rt: '/api/agent/:hash',
    tt: 2_592_000,
    ...overrides,
  };
}

describe('macaroonHmac', () => {
  describe('encodeMacaroon + verifyMacaroon roundtrip', () => {
    it('encodes and verifies a valid payload', () => {
      const payload = validPayload();
      const token = encodeMacaroon(payload, SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(payload);
      }
    });

    it('produces deterministic output for the same input', () => {
      const payload = validPayload();
      const a = encodeMacaroon(payload, SECRET);
      const b = encodeMacaroon(payload, SECRET);
      expect(a).toBe(b);
    });

    it('produces different output for different secrets', () => {
      const payload = validPayload();
      const a = encodeMacaroon(payload, SECRET);
      const b = encodeMacaroon(payload, OTHER_SECRET);
      expect(a).not.toBe(b);
    });
  });

  describe('tampering detection', () => {
    it('rejects a token whose payload has been tampered with', () => {
      const payload = validPayload();
      const token = encodeMacaroon(payload, SECRET);
      const dotIdx = token.indexOf('.');
      const tamperedPayload: MacaroonPayload = { ...payload, ps: 9999 };
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
      const tamperedToken = `${tamperedPayloadB64}.${token.slice(dotIdx + 1)}`;
      const result = verifyMacaroon(tamperedToken, SECRET, payload.ca + 10);
      expect(result).toEqual({ ok: false, error: 'SIGNATURE_INVALID' });
    });

    it('rejects a token whose signature has been tampered with', () => {
      const payload = validPayload();
      const token = encodeMacaroon(payload, SECRET);
      const dotIdx = token.indexOf('.');
      const payloadB64 = token.slice(0, dotIdx);
      const forgedSig = crypto.randomBytes(32).toString('base64url');
      const tamperedToken = `${payloadB64}.${forgedSig}`;
      const result = verifyMacaroon(tamperedToken, SECRET, payload.ca + 10);
      expect(result).toEqual({ ok: false, error: 'SIGNATURE_INVALID' });
    });

    it('rejects a token signed with a different secret', () => {
      const payload = validPayload();
      const token = encodeMacaroon(payload, OTHER_SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + 10);
      expect(result).toEqual({ ok: false, error: 'SIGNATURE_INVALID' });
    });

    it('rejects when signature length differs from expected', () => {
      const payload = validPayload();
      const token = encodeMacaroon(payload, SECRET);
      const dotIdx = token.indexOf('.');
      const shortSig = Buffer.from('short').toString('base64url');
      const malformedToken = `${token.slice(0, dotIdx)}.${shortSig}`;
      const result = verifyMacaroon(malformedToken, SECRET, payload.ca + 10);
      expect(result).toEqual({ ok: false, error: 'SIGNATURE_INVALID' });
    });
  });

  describe('expiration', () => {
    it('rejects a macaroon past its TTL', () => {
      const payload = validPayload({ ca: 1_700_000_000, tt: 60 });
      const token = encodeMacaroon(payload, SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + payload.tt + 1);
      expect(result).toEqual({ ok: false, error: 'EXPIRED' });
    });

    it('accepts a macaroon exactly at the TTL edge (ca + tt === now)', () => {
      const payload = validPayload({ ca: 1_700_000_000, tt: 60 });
      const token = encodeMacaroon(payload, SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + payload.tt);
      expect(result.ok).toBe(true);
    });

    it('accepts a macaroon just before the TTL edge', () => {
      const payload = validPayload({ ca: 1_700_000_000, tt: 60 });
      const token = encodeMacaroon(payload, SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + payload.tt - 1);
      expect(result.ok).toBe(true);
    });
  });

  describe('version gating', () => {
    it('rejects a macaroon with an unsupported version', () => {
      // Use a cast since the type forces v:1; we want to test the runtime guard.
      const payload = { ...validPayload(), v: 2 } as unknown as MacaroonPayload;
      const token = encodeMacaroon(payload, SECRET);
      const result = verifyMacaroon(token, SECRET, payload.ca + 10);
      expect(result).toEqual({ ok: false, error: 'VERSION_UNSUPPORTED' });
    });

    it('exports MACAROON_VERSION = 1', () => {
      expect(MACAROON_VERSION).toBe(1);
    });
  });

  describe('malformed input', () => {
    it('rejects an empty string', () => {
      const result = verifyMacaroon('', SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a token with no dot separator', () => {
      const result = verifyMacaroon('abcdef', SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a token that starts with a dot (empty payload half)', () => {
      const result = verifyMacaroon('.abc', SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a token that ends with a dot (empty signature half)', () => {
      const result = verifyMacaroon('abc.', SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload that does not decode to valid JSON', () => {
      const badPayloadB64 = Buffer.from('not-json-at-all').toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(badPayloadB64).digest();
      const token = `${badPayloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload whose shape is wrong (missing fields)', () => {
      const bogus = { v: 1, ph: 'a'.repeat(64) };
      const payloadB64 = Buffer.from(JSON.stringify(bogus)).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload with non-hex payment_hash', () => {
      const bogus = { ...validPayload(), ph: 'Z'.repeat(64) };
      const payloadB64 = Buffer.from(JSON.stringify(bogus)).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload with negative ps (price)', () => {
      const bogus = { ...validPayload(), ps: -1 };
      const payloadB64 = Buffer.from(JSON.stringify(bogus)).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload with zero tt (ttl)', () => {
      const bogus = { ...validPayload(), tt: 0 };
      const payloadB64 = Buffer.from(JSON.stringify(bogus)).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });

    it('rejects a payload whose route is empty', () => {
      const bogus = { ...validPayload(), rt: '' };
      const payloadB64 = Buffer.from(JSON.stringify(bogus)).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString('base64url')}`;
      const result = verifyMacaroon(token, SECRET);
      expect(result).toEqual({ ok: false, error: 'MALFORMED' });
    });
  });
});
