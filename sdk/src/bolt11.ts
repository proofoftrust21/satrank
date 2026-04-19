// Minimal BOLT11 amount decoder. The SDK only needs the satoshi amount to
// enforce budget caps — we deliberately don't parse the full invoice (no tags,
// no signatures, no hop hints) to stay dependency-free.
//
// BOLT-11 human-readable prefix format:
//   ln + chain_tag + [amount + multiplier]
// where chain_tag ∈ {bc, tb, bcrt, sb} and multiplier ∈ {m, u, n, p}.
// Conversion to sats:
//   m (milli) → amount * 1e-3  BTC = amount * 100_000 sats
//   u (micro) → amount * 1e-6  BTC = amount * 100     sats
//   n (nano)  → amount * 1e-9  BTC = amount * 0.1     sats
//   p (pico)  → amount * 1e-12 BTC = amount * 0.0001  sats
//
// Returns null for amountless invoices and for sub-sat amounts that can't
// round-trip cleanly — the SDK treats "null" as "ask the wallet to confirm
// the amount before paying", which is the safe fallback.

export interface Bolt11Decoded {
  /** Satoshi amount, or null when unspecified / sub-sat. */
  amount_sats: number | null;
  chain: 'bc' | 'tb' | 'bcrt' | 'sb';
}

// Only the HRP + separator matter for amount decoding. What follows the `1`
// separator is data-part bech32 (payment_hash, tags, signature), which we
// neither validate nor parse here — that's outside the SDK's responsibility.
const PREFIX_RE = /^ln(bc|tb|bcrt|sb)(\d+)?([munp])?1[^\s]+$/i;

export function decodeBolt11(bolt11: string): Bolt11Decoded {
  const trimmed = bolt11.trim().toLowerCase();
  const match = PREFIX_RE.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid BOLT11 invoice: ${trimmed.slice(0, 32)}…`);
  }
  const [, chain, amountStr, multiplier] = match;

  if (!amountStr) {
    return { amount_sats: null, chain: chain as Bolt11Decoded['chain'] };
  }

  const amount = Number(amountStr);
  if (!Number.isFinite(amount)) {
    return { amount_sats: null, chain: chain as Bolt11Decoded['chain'] };
  }

  let sats: number;
  switch (multiplier) {
    case 'm':
      sats = amount * 100_000;
      break;
    case 'u':
      sats = amount * 100;
      break;
    case 'n':
      sats = amount * 0.1;
      break;
    case 'p':
      sats = amount * 0.0001;
      break;
    case undefined:
      // No multiplier → amount is in whole BTC. Must fit in safe integer sats.
      sats = amount * 100_000_000;
      break;
    default:
      return { amount_sats: null, chain: chain as Bolt11Decoded['chain'] };
  }

  // Sub-sat amounts don't round-trip — e.g. lnbc1n = 0.1 sat. Reject.
  if (!Number.isInteger(sats)) {
    return { amount_sats: null, chain: chain as Bolt11Decoded['chain'] };
  }

  return { amount_sats: sats, chain: chain as Bolt11Decoded['chain'] };
}

export function decodeBolt11Amount(bolt11: string): number | null {
  return decodeBolt11(bolt11).amount_sats;
}
