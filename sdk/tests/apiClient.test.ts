// Covers the internal HTTP wrapper: success parsing, error mapping,
// timeout signalling, auth header injection. Uses a fetch mock so we don't
// hit the network during unit tests.
import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../src/client/apiClient';
import {
  SatRankError,
  ValidationSatRankError,
  PaymentRequiredError,
  RateLimitedError,
  TimeoutError,
  NetworkError,
} from '../src/errors';

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe('ApiClient', () => {
  it('GET /api/intent/categories parses the success envelope', async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe('https://api.example/api/intent/categories');
      return new Response(
        JSON.stringify({
          categories: [
            { name: 'data', endpoint_count: 5, active_count: 3 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    const res = await api.getIntentCategories();
    expect(res.categories).toHaveLength(1);
    expect(res.categories[0].name).toBe('data');
  });

  it('POST /api/intent forwards body and returns parsed IntentResponse', async () => {
    const fetchMock = mockFetch((_url, init) => {
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.category).toBe('data');
      expect(body.limit).toBe(3);
      return new Response(
        JSON.stringify({
          intent: { category: 'data', keywords: [], resolved_at: 1 },
          candidates: [],
          meta: { total_matched: 0, returned: 0, strictness: 'degraded', warnings: ['NO_CANDIDATES'] },
        }),
        { status: 200 },
      );
    });

    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    const res = await api.postIntent({ category: 'data', limit: 3 });
    expect(res.meta.strictness).toBe('degraded');
  });

  it('maps HTTP 400 to ValidationSatRankError', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'bad input' } }),
          { status: 400 },
        ),
    );
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    await expect(
      api.postIntent({ category: '' }),
    ).rejects.toBeInstanceOf(ValidationSatRankError);
  });

  it('maps HTTP 402 with BALANCE_EXHAUSTED to the right subclass', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'BALANCE_EXHAUSTED', message: 'no quota' } }),
          { status: 402 },
        ),
    );
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    await expect(api.postReport({ target: 'x', outcome: 'success' })).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it('maps HTTP 429 to RateLimitedError', async () => {
    const fetchMock = mockFetch(
      () => new Response('', { status: 429 }),
    );
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    await expect(api.getIntentCategories()).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('injects depositToken on authenticated calls only', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = mockFetch((url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, auth: headers.Authorization });
      if (url.endsWith('/api/intent/categories')) {
        return new Response(JSON.stringify({ categories: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
      depositToken: 'L402 deposit:beef',
    });
    await api.getIntentCategories();
    await api.postReport({ target: 'x'.repeat(64), outcome: 'success' });
    expect(calls[0].auth).toBeUndefined();
    expect(calls[1].auth).toBe('L402 deposit:beef');
  });

  it('abort → TimeoutError', async () => {
    const fetchMock = (() =>
      new Promise((_resolve, reject) => {
        // Never resolves — controller.abort() from ApiClient will trigger
        // AbortError after 10ms.
        const err = new Error('aborted');
        err.name = 'AbortError';
        setTimeout(() => reject(err), 20);
      })) as unknown as typeof fetch;

    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 10,
    });
    await expect(api.getIntentCategories()).rejects.toBeInstanceOf(TimeoutError);
  });

  it('transport error → NetworkError (not SatRankError subclass)', async () => {
    const fetchMock = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    const err = await api.getIntentCategories().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toBeInstanceOf(SatRankError);
  });

  it('empty 200 body surfaces as SatRankError EMPTY_RESPONSE', async () => {
    const fetchMock = mockFetch(() => new Response('', { status: 200 }));
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    const err = (await api.getIntentCategories().catch((e) => e)) as SatRankError;
    expect(err).toBeInstanceOf(SatRankError);
    expect(err.code).toBe('EMPTY_RESPONSE');
  });

  it('passes caller / limit / keywords through to /api/intent body', async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        category: 'weather',
        keywords: ['paris'],
        limit: 2,
        caller: 'agent-42',
      });
      return new Response(
        JSON.stringify({
          intent: { category: 'weather', keywords: ['paris'], resolved_at: 1 },
          candidates: [],
          meta: { total_matched: 0, returned: 0, strictness: 'degraded', warnings: [] },
        }),
        { status: 200 },
      );
    });
    const api = new ApiClient({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      request_timeout_ms: 1000,
    });
    await api.postIntent({
      category: 'weather',
      keywords: ['paris'],
      limit: 2,
      caller: 'agent-42',
    });
  });
});

describe('SatRank — listCategories + resolveIntent integration', () => {
  it('SatRank.resolveIntent forwards options.caller when input.caller missing', async () => {
    const { SatRank } = await import('../src/index');
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      expect(body.caller).toBe('default-caller');
      return new Response(
        JSON.stringify({
          intent: { category: 'data', keywords: [], resolved_at: 1 },
          candidates: [],
          meta: { total_matched: 0, returned: 0, strictness: 'degraded', warnings: [] },
        }),
        { status: 200 },
      );
    });
    const sr = new SatRank({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      caller: 'default-caller',
    });
    await sr.resolveIntent({ category: 'data' });
  });

  it('per-call caller overrides constructor caller', async () => {
    const { SatRank } = await import('../src/index');
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      expect(body.caller).toBe('override');
      return new Response(
        JSON.stringify({
          intent: { category: 'data', keywords: [], resolved_at: 1 },
          candidates: [],
          meta: { total_matched: 0, returned: 0, strictness: 'degraded', warnings: [] },
        }),
        { status: 200 },
      );
    });
    const sr = new SatRank({
      apiBase: 'https://api.example',
      fetch: fetchMock,
      caller: 'default',
    });
    await sr.resolveIntent({ category: 'data', caller: 'override' });
  });
});

describe('vi usage smoke', () => {
  it('vi spy is wired (sanity for remaining C2-C8 tests)', () => {
    const spy = vi.fn();
    spy();
    expect(spy).toHaveBeenCalled();
  });
});
