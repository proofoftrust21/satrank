// Covers the LNbits-compatible HTTP wallet driver: pay → poll → status,
// auth header injection, fee normalization (msat/sat variants), error codes.
import { describe, it, expect } from 'vitest';
import { LnurlWallet } from '../../src/wallet/LnurlWallet';
import { WalletError } from '../../src/errors';

type FetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe('LnurlWallet — constructor guardrails', () => {
  it('rejects empty baseUrl', () => {
    expect(
      () =>
        new LnurlWallet({
          baseUrl: '',
          adminKey: 'secret',
          fetch: mockFetch(() => new Response('{}')),
        }),
    ).toThrow(/baseUrl required/);
  });

  it('rejects empty adminKey', () => {
    expect(
      () =>
        new LnurlWallet({
          baseUrl: 'https://lnbits.test',
          adminKey: '',
          fetch: mockFetch(() => new Response('{}')),
        }),
    ).toThrow(/adminKey required/);
  });

  it('trims trailing slash from baseUrl', async () => {
    let capturedUrl = '';
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test/',
      adminKey: 'key',
      poll_interval_ms: 1,
      fetch: mockFetch((url) => {
        capturedUrl = url;
        if (url.endsWith('/api/v1/payments')) {
          return new Response(
            JSON.stringify({ payment_hash: 'h'.repeat(64) }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({ paid: true, preimage: 'p'.repeat(64), fee: 1 }),
          { status: 200 },
        );
      }),
    });
    await wallet.payInvoice('lnbc1u1test', 10);
    expect(capturedUrl.startsWith('https://lnbits.test/api/v1/payments/')).toBe(
      true,
    );
  });
});

describe('LnurlWallet — payInvoice happy path', () => {
  it('POSTs /api/v1/payments with out=true + bolt11, polls status, returns preimage', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k1',
      poll_interval_ms: 1,
      fetch: mockFetch((url, init) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        if (init.method === 'POST') {
          return new Response(
            JSON.stringify({ payment_hash: 'abcd'.repeat(16) }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            paid: true,
            preimage: 'ff'.repeat(32),
            fee_msat: 2000,
          }),
          { status: 200 },
        );
      }),
    });
    const res = await wallet.payInvoice('lnbc1u1test', 10);
    expect(res.preimage).toBe('ff'.repeat(32));
    expect(res.feePaidSats).toBe(2); // 2000 msat / 1000
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ out: true, bolt11: 'lnbc1u1test' });
    expect(calls[1].method).toBe('GET');
  });

  it('injects X-Api-Key header by default', async () => {
    let capturedHeaders: Record<string, string> = {};
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'secret-key-xyz',
      poll_interval_ms: 1,
      fetch: mockFetch((_url, init) => {
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({ payment_hash: 'h'.repeat(64) }),
          { status: 201 },
        );
      }),
    });
    // Just start a pay — capturedHeaders will be filled on the POST call.
    // We race it against status-failure so we don't spin forever waiting for paid=true.
    wallet.payInvoice('lnbc1u1test', 10).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedHeaders['X-Api-Key']).toBe('secret-key-xyz');
  });

  it('honors custom authHeader / authPrefix (BTCPay-style)', async () => {
    let capturedAuth = '';
    const wallet = new LnurlWallet({
      baseUrl: 'https://btcpay.test',
      adminKey: 'tok_abc',
      authHeader: 'Authorization',
      authPrefix: 'token ',
      poll_interval_ms: 1,
      fetch: mockFetch((_url, init) => {
        const h = init.headers as Record<string, string>;
        capturedAuth = h.Authorization ?? '';
        return new Response(
          JSON.stringify({ payment_hash: 'h'.repeat(64) }),
          { status: 201 },
        );
      }),
    });
    wallet.payInvoice('lnbc1u1test', 10).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedAuth).toBe('token tok_abc');
  });

  it('normalizes sat-denominated fee (legacy LNbits)', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      poll_interval_ms: 1,
      fetch: mockFetch((_url, init) => {
        if (init.method === 'POST') {
          return new Response(
            JSON.stringify({ payment_hash: 'h'.repeat(64) }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({ paid: true, preimage: 'a'.repeat(64), fee: 5 }),
          { status: 200 },
        );
      }),
    });
    const res = await wallet.payInvoice('lnbc1u1test', 10);
    expect(res.feePaidSats).toBe(5);
  });
});

describe('LnurlWallet — payInvoice failure modes', () => {
  it('POST 401 → UNAUTHORIZED', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'bad',
      fetch: mockFetch(() => new Response('nope', { status: 401 })),
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('UNAUTHORIZED');
  });

  it('POST 500 → WALLET_SERVER_ERROR', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      fetch: mockFetch(() => new Response('boom', { status: 500 })),
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('WALLET_SERVER_ERROR');
  });

  it('POST ok but missing payment_hash → INVALID_RESPONSE', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      fetch: mockFetch(
        () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      ),
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('INVALID_RESPONSE');
  });

  it('polling times out when paid never flips true → PAYMENT_TIMEOUT', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      poll_timeout_ms: 20,
      poll_interval_ms: 2,
      fetch: mockFetch((_url, init) => {
        if (init.method === 'POST') {
          return new Response(
            JSON.stringify({ payment_hash: 'h'.repeat(64) }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ paid: false }), { status: 200 });
      }),
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('PAYMENT_TIMEOUT');
  });

  it('paid=true but fee > cap → FEE_LIMIT_EXCEEDED', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      poll_interval_ms: 1,
      fetch: mockFetch((_url, init) => {
        if (init.method === 'POST') {
          return new Response(
            JSON.stringify({ payment_hash: 'h'.repeat(64) }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            paid: true,
            preimage: 'p'.repeat(64),
            fee_msat: 50_000,
          }),
          { status: 200 },
        );
      }),
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('FEE_LIMIT_EXCEEDED');
  });
});

describe('LnurlWallet — isAvailable', () => {
  it('returns true when GET /api/v1/wallet is 200', async () => {
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      fetch: mockFetch(() => new Response('{}', { status: 200 })),
    });
    expect(await wallet.isAvailable()).toBe(true);
  });

  it('returns false on transport error', async () => {
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const wallet = new LnurlWallet({
      baseUrl: 'https://lnbits.test',
      adminKey: 'k',
      fetch: fetchImpl,
    });
    expect(await wallet.isAvailable()).toBe(false);
  });
});
