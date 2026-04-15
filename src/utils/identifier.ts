// Shared identifier normalization — used by agentController and v2Controller
import { sha256 } from './crypto';

/** If input is a 66-char Lightning pubkey (02/03 prefix), return { hash: SHA256(pubkey), pubkey }.
 *  Otherwise treat input as a raw hash and return { hash: input, pubkey: null }. */
export function normalizeIdentifier(input: string): { hash: string; pubkey: string | null } {
  if (input.length === 66 && /^(02|03)/.test(input)) {
    return { hash: sha256(input), pubkey: input };
  }
  return { hash: input, pubkey: null };
}

/** Resolve an identifier to a hash that exists in the DB.
 *  Tries SHA256(pubkey) first, then falls back to a direct public_key lookup.
 *  This handles the case where an agent passes a pubkey that maps to a different
 *  agent than SHA256(pubkey) — e.g. Strike has multiple LN nodes. */
export function resolveIdentifier(
  input: string,
  findByPubkey: (pubkey: string) => { public_key_hash: string } | undefined,
): { hash: string; pubkey: string | null; resolvedViaFallback: boolean } {
  const norm = normalizeIdentifier(input);

  // If input wasn't a pubkey, nothing to fall back to
  if (!norm.pubkey) return { ...norm, resolvedViaFallback: false };

  // Check if the SHA256 hash exists — caller does this check anyway, so we
  // only need the fallback when findByHash would fail. But we can't call
  // findByHash here without adding a dependency. Instead, always try the
  // pubkey lookup as a backup that the caller can use.
  const byPubkey = findByPubkey(norm.pubkey);
  if (byPubkey && byPubkey.public_key_hash !== norm.hash) {
    // The pubkey is in the DB under a different hash — use that hash instead
    return { hash: byPubkey.public_key_hash, pubkey: norm.pubkey, resolvedViaFallback: true };
  }

  return { ...norm, resolvedViaFallback: false };
}
