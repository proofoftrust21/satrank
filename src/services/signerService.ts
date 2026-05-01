// Phase 8.1 (2026-05-01) — Ed25519 signing service for evidence receipts.
//
// SatRank's identity is rooted in an Ed25519 keypair loaded from env :
//   SATRANK_SIGNING_SK = 64-char hex private key (32 bytes)
//   SATRANK_SIGNING_PK = 64-char hex public key (derived; auto-checked at boot)
// If either is missing, signing is disabled and EvidenceService returns 503.
//
// Public key is published at /api/.well-known/satrank-key so verifiers can
// validate signatures offline against a published, well-known identity.
//
// Why no KMS for v1: keypair is small enough (32 bytes) to live encrypted at
// rest in env (.env.production already chmod 600). KMS is a Phase 8.1.1
// upgrade if regulators ask. The cryptographic primitive is Ed25519 (RFC 8032),
// chosen over secp256k1 because (a) it has a unique well-defined signature
// per message, (b) verifier libraries are universal, (c) no nonce ceremony.
import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { logger } from '../logger';

export interface SignerServiceOptions {
  privateKeyHex?: string;
  publicKeyHex?: string;
}

export interface SignedPayload {
  /** Canonical JSON of the message that was signed (UTF-8 bytes hashed). */
  payload_canonical: string;
  /** sha256 hex of payload_canonical bytes — included so verifiers don't
   *  need to recompute (and have a stable hash to put in audit log). */
  payload_sha256: string;
  /** Base64 Ed25519 signature over payload_canonical bytes. */
  signature: string;
  /** Hex public key the verifier should use. */
  satrank_pubkey: string;
  /** ISO 8601 UTC timestamp when this signature was produced. */
  signed_at: string;
}

export class SignerService {
  private readonly sk: Uint8Array | null;
  private readonly pk: Uint8Array | null;

  constructor(opts: SignerServiceOptions = {}) {
    const skHex = opts.privateKeyHex ?? process.env.SATRANK_SIGNING_SK ?? '';
    const pkHex = opts.publicKeyHex ?? process.env.SATRANK_SIGNING_PK ?? '';
    if (!skHex || !pkHex) {
      logger.warn('SignerService: SATRANK_SIGNING_SK / SATRANK_SIGNING_PK not set — evidence signing disabled');
      this.sk = null;
      this.pk = null;
      return;
    }
    if (skHex.length !== 64 || !/^[0-9a-f]+$/i.test(skHex)) {
      logger.error('SignerService: SATRANK_SIGNING_SK must be 64-char hex (32 bytes)');
      this.sk = null;
      this.pk = null;
      return;
    }
    if (pkHex.length !== 64 || !/^[0-9a-f]+$/i.test(pkHex)) {
      logger.error('SignerService: SATRANK_SIGNING_PK must be 64-char hex (32 bytes)');
      this.sk = null;
      this.pk = null;
      return;
    }
    const sk = Buffer.from(skHex, 'hex');
    const derivedPk = ed25519.getPublicKey(sk);
    const expectedPk = Buffer.from(pkHex, 'hex');
    if (Buffer.compare(derivedPk, expectedPk) !== 0) {
      logger.error('SignerService: derived public key does not match SATRANK_SIGNING_PK — refusing to load');
      this.sk = null;
      this.pk = null;
      return;
    }
    this.sk = sk;
    this.pk = expectedPk;
    logger.info({ pk_first8: pkHex.slice(0, 8) }, 'SignerService: signing key loaded');
  }

  isAvailable(): boolean {
    return this.sk !== null && this.pk !== null;
  }

  publicKeyHex(): string | null {
    return this.pk ? Buffer.from(this.pk).toString('hex') : null;
  }

  /** Sign a canonical-JSON payload. Caller is responsible for canonicalizing
   *  the message (deterministic key order, no whitespace) — this method does
   *  not transform the input. Returns the SignedPayload bundle ; the canonical
   *  JSON + sha256 are echoed so the caller can persist them next to the
   *  signature without re-canonicalizing. */
  sign(payloadCanonical: string): SignedPayload {
    if (!this.sk || !this.pk) {
      throw new Error('SignerService not available — cannot sign');
    }
    const bytes = Buffer.from(payloadCanonical, 'utf8');
    const sig = ed25519.sign(bytes, this.sk);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      payload_canonical: payloadCanonical,
      payload_sha256: sha256,
      signature: Buffer.from(sig).toString('base64'),
      satrank_pubkey: Buffer.from(this.pk).toString('hex'),
      signed_at: new Date().toISOString(),
    };
  }

  /** Verify a signature with the loaded public key. Used by tests + an
   *  optional self-check at startup. Returns true on valid signature. */
  verify(payloadCanonical: string, signatureBase64: string, pubkeyHex?: string): boolean {
    const pkBytes = pubkeyHex
      ? Buffer.from(pubkeyHex, 'hex')
      : (this.pk ?? Buffer.alloc(0));
    if (pkBytes.length !== 32) return false;
    try {
      const sig = Buffer.from(signatureBase64, 'base64');
      return ed25519.verify(sig, Buffer.from(payloadCanonical, 'utf8'), pkBytes);
    } catch {
      return false;
    }
  }
}

/** Helper for ops to bootstrap a fresh keypair locally. Not used by the
 *  app at runtime — call from a CLI script or tests when generating env vars. */
export function generateSigningKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const sk = randomBytes(32);
  const pk = ed25519.getPublicKey(sk);
  return {
    privateKeyHex: Buffer.from(sk).toString('hex'),
    publicKeyHex: Buffer.from(pk).toString('hex'),
  };
}

/** Audit L1 (2026-05-01) — typed error so the caller can fail fast on
 *  un-serializable values rather than silently colliding. JSON.stringify
 *  maps NaN / Infinity / -Infinity all to `null`, so two distinct payloads
 *  could produce identical canonical bytes ⇒ identical signature. The
 *  signer service is strict : reject these values up-front. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** Canonical JSON: deterministic key order, no whitespace, sorted Object
 *  keys at every depth, arrays preserved order. Numbers serialize via JSON.
 *  Used by EvidenceService so two implementations of the same payload
 *  hash to the same sha256. Rejects NaN/Infinity (collision risk) and
 *  bigint/undefined/symbol (not JSON-serializable). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalJsonError(`non-finite number ${String(value)} cannot be canonicalized`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new CanonicalJsonError('bigint cannot be canonicalized — convert to string first');
  }
  if (t === 'undefined' || t === 'symbol' || t === 'function') {
    throw new CanonicalJsonError(`${t} cannot be canonicalized`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
