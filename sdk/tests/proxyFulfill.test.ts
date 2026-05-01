// SDK 1.3.0 — proxyFulfill / proxyFulfillQuote tests.
//
// Cover the typed result mapping for every business outcome (success /
// refunded / insufficient_balance / daily_cap_reached / circuit_breaker_open)
// and the throw-on-genuine-error path (auth invalid, fulfill_disabled,
// network timeout). No live HTTP — everything via fetch mock.
import { describe, it, expect } from 'vitest';
import { SatRank } from '../src/SatRank';
import { SatRankError } from '../src/errors';

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

const BASE = 'https://api.example';

describe('SatRank.proxyFulfill', () => {
  const sample = {
    intent: { category: 'data' },
    max_sats: 50,
    max_latency_ms: 5000,
    authorization: 'Nostr xxx',
  };

  it('200 → status=success with body + preimage', async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe(`${BASE}/api/fulfill`);
      expect((init.headers as Record<string, string>).Authorization).toBe('Nostr xxx');
      return new Response(JSON.stringify({
        status: 'success',
        job_id: 'j1',
        body: 'hello',
        preimage: 'p'.repeat(64),
        candidate_url: 'https://x.example/api',
        attempts: [],
        sats_spent: 5,
        premium_sats: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(sample);
    expect(r.status).toBe('success');
    expect(r.body).toBe('hello');
    expect(r.sats_spent).toBe(5);
  });

  it('502 → status=refunded with reason + attempts', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      status: 'refunded',
      job_id: 'j2',
      attempts: [{ candidate_url: 'x', rank: 1, payment_outcome: 'pay_ok', delivery_outcome: 'delivery_5xx' }],
      reason: 'all_candidates_failed',
    }), { status: 502 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(sample);
    expect(r.status).toBe('refunded');
    expect(r.reason).toBe('all_candidates_failed');
  });

  it('402 → status=insufficient_balance with required/available', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'insufficient_balance',
      required_sats: 51,
      available_sats: 3,
      message: 'top up via /api/deposit',
    }), { status: 402 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(sample);
    expect(r.status).toBe('insufficient_balance');
    expect(r.required_sats).toBe(51);
    expect(r.available_sats).toBe(3);
  });

  it('429 → status=daily_cap_reached', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'daily_cap_reached',
      cap_sats: 100,
      used_24h_sats: 95,
      agent_age_bucket: 'fresh',
      retry_after_sec: 86400,
    }), { status: 429 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(sample);
    expect(r.status).toBe('daily_cap_reached');
    expect(r.cap_sats).toBe(100);
    expect(r.agent_age_bucket).toBe('fresh');
  });

  it('503 with error=circuit_breaker_open → typed status, not thrown', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'circuit_breaker_open',
      pool_balance_sats: -100,
      min_pool_sats: 10000,
      retry_after_sec: 300,
    }), { status: 503 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(sample);
    expect(r.status).toBe('circuit_breaker_open');
    expect(r.pool_balance_sats).toBe(-100);
  });

  it('503 with error=fulfill_disabled → throws SatRankError (genuine error)', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'fulfill_disabled',
      message: 'feature flag off',
    }), { status: 503 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    await expect(sr.proxyFulfill(sample)).rejects.toThrow(SatRankError);
  });

  it('401 → throws SatRankError with the auth code', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'invalid_auth',
      message: 'NIP-98 verification failed',
    }), { status: 401 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    await expect(sr.proxyFulfill(sample)).rejects.toThrow(SatRankError);
  });

  it('fulfillEndpoint() returns the canonical URL agents must sign', () => {
    const sr = new SatRank({ apiBase: BASE });
    expect(sr.fulfillEndpoint()).toBe(`${BASE}/api/fulfill`);
  });
});

describe('SatRank.proxyFulfill (mode=hold) — SDK 1.4.0', () => {
  const holdSample = {
    intent: { category: 'data' },
    max_sats: 50,
    max_latency_ms: 5000,
    authorization: 'Nostr xxx',
    mode: 'hold' as const,
  };

  it('mode=hold is forwarded in the request body', async () => {
    let capturedBody: unknown = null;
    const fetchMock = mockFetch((url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        status: 'hold_invoice_required',
        job_id: 'h1',
        payment_request: 'lnbc1...',
        payment_hash: 'a'.repeat(64),
        invoice_amount_sats: 12,
        expires_at: 1714500000,
        execute_endpoint: '/api/fulfill/h1/execute',
      }), { status: 402, headers: { 'content-type': 'application/json' } });
    });
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(holdSample);
    expect((capturedBody as { mode?: string }).mode).toBe('hold');
    expect(r.status).toBe('hold_invoice_required');
    expect(r.payment_request).toBe('lnbc1...');
    expect(r.payment_hash).toBe('a'.repeat(64));
    expect(r.invoice_amount_sats).toBe(12);
    expect(r.job_id).toBe('h1');
  });

  it('402 with insufficient_balance shape still maps to insufficient_balance', async () => {
    // Regression — the 402 dispatch must NOT misroute insufficient_balance to
    // hold_invoice_required just because both share the status code.
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'insufficient_balance',
      required_sats: 51,
      available_sats: 3,
    }), { status: 402 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(holdSample);
    expect(r.status).toBe('insufficient_balance');
    expect(r.required_sats).toBe(51);
  });

  it('503 hold_mode_unavailable → typed status, not thrown', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      error: 'hold_mode_unavailable',
      reason: 'lnd_invoicesrpc_offline',
    }), { status: 503 }));
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfill(holdSample);
    expect(r.status).toBe('hold_mode_unavailable');
  });
});

describe('SatRank.proxyFulfillExecute — SDK 1.4.0', () => {
  it('POSTs to /api/fulfill/:job_id/execute with intent + auth, returns success', async () => {
    let capturedUrl = '';
    let capturedAuth: string | undefined;
    let capturedBody: unknown = null;
    const fetchMock = mockFetch((url, init) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        status: 'success',
        job_id: 'h1',
        body: 'world',
        preimage: 'p'.repeat(64),
        candidate_url: 'https://x.example/api',
        attempts: [],
        sats_spent: 11,
        premium_sats: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const r = await sr.proxyFulfillExecute({
      job_id: 'h1',
      intent: { category: 'data' },
      authorization: 'Nostr yyy',
    });
    expect(capturedUrl).toBe(`${BASE}/api/fulfill/h1/execute`);
    expect(capturedAuth).toBe('Nostr yyy');
    expect((capturedBody as { intent?: unknown }).intent).toEqual({ category: 'data' });
    expect(r.status).toBe('success');
    expect(r.body).toBe('world');
  });

  it('encodes job_id segment safely (path traversal guard)', async () => {
    let capturedUrl = '';
    const fetchMock = mockFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        status: 'refunded',
        job_id: 'weird/id',
        attempts: [],
        reason: 'all_candidates_failed',
      }), { status: 502 });
    });
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    await sr.proxyFulfillExecute({
      job_id: 'weird/id',
      intent: { category: 'data' },
      authorization: 'Nostr zzz',
    });
    expect(capturedUrl).toBe(`${BASE}/api/fulfill/weird%2Fid/execute`);
  });

  it('fulfillExecuteEndpoint() returns the canonical URL agents must sign', () => {
    const sr = new SatRank({ apiBase: BASE });
    expect(sr.fulfillExecuteEndpoint('h1')).toBe(`${BASE}/api/fulfill/h1/execute`);
    expect(sr.fulfillExecuteEndpoint('weird/id')).toBe(
      `${BASE}/api/fulfill/weird%2Fid/execute`,
    );
  });
});

describe('SatRank.proxyFulfillQuote', () => {
  it('returns the quote payload, no auth required', async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe(`${BASE}/api/fulfill/quote`);
      // No Authorization header expected on /quote.
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify({
        data: {
          candidates: [
            {
              rank: 1,
              endpoint_url: 'https://x.example/a',
              operator_pubkey: '02' + 'a'.repeat(64),
              invoice_sats_estimate: 7,
              premium_estimate: 1,
              total_estimate: 8,
              p_e2e: 0.7,
              p_e2e_pessimistic: 0.5,
              median_latency_ms: 50,
            },
          ],
          reserve_sats_max: 11,
          circuit_breaker_open: false,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const sr = new SatRank({ apiBase: BASE, fetch: fetchMock });
    const q = await sr.proxyFulfillQuote({
      intent: { category: 'data' },
      max_sats: 10,
    });
    expect(q.candidates).toHaveLength(1);
    expect(q.candidates[0].invoice_sats_estimate).toBe(7);
    expect(q.reserve_sats_max).toBe(11);
    expect(q.circuit_breaker_open).toBe(false);
  });
});
