// Covers the LND REST driver: request shape (URL, headers, body), response
// parsing (base64 preimage → hex, fee extraction), error mapping
// (payment_error → code, HTTP status → code), timeout handling, and
// constructor guardrails. All tests use a fetch mock — no LND contacted.
import { describe, it, expect } from 'vitest';
import { LndWallet } from '../../src/wallet/LndWallet';
import { WalletError } from '../../src/errors';

// Raw fetch impl — typed as `typeof fetch` lies about the param types, but
// Vitest does not inspect them. We only need the last call for assertions.
type FetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

// Valid hex for LND "macaroon" — content is irrelevant to the tests.
const MACAROON = '0201036c6e64';
// Dummy BOLT11. Driver forwards opaquely; does not validate the string itself.
const BOLT11 = 'lnbc1u1pjtest';

// Base64 of the 32-byte preimage `01020304…20` — the driver converts it to
// lowercase hex for the public surface. We keep the expected hex alongside
// so the assertion is self-documenting.
const PREIMAGE_B64 =
  'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const PREIMAGE_HEX =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

describe('LndWallet — constructor guardrails', () => {
  it('rejects empty restEndpoint', () => {
    expect(
      () =>
        new LndWallet({
          restEndpoint: '',
          macaroonHex: MACAROON,
          fetch: mockFetch(() => new Response('{}')),
        }),
    ).toThrow(/restEndpoint required/);
  });

  it('rejects empty macaroonHex', () => {
    expect(
      () =>
        new LndWallet({
          restEndpoint: 'https://localhost:8080',
          macaroonHex: '',
          fetch: mockFetch(() => new Response('{}')),
        }),
    ).toThrow(/macaroonHex required/);
  });

  it('rejects non-hex macaroon', () => {
    expect(
      () =>
        new LndWallet({
          restEndpoint: 'https://localhost:8080',
          macaroonHex: 'not-hex-at-all!',
          fetch: mockFetch(() => new Response('{}')),
        }),
    ).toThrow(/lowercase hex/);
  });

  it('trims trailing slash from restEndpoint and lowercases macaroon', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080/',
      // Uppercase hex should be normalised to lowercase.
      macaroonHex: MACAROON.toUpperCase(),
      fetch: mockFetch((url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            payment_preimage: PREIMAGE_B64,
            payment_route: { total_fees: '1' },
          }),
          { status: 200 },
        );
      }),
    });
    await wallet.payInvoice(BOLT11, 10);
    // No double slash — endpoint trimmed correctly.
    expect(capturedUrl).toBe(
      'https://localhost:8080/v1/channels/transactions',
    );
    expect(capturedHeaders['Grpc-Metadata-macaroon']).toBe(MACAROON);
  });
});

describe('LndWallet — payInvoice happy path', () => {
  it('POSTs bolt11 + fee_limit, returns hex preimage and fee', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedMethod = '';
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      timeout_ms: 30_000,
      fetch: mockFetch((_url, init) => {
        capturedMethod = init.method ?? '';
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            payment_preimage: PREIMAGE_B64,
            payment_route: { total_fees: '42' },
          }),
          { status: 200 },
        );
      }),
    });
    const res = await wallet.payInvoice(BOLT11, 100);
    expect(capturedMethod).toBe('POST');
    expect(capturedBody.payment_request).toBe(BOLT11);
    expect(capturedBody.fee_limit).toEqual({ fixed: '100' });
    // timeout_seconds should be derived from timeout_ms minus a 2s safety margin.
    expect(capturedBody.timeout_seconds).toBe(28);
    expect(res.preimage).toBe(PREIMAGE_HEX);
    expect(res.feePaidSats).toBe(42);
  });

  it('floors negative/fractional fee limits and defaults fee to 0', async () => {
    let capturedBody: Record<string, unknown> = {};
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ payment_preimage: PREIMAGE_B64 }),
          { status: 200 },
        );
      }),
    });
    const res = await wallet.payInvoice(BOLT11, -3.9);
    expect(capturedBody.fee_limit).toEqual({ fixed: '0' });
    // payment_route missing → feePaidSats defaults to 0.
    expect(res.feePaidSats).toBe(0);
  });
});

describe('LndWallet — payInvoice error mapping', () => {
  it('payment_error="insufficient_balance" → INSUFFICIENT_BALANCE', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({ payment_error: 'insufficient_balance' }),
            { status: 200 },
          ),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('INSUFFICIENT_BALANCE');
  });

  it('payment_error="no route to host" → NO_ROUTE', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({ payment_error: 'no route to host' }),
            { status: 200 },
          ),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('NO_ROUTE');
  });

  it('payment_error mentioning fee + exceed → FEE_LIMIT_EXCEEDED', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({
              payment_error: 'fee exceeds limit',
            }),
            { status: 200 },
          ),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('FEE_LIMIT_EXCEEDED');
  });

  it('payment_error="already paid" → ALREADY_PAID', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({ payment_error: 'invoice already paid' }),
            { status: 200 },
          ),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('ALREADY_PAID');
  });

  it('unknown payment_error → PAYMENT_FAILED', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({ payment_error: 'gremlins in the router' }),
            { status: 200 },
          ),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('PAYMENT_FAILED');
  });

  it('empty preimage with no payment_error → INVALID_RESPONSE', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () => new Response(JSON.stringify({}), { status: 200 }),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('INVALID_RESPONSE');
  });

  it('non-JSON 200 body → INVALID_RESPONSE', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(() => new Response('not-json', { status: 200 })),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('INVALID_RESPONSE');
  });

  it('HTTP 401 → UNAUTHORIZED', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(
        () =>
          new Response('forbidden', {
            status: 401,
          }),
      ),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('UNAUTHORIZED');
  });

  it('HTTP 500 → LND_SERVER_ERROR', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(() => new Response('boom', { status: 500 })),
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect((err as WalletError).code).toBe('LND_SERVER_ERROR');
  });

  it('fetch transport error → TRANSPORT', async () => {
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: fetchImpl,
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('TRANSPORT');
  });

  it('AbortError on timeout → TIMEOUT', async () => {
    // Simulate a fetch that never resolves; LndWallet's own AbortController
    // should fire after timeout_ms and surface as a WalletError TIMEOUT.
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch;
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: fetchImpl,
      timeout_ms: 20,
    });
    const err = await wallet.payInvoice(BOLT11, 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('TIMEOUT');
  });
});

describe('LndWallet — isAvailable', () => {
  it('returns true when GET /v1/getinfo is 200', async () => {
    let capturedUrl = '';
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch((url) => {
        capturedUrl = url;
        return new Response('{}', { status: 200 });
      }),
    });
    const ok = await wallet.isAvailable();
    expect(ok).toBe(true);
    expect(capturedUrl).toBe('https://localhost:8080/v1/getinfo');
  });

  it('returns false on non-200', async () => {
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: mockFetch(() => new Response('', { status: 503 })),
    });
    expect(await wallet.isAvailable()).toBe(false);
  });

  it('returns false on transport error', async () => {
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const wallet = new LndWallet({
      restEndpoint: 'https://localhost:8080',
      macaroonHex: MACAROON,
      fetch: fetchImpl,
    });
    expect(await wallet.isAvailable()).toBe(false);
  });
});
