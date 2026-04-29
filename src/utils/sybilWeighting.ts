// Phase 8.1 — Sybil-resistant weighting for crowd outcome events (kind 7402).
//
// Pure functions, no I/O. Calcule effective_weight pour un report selon :
//   1. PoW bits (NIP-13) — vérifiés via leading-zeros count sur l'event id
//   2. Identity age — temps écoulé depuis first_seen de la pubkey
//   3. Preimage proof — sha256(preimage) == payment_hash ?
//
// Formule :
//   weight = base × pow_factor × age_factor × preimage_factor
//
// base = 0.3 (faible — un report anonyme < probe SatRank weight=1)
// pow_factor       = min(2.0, 1.0 + verified_bits / 32)    (28b → 1.875 ; 0b → 1.0)
// age_factor       = min(2.0, 1.0 + days / 30)             (30j → 2.0 ; 0j → 1.0)
// preimage_factor  = 2.0 si preimage valide, 1.0 sinon
//
// Borne max théorique ≈ 0.3 × 2 × 2 × 2 = 2.4 (≈ paid probe SatRank weight=2).
import { createHash } from 'node:crypto';

export const BASE_WEIGHT = 0.3;
export const POW_BITS_FOR_FULL_FACTOR = 32;
export const AGE_DAYS_FOR_FULL_FACTOR = 30;
export const MAX_POW_FACTOR = 2.0;
export const MAX_AGE_FACTOR = 2.0;
export const PREIMAGE_FACTOR_VALID = 2.0;
export const PREIMAGE_FACTOR_NONE = 1.0;

export interface SybilWeightInput {
  /** Event id (32-byte hex). Sert à compter les leading zero bits réels. */
  event_id: string;
  /** Bits déclarés par le tag pow=. Le verified_bits réel est calculé depuis
   *  l'event_id ; declared est juste informatif (peut diverger du réel
   *  si l'agent a triché ou mal calculé). */
  declared_pow_bits?: number;
  /** Epoch seconds — first_seen de la pubkey de l'agent. null = première
   *  observation, age_factor = 1.0. */
  identity_first_seen_sec: number | null;
  /** Epoch seconds courant (now). Injectable pour tests. */
  now_sec: number;
  /** Hex preimage du paiement (optional). */
  preimage_hex?: string;
  /** Hex payment_hash référencé (optional). */
  payment_hash_hex?: string;
}

export interface SybilWeightResult {
  effective_weight: number;
  pow_factor: number;
  identity_age_factor: number;
  preimage_factor: number;
  verified_pow_bits: number;
  preimage_verified: boolean;
}

/** Compte les leading zero bits dans un hex 32-byte event id. Un event id
 *  avec N leading zero bits = NIP-13 PoW de N bits. Matche l'algorithme
 *  utilisé dans src/nostr/pow.ts (zapMiner).
 *
 *  Security C2 — enforce strict 64-char length. Une id plus courte
 *  permettrait de claim des bits inflated (ex. "0000" = 16 bits avec
 *  pow_factor=1.5 sans aucun PoW réel). Nostr event ids sont toujours
 *  sha256 = 32 bytes = 64 hex chars. */
export function countLeadingZeroBits(hexId: string): number {
  if (!/^[a-f0-9]{64}$/i.test(hexId)) return 0;
  let count = 0;
  for (let i = 0; i < hexId.length; i++) {
    const nibble = parseInt(hexId[i], 16);
    if (nibble === 0) {
      count += 4;
      continue;
    }
    // Leading zero bits dans un nibble non-zéro = 4 - bit_length.
    // ex. nibble = 1 (0001) → 3 leading zero bits dans ce nibble.
    if (nibble >= 8) return count;        // 1xxx
    if (nibble >= 4) return count + 1;    // 01xx
    if (nibble >= 2) return count + 2;    // 001x
    return count + 3;                      // 0001
  }
  return count;
}

/** Vérifie qu'un preimage hex 32-byte hashe vers le payment_hash référencé.
 *  sha256(preimage_bytes) == payment_hash_bytes. */
export function verifyPreimage(preimageHex: string, paymentHashHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(preimageHex)) return false;
  if (!/^[a-f0-9]{64}$/i.test(paymentHashHex)) return false;
  const computed = createHash('sha256')
    .update(Buffer.from(preimageHex, 'hex'))
    .digest('hex');
  return computed.toLowerCase() === paymentHashHex.toLowerCase();
}

/** Pure compute du weight effectif. */
export function computeSybilWeight(input: SybilWeightInput): SybilWeightResult {
  const verifiedPowBits = countLeadingZeroBits(input.event_id);
  const powFactor = Math.min(
    MAX_POW_FACTOR,
    1.0 + verifiedPowBits / POW_BITS_FOR_FULL_FACTOR,
  );

  let ageFactor = 1.0;
  if (input.identity_first_seen_sec !== null) {
    const days = Math.max(0, (input.now_sec - input.identity_first_seen_sec) / 86400);
    ageFactor = Math.min(MAX_AGE_FACTOR, 1.0 + days / AGE_DAYS_FOR_FULL_FACTOR);
  }

  let preimageVerified = false;
  let preimageFactor = PREIMAGE_FACTOR_NONE;
  if (input.preimage_hex && input.payment_hash_hex) {
    preimageVerified = verifyPreimage(input.preimage_hex, input.payment_hash_hex);
    if (preimageVerified) preimageFactor = PREIMAGE_FACTOR_VALID;
  }

  const effectiveWeight = BASE_WEIGHT * powFactor * ageFactor * preimageFactor;

  return {
    effective_weight: effectiveWeight,
    pow_factor: powFactor,
    identity_age_factor: ageFactor,
    preimage_factor: preimageFactor,
    verified_pow_bits: verifiedPowBits,
    preimage_verified: preimageVerified,
  };
}
