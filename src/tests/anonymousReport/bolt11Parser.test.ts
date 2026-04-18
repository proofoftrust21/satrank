// BOLT11 parser tests — wrapper autour de la lib `bolt11`, utilisé par les
// voies 2 (intent) et 3 (report) pour extraire payment_hash et alimenter
// preimage_pool.
import { describe, it, expect } from 'vitest';
import { parseBolt11, InvalidBolt11Error } from '../../utils/bolt11Parser';

// Invoice spec BOLT11 (mainnet, 2000 sats, payment_hash connu du RFC)
const MAINNET_INVOICE = 'lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq';
const MAINNET_PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

describe('parseBolt11', () => {
  it('parses a valid mainnet (lnbc) invoice and extracts payment_hash + amount + network', () => {
    const parsed = parseBolt11(MAINNET_INVOICE);
    expect(parsed.paymentHash).toBe(MAINNET_PAYMENT_HASH);
    expect(parsed.network).toBe('mainnet');
    expect(parsed.prefix.startsWith('lnbc')).toBe(true);
    expect(parsed.amountSats).toBe(2000);
  });

  it('normalizes uppercase and surrounding whitespace', () => {
    const parsed = parseBolt11(`  ${MAINNET_INVOICE.toUpperCase()}  `);
    expect(parsed.paymentHash).toBe(MAINNET_PAYMENT_HASH);
    expect(parsed.network).toBe('mainnet');
  });

  it('throws InvalidBolt11Error on empty input', () => {
    expect(() => parseBolt11('')).toThrow(InvalidBolt11Error);
  });

  it('throws InvalidBolt11Error on malformed BOLT11', () => {
    expect(() => parseBolt11('not-a-bolt11-invoice')).toThrow(InvalidBolt11Error);
    expect(() => parseBolt11('lnbc-malformed')).toThrow(InvalidBolt11Error);
  });

  it('throws InvalidBolt11Error on non-ln prefix', () => {
    expect(() => parseBolt11('btc1somethingelse')).toThrow(/must start with ln prefix/);
  });
});
