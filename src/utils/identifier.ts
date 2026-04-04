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
