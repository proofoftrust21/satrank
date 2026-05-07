// SDK 1.6 AEPS helpers (zero-dep) — pure functions agents use to build
// the canonical bytes that need cryptographic signing. Crypto itself is
// the agent's choice (nostr-tools, noble, etc.) — this module ships the
// scaffolding so the consumer doesn't have to re-derive byte formats.
//
// Two surfaces :
//  1. AEPS §10 outcome message — the canonical bytes BIP-340 oracles
//     attest. Ship the exact 32-byte hash + the canonical UTF-8 string.
//  2. NIP-98 (kind 27235) event template — the {kind, created_at, tags,
//     content} object the agent's signer will finalize. The SDK then
//     base64-encodes the resulting event into the Authorization header.
//
// Both formats are conformance-vector tested ; see
// spec/test-vectors/dispute_outcome.json + the new aepsHelpers tests.
import { createHash } from 'node:crypto';

// ============================================================
// AEPS §10 — Outcome message
// ============================================================

export type AepsOutcome = 'disputant_wins' | 'respondent_wins';

/** Build the canonical-JSON outcome message bytes. Sort-keys recursive,
 *  no whitespace : `{"dispute_id":"<id>","outcome":"<o>","v":"AEPS-§10"}`. */
export function buildOutcomeMessage(
  disputeId: string,
  outcome: AepsOutcome,
): string {
  // Manual canonical build — keys sort alphabetically : dispute_id < outcome < v.
  return (
    '{' +
    `"dispute_id":${JSON.stringify(disputeId)},` +
    `"outcome":${JSON.stringify(outcome)},` +
    `"v":${JSON.stringify('AEPS-§10')}` +
    '}'
  );
}

/** SHA-256 of the canonical bytes — the 32 bytes BIP-340 must sign. */
export function buildOutcomeMessageHash(
  disputeId: string,
  outcome: AepsOutcome,
): { hashHex: string; hashBytes: Buffer; canonical: string } {
  const canonical = buildOutcomeMessage(disputeId, outcome);
  const hashBytes = createHash('sha256').update(canonical, 'utf8').digest();
  return { hashHex: hashBytes.toString('hex'), hashBytes, canonical };
}

// ============================================================
// NIP-98 (kind 27235) — HTTP authentication
// ============================================================

export interface Nip98Template {
  kind: 27235;
  created_at: number;
  tags: string[][];
  content: '';
}

export interface Nip98SignedEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface BuildNip98Input {
  /** Canonical URL (matches `req.originalUrl` server-side). MUST equal the
   *  endpoint the SDK will hit ; the SDK provides `disputeEndpoint()`,
   *  `attestationEndpoint(id)`, etc. */
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request body bytes, exactly as serialized on the wire. The SDK
   *  serializes via `JSON.stringify(stripUndefined(body))` — agents
   *  computing the payload hash must use the SAME body string. */
  body?: string | Buffer | null;
  /** Override created_at (epoch sec). Defaults to now. Useful when the
   *  same request body is signed twice (replay cache requires distinct
   *  event ids ; bumping created_at is the standard workaround). */
  createdAt?: number;
}

/** Build a kind 27235 event template ready to sign. The agent's BIP-340
 *  Schnorr signer (nostr-tools, noble, etc.) consumes this and produces
 *  a SignedEvent. */
export function buildNip98EventTemplate(input: BuildNip98Input): Nip98Template {
  const tags: string[][] = [
    ['u', input.url],
    ['method', input.method],
  ];
  if (input.body !== null && input.body !== undefined) {
    const bytes = typeof input.body === 'string'
      ? Buffer.from(input.body, 'utf8')
      : input.body;
    if (bytes.length > 0) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      tags.push(['payload', hash]);
    }
  }
  return {
    kind: 27235,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** Encode a finalized NIP-98 event as the Authorization header value :
 *  `Nostr <base64-of-JSON-event>`. */
export function encodeNip98AuthHeader(signed: Nip98SignedEvent): string {
  const json = JSON.stringify(signed);
  return `Nostr ${Buffer.from(json, 'utf8').toString('base64')}`;
}
