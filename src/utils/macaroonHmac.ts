// HMAC-SHA256 macaroon synthétique — scellage anti-tampering pour le flow L402
// natif (Phase 14D.3.0).
//
// Le macaroon est un JWT-like structuré : base64url(payload) + "." + base64url(hmac).
// Pas de capability chains à la libmacaroon (flat pricing, une clé root unique).
//
// Format payload (version 1) :
//   { v: 1, ph: "<payment_hash hex>", ca: <unix s>, ps: <price sats>, rt: "<route>", tt: <ttl s> }
//
// Verification : recompute HMAC, compare timing-safe, puis verifie version + expiration.

import crypto from 'crypto';

export const MACAROON_VERSION = 1;

export interface MacaroonPayload {
  v: 1;
  ph: string;
  ca: number;
  ps: number;
  rt: string;
  tt: number;
}

export type MacaroonVerifyError =
  | 'MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'VERSION_UNSUPPORTED'
  | 'EXPIRED';

export type MacaroonVerifyResult =
  | { ok: true; payload: MacaroonPayload }
  | { ok: false; error: MacaroonVerifyError };

export function encodeMacaroon(payload: MacaroonPayload, secret: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${sig.toString('base64url')}`;
}

export function verifyMacaroon(
  token: string,
  secret: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MacaroonVerifyResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'MALFORMED' };
  }

  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return { ok: false, error: 'MALFORMED' };
  }
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, error: 'SIGNATURE_INVALID' };
  }
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, error: 'SIGNATURE_INVALID' };
  }

  let payloadObj: unknown;
  try {
    payloadObj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
  if (!isMacaroonPayload(payloadObj)) {
    return { ok: false, error: 'MALFORMED' };
  }
  if (payloadObj.v !== MACAROON_VERSION) {
    return { ok: false, error: 'VERSION_UNSUPPORTED' };
  }
  if (payloadObj.ca + payloadObj.tt < nowSeconds) {
    return { ok: false, error: 'EXPIRED' };
  }
  return { ok: true, payload: payloadObj };
}

function isMacaroonPayload(v: unknown): v is MacaroonPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.v === 'number' &&
    typeof o.ph === 'string' && /^[a-f0-9]{64}$/i.test(o.ph) &&
    typeof o.ca === 'number' && Number.isFinite(o.ca) && o.ca >= 0 &&
    typeof o.ps === 'number' && Number.isFinite(o.ps) && o.ps >= 0 &&
    typeof o.rt === 'string' && o.rt.length > 0 && o.rt.length <= 200 &&
    typeof o.tt === 'number' && Number.isFinite(o.tt) && o.tt > 0
  );
}
