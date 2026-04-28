// Phase 6.0 — verify offline une trust assertion ou calibration event publié
// par un oracle SatRank-compatible. Pure function, pas d'I/O réseau.
//
// Vérifications (en cascade, toutes doivent passer pour valid=true) :
//   1. Schema kind ∈ {30782 (transferable assertion), 30783 (calibration)}
//   2. d-tag présent (NIP-33 addressable replaceable requirement)
//   3. Schnorr signature valide via verifyEvent (recompute id + verify sig)
//   4. expected_oracle_pubkey match (optionnel)
//   5. valid_until > now_sec (kind 30782) OU window_end + 14d > now_sec (30783)
//
// L'agent reçoit un objet structuré avec issues[] pour comprendre POURQUOI
// l'assertion est rejetée — utile pour debug + retry policy.
// @ts-expect-error — moduleResolution "node" can't resolve ESM subpath nostr-tools/pure.
// Suit le pattern existant dans dvm.ts / nostrIndexedPublisher.ts.
import { verifyEvent } from 'nostr-tools/pure';

export interface AssertionEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface VerifyAssertionOptions {
  expected_oracle_pubkey?: string;
  now_sec?: number;
}

export interface VerifyAssertionResult {
  valid: boolean;
  kind: number;
  oracle_pubkey: string;
  created_at: number;
  valid_until: number | null;
  now_sec: number;
  issues: string[];
}

const SUPPORTED_KINDS = [30782, 30783] as const;
const CALIBRATION_TTL_DAYS = 14;

export function verifyAssertion(
  event: AssertionEvent,
  options: VerifyAssertionOptions = {},
): VerifyAssertionResult {
  const nowSec = options.now_sec ?? Math.floor(Date.now() / 1000);
  const issues: string[] = [];

  if (!SUPPORTED_KINDS.includes(event.kind as 30782 | 30783)) {
    issues.push('kind_unsupported');
  }

  const dTag = event.tags.find((t) => t[0] === 'd');
  if (!dTag || !dTag[1]) {
    issues.push('missing_d_tag');
  }

  // verifyEvent : recompute id + check Schnorr sig. Si event mal formé,
  // peut throw — on attrape pour produire signature_invalid.
  let sigOk = false;
  try {
    sigOk = verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0]);
  } catch {
    sigOk = false;
  }
  if (!sigOk) issues.push('signature_invalid');

  if (
    options.expected_oracle_pubkey &&
    event.pubkey !== options.expected_oracle_pubkey
  ) {
    issues.push('oracle_pubkey_mismatch');
  }

  const validUntilTag = event.tags.find((t) => t[0] === 'valid_until');
  const windowEndTag = event.tags.find((t) => t[0] === 'window_end');
  let validUntil: number | null = null;
  if (validUntilTag && validUntilTag[1]) {
    validUntil = Number(validUntilTag[1]);
  } else if (windowEndTag && windowEndTag[1]) {
    validUntil = Number(windowEndTag[1]) + CALIBRATION_TTL_DAYS * 86400;
  }
  if (
    validUntil !== null &&
    Number.isFinite(validUntil) &&
    validUntil < nowSec
  ) {
    issues.push('expired');
  }

  return {
    valid: issues.length === 0,
    kind: event.kind,
    oracle_pubkey: event.pubkey,
    created_at: event.created_at,
    valid_until: validUntil,
    now_sec: nowSec,
    issues,
  };
}
