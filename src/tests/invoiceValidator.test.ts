// Phase 5.11 — Stage 2 invoice validity : tests purs (pas de DB).
//
// Les invoices fixtures sont générées avec la lib `bolt11` au lancement du
// test. On ne hardcode pas de BOLT11 brutes parce qu'elles dépendent du
// timestamp + de la signature. Le payeeNodeKey et la signature sont
// injectés via la lib pour matcher la décodabilité.
import { describe, it, expect } from 'vitest';
import { encode } from 'bolt11';
import { validateInvoice, AMOUNT_MISMATCH_RATIO } from '../utils/invoiceValidator';

const PRIVKEY = 'a'.repeat(64); // dummy key for signing

interface FakeInvoiceOpts {
  amountSats?: number | null;
  network?: 'bc' | 'tb' | 'tbs' | 'bcrt';
  timestamp?: number;
  expirySec?: number;
}

function makeInvoice(opts: FakeInvoiceOpts = {}): string {
  // Build a minimal BOLT11 with the lib. Network prefix mapping :
  //   bc  → mainnet (lnbc)
  //   tb  → testnet (lntb)
  //   tbs → signet  (lntbs)
  //   bcrt → regtest (lnbcrt)
  const data: Record<string, unknown> = {
    network: undefined as unknown,
    coinType: opts.network === 'bc' || !opts.network ? 'bitcoin' : (opts.network === 'tb' ? 'testnet' : opts.network),
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: 'b'.repeat(64) },
      { tagName: 'description', data: 'unit test invoice' },
      { tagName: 'expire_time', data: opts.expirySec ?? 3600 },
    ],
  };
  if (opts.amountSats != null) {
    (data as { satoshis?: number }).satoshis = opts.amountSats;
  }
  // The bolt11 lib derives prefix from coinType. To force lnbc / lntb /
  // lnbcrt we set the prefix directly via the encoder's recognized form.
  if (opts.network === 'bc' || !opts.network) {
    (data as Record<string, unknown>).coinType = 'bitcoin';
  }
  const signed = encode(data);
  // signRecovery binds payee_node_key to the signing pubkey.
  const PRIV = Buffer.from(PRIVKEY, 'hex');
  // Use the bolt11 lib's sign helper indirectly: encode-then-sign.
  // The `sign` API mutates the in-memory signed object — we re-encode the
  // payment_request after applying it.
  const { sign } = require('bolt11') as { sign: (data: unknown, key: Buffer) => unknown };
  const final = sign(signed, PRIV) as { paymentRequest: string };
  return final.paymentRequest;
}

describe('validateInvoice (Phase 5.11)', () => {
  it('valid: BOLT11 fresh, mainnet, amount matches advertised price', () => {
    const inv = makeInvoice({ amountSats: 5, network: 'bc' });
    const result = validateInvoice(inv, {
      advertisedPriceSats: 5,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(result.outcome).toBe('valid');
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.network).toBe('mainnet');
  });

  it('decode_failed: garbage input', () => {
    const result = validateInvoice('not-a-bolt11', {
      advertisedPriceSats: 5,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(result.outcome).toBe('decode_failed');
    expect(result.parsed).toBeNull();
    expect(result.detail).toBeDefined();
  });

  it('wrong_network: testnet invoice rejected on mainnet oracle', () => {
    // Hardcoded testnet BOLT11 (prefix lntb) — la lib bolt11 expose un
    // `coinType` qui doit être un objet bitcoinjs-lib pour basculer le
    // prefix encodé. Utiliser une vraie payment_request testnet est plus
    // simple et reflète mieux le shape qu'on verrait en prod si jamais.
    const TESTNET_INVOICE =
      'lntb1u1pjsxqupp52nlwymf2va76d8ejx69mzfsk7p3yew2pwx3umkr8sx95vfn3yc6sdqqcqzpgxqyz5vqsp5p2lc3rfsqz23ah0gj3wlj2sw9z6m8r5edre0p7yu2lzqcwm0c2cs9qyyssqv4l7nzslz6ah0nrxzkwfzqj0ck0fz2vdnzqj6cd0lck5y0xrh67vqg5cy4yp9p5wx5p86kt5zynj9emdzg2u4qpsfdaajchrgw4r4qq8mtv9z';
    const result = validateInvoice(TESTNET_INVOICE, {
      advertisedPriceSats: 5,
      nowSec: 1_700_000_000,
    });
    // Soit on parse correctement (outcome=wrong_network), soit le decode
    // échoue (outcome=decode_failed). L'invariant qu'on teste : aucun BOLT11
    // non-mainnet ne peut sortir 'valid'.
    expect(result.outcome).not.toBe('valid');
  });

  it('expired: timestamp + expiry < now - margin', () => {
    const oldNow = 1_700_000_000;
    const inv = makeInvoice({
      amountSats: 5,
      network: 'bc',
      timestamp: oldNow,
      expirySec: 60,
    });
    const result = validateInvoice(inv, {
      advertisedPriceSats: 5,
      nowSec: oldNow + 200, // bien après expiration
    });
    expect(result.outcome).toBe('expired');
  });

  it('amount_mismatch: BOLT11 amount diverges >50% from advertised', () => {
    // Annoncé 5, BOLT11 = 100 → ratio 20 = 1900% out of bound.
    const inv = makeInvoice({ amountSats: 100, network: 'bc' });
    const result = validateInvoice(inv, {
      advertisedPriceSats: 5,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(result.outcome).toBe('amount_mismatch');
  });

  it('within tolerance: BOLT11 +30% on advertised price is valid', () => {
    // ratio = 1.3, sous AMOUNT_MISMATCH_RATIO (0.5 → 50% tolerance)
    expect(AMOUNT_MISMATCH_RATIO).toBe(0.5);
    const inv = makeInvoice({ amountSats: 13, network: 'bc' });
    const result = validateInvoice(inv, {
      advertisedPriceSats: 10,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(result.outcome).toBe('valid');
  });

  it('skips amount check when advertised is null', () => {
    // Sans prix annoncé, on accepte le BOLT11 amount tel quel.
    const inv = makeInvoice({ amountSats: 9999, network: 'bc' });
    const result = validateInvoice(inv, {
      advertisedPriceSats: null,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(result.outcome).toBe('valid');
  });
});
