// Parser BOLT11 — wrapper mince autour de la lib `bolt11`.
// Extrait uniquement ce dont SatRank a besoin : payment_hash, montant, préfixe
// réseau (lnbc/lntb/lntbs). La lib sous-jacente gère la cryptographie et le
// décodage bech32.
import { decode } from 'bolt11';

export class InvalidBolt11Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBolt11Error';
  }
}

export type Bolt11Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface ParsedBolt11 {
  paymentHash: string;
  amountSats: number | null;
  network: Bolt11Network;
  prefix: string;
  payeeNodeKey: string | null;
  expiryTime: number | null;
  timestamp: number | null;
}

function prefixToNetwork(prefix: string | undefined): Bolt11Network {
  if (!prefix) throw new InvalidBolt11Error('missing network prefix');
  if (prefix.startsWith('lnbc')) return 'mainnet';
  if (prefix.startsWith('lntbs')) return 'signet';
  if (prefix.startsWith('lntb')) return 'testnet';
  if (prefix.startsWith('lnbcrt')) return 'regtest';
  throw new InvalidBolt11Error(`unsupported network prefix: ${prefix}`);
}

export function parseBolt11(raw: string): ParsedBolt11 {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidBolt11Error('empty BOLT11 input');
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized.startsWith('ln')) {
    throw new InvalidBolt11Error('BOLT11 must start with ln prefix');
  }

  let decoded;
  try {
    decoded = decode(normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidBolt11Error(`failed to decode BOLT11: ${msg}`);
  }

  const paymentHash = decoded.tagsObject?.payment_hash;
  if (!paymentHash || typeof paymentHash !== 'string' || paymentHash.length !== 64) {
    throw new InvalidBolt11Error('BOLT11 missing valid payment_hash tag');
  }

  const network = prefixToNetwork(decoded.prefix);

  return {
    paymentHash: paymentHash.toLowerCase(),
    amountSats: typeof decoded.satoshis === 'number' ? decoded.satoshis : null,
    network,
    prefix: decoded.prefix ?? '',
    payeeNodeKey: typeof decoded.payeeNodeKey === 'string' ? decoded.payeeNodeKey : null,
    expiryTime: typeof decoded.tagsObject?.expire_time === 'number' ? decoded.tagsObject.expire_time : null,
    timestamp: typeof decoded.timestamp === 'number' ? decoded.timestamp : null,
  };
}
