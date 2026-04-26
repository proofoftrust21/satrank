// sr.fulfill() end-to-end: mocks /api/intent + the candidate endpoint HTTP
// roundtrip. Exercises the L402 402→pay→retry flow, budget enforcement,
// timeout abort, retry_policy, and failure classification.
import { describe, it, expect } from 'vitest';
import { SatRank } from '../src/index';
import { parseL402Challenge } from '../src/fulfill';
import type { Wallet } from '../src/types';

interface EndpointSpec {
  endpoint_url: string;
  endpoint_hash?: string;
  operator_pubkey?: string;
  service_name?: string | null;
  price_sats?: number | null;
  rank?: number;
  verdict?: 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';
}

function makeIntentPayload(candidates: EndpointSpec[]): unknown {
  return {
    intent: { category: 'data', keywords: [], resolved_at: 1 },
    candidates: candidates.map((c, i) => ({
      rank: c.rank ?? i + 1,
      endpoint_url: c.endpoint_url,
      endpoint_hash: c.endpoint_hash ?? 'h'.repeat(64),
      operator_pubkey: c.operator_pubkey ?? '0'.repeat(66),
      service_name: c.service_name ?? null,
      price_sats: c.price_sats ?? null,
      median_latency_ms: null,
      bayesian: {
        p_success: 0.9,
        ci95_low: 0.8,
        ci95_high: 0.95,
        n_obs: 50,
        verdict: c.verdict ?? 'SAFE',
        risk_profile: 'low',
        time_constant_days: 30,
        last_update: 1,
      },
      advisory: {
        advisory_level: 'green',
        risk_score: 10,
        recommendation: 'proceed',
        advisories: [],
      },
      health: {
        reachability: 1,
        http_health_score: 1,
        health_freshness: 1,
        last_probe_age_sec: 5,
      },
    })),
    meta: {
      total_matched: candidates.length,
      returned: candidates.length,
      strictness: 'strict',
      warnings: [],
    },
  };
}

interface Route {
  match: (url: string, init: RequestInit) => boolean;
  response: (url: string, init: RequestInit) => Response | Promise<Response>;
}

function fetchRouter(routes: Route[]): typeof fetch {
  return ((url: string, init: RequestInit = {}) => {
    for (const r of routes) {
      if (r.match(url, init)) return Promise.resolve(r.response(url, init));
    }
    throw new Error(`fetchRouter: unmatched ${init.method ?? 'GET'} ${url}`);
  }) as unknown as typeof fetch;
}

function stubWallet(
  behavior: Partial<{
    payInvoice: Wallet['payInvoice'];
    isAvailable: Wallet['isAvailable'];
  }> = {},
): Wallet {
  return {
    payInvoice:
      behavior.payInvoice ??
      (async () => ({
        preimage: 'be'.repeat(32),
        feePaidSats: 1,
      })),
    isAvailable: behavior.isAvailable ?? (async () => true),
  };
}

describe('parseL402Challenge', () => {
  it('parses canonical L402 header with token= and invoice=', () => {
    const header =
      'L402 token="abc123", invoice="lnbc100n1xyz"';
    expect(parseL402Challenge(header)).toEqual({
      token: 'abc123',
      invoice: 'lnbc100n1xyz',
    });
  });

  it('parses legacy LSAT with macaroon=', () => {
    const header = 'LSAT macaroon="MDA=", invoice="lnbc1u1abc"';
    expect(parseL402Challenge(header)).toEqual({
      token: 'MDA=',
      invoice: 'lnbc1u1abc',
    });
  });

  it('accepts unquoted values', () => {
    const header = 'L402 token=abc, invoice=lnbc1u1pp';
    expect(parseL402Challenge(header)).toEqual({
      token: 'abc',
      invoice: 'lnbc1u1pp',
    });
  });

  it('returns null on malformed header', () => {
    expect(parseL402Challenge('Bearer tok')).toBeNull();
    expect(parseL402Challenge('L402 nope')).toBeNull();
    expect(parseL402Challenge('')).toBeNull();
  });
});

describe('SatRank.fulfill — L402 happy path', () => {
  it('discovers → 402 → pays → retries with Authorization → returns body', async () => {
    const candidateUrl = 'https://svc.test/weather';
    const authCalls: Array<string | null> = [];
    const fetchMock = fetchRouter([
      {
        match: (u, i) =>
          u.endsWith('/api/intent') && i.method === 'POST',
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: candidateUrl, service_name: 'WeatherCo' },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          authCalls.push(h.Authorization ?? null);
          if (!h.Authorization) {
            return new Response('', {
              status: 402,
              headers: {
                'WWW-Authenticate':
                  'L402 token="tok-xyz", invoice="lnbc100n1test"',
              },
            });
          }
          return new Response(
            JSON.stringify({ temp_c: 14 }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        },
      },
    ]);
    const wallet = stubWallet();
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet,
    });
    const res = await sr.fulfill({
      intent: { category: 'weather' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.response_body).toEqual({ temp_c: 14 });
    expect(res.preimage).toBe('be'.repeat(32));
    expect(res.endpoint_used?.service_name).toBe('WeatherCo');
    // 1st call unauthenticated, 2nd call with L402 token+preimage.
    expect(authCalls[0]).toBeNull();
    expect(authCalls[1]).toBe(`L402 tok-xyz:${'be'.repeat(32)}`);
    // 100n = 10 sats (100 * 0.1) + 1 fee = 11 total.
    expect(res.cost_sats).toBe(11);
    expect(res.candidates_tried).toHaveLength(1);
    expect(res.candidates_tried[0].outcome).toBe('paid_success');
  });
});

describe('SatRank.fulfill — budget enforcement', () => {
  it('aborts before paying when invoice amount exceeds remaining budget', async () => {
    const candidateUrl = 'https://svc.test/premium';
    const walletCalls: string[] = [];
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: () =>
          new Response('', {
            status: 402,
            headers: {
              // 1m = 100,000 sats — way over our 50-sat budget.
              'WWW-Authenticate':
                'L402 token="t", invoice="lnbc1m1test"',
            },
          }),
      },
    ]);
    const wallet = stubWallet({
      payInvoice: async (bolt11) => {
        walletCalls.push(bolt11);
        return { preimage: 'x'.repeat(64), feePaidSats: 0 };
      },
    });
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet,
    });
    const res = await sr.fulfill({
      intent: { category: 'premium' },
      budget_sats: 50,
    });
    expect(res.success).toBe(false);
    expect(walletCalls).toHaveLength(0); // never paid
    expect(res.candidates_tried[0].outcome).toBe('abort_budget');
    expect(res.cost_sats).toBe(0);
  });

  it('pre-skips candidate when registry price_sats > remaining budget', async () => {
    const affordable = 'https://svc.test/cheap';
    const tooExpensive = 'https://svc.test/expensive';
    let affordableCalls = 0;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: tooExpensive, price_sats: 500 },
                { endpoint_url: affordable, price_sats: 5 },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === affordable,
        response: () => {
          affordableCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      {
        match: (u) => u === tooExpensive,
        response: () => new Response('{}', { status: 200 }),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 50,
    });
    // Expensive skipped pre-call; cheap served for free (200 on first call).
    expect(res.success).toBe(true);
    expect(res.candidates_tried[0].outcome).toBe('abort_budget');
    expect(res.candidates_tried[1].outcome).toBe('paid_success');
    expect(affordableCalls).toBe(1);
  });
});

describe('SatRank.fulfill — retry policy', () => {
  it('next_candidate falls through pay_failed → paid_success', async () => {
    const c1 = 'https://fail.test/svc';
    const c2 = 'https://ok.test/svc';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: c1 },
                { endpoint_url: c2 },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u, i) => u === c1,
        response: (_u, init) => {
          const auth = (init.headers as Record<string, string>).Authorization;
          return auth
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t1", invoice="lnbc10n1fail"',
                },
              });
        },
      },
      {
        match: (u) => u === c2,
        response: (_u, init) => {
          const auth = (init.headers as Record<string, string>).Authorization;
          return auth
            ? new Response(JSON.stringify({ ok: 'yes' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t2", invoice="lnbc10n1ok"',
                },
              });
        },
      },
    ]);
    // Wallet rejects the first invoice, pays the second.
    let calls = 0;
    const wallet = stubWallet({
      payInvoice: async () => {
        calls += 1;
        if (calls === 1) {
          const { WalletError } = await import('../src/errors');
          throw new WalletError('no route', 'NO_ROUTE');
        }
        return { preimage: 'cd'.repeat(32), feePaidSats: 0 };
      },
    });
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet,
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.endpoint_used?.url).toBe(c2);
    expect(res.candidates_tried.map((c) => c.outcome)).toEqual([
      'pay_failed',
      'paid_success',
    ]);
  });

  it('retry_policy=none stops after first failed candidate', async () => {
    const c1 = 'https://fail.test/svc';
    const c2 = 'https://ok.test/svc';
    let c2Hits = 0;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: c1 },
                { endpoint_url: c2 },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === c1,
        response: () =>
          new Response('', {
            status: 402,
            headers: {
              'WWW-Authenticate':
                'L402 token="t1", invoice="lnbc10n1fail"',
            },
          }),
      },
      {
        match: (u) => u === c2,
        response: () => {
          c2Hits += 1;
          return new Response('{}', { status: 200 });
        },
      },
    ]);
    const wallet = stubWallet({
      payInvoice: async () => {
        const { WalletError } = await import('../src/errors');
        throw new WalletError('broke', 'INSUFFICIENT_BALANCE');
      },
    });
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet,
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      retry_policy: 'none',
    });
    expect(res.success).toBe(false);
    expect(c2Hits).toBe(0); // never tried candidate 2
    expect(res.candidates_tried).toHaveLength(1);
    expect(res.candidates_tried[0].outcome).toBe('pay_failed');
  });
});

describe('SatRank.fulfill — auto_report', () => {
  it('posts /api/report with target hash + preimage + bucket on paid_success', async () => {
    const candidateUrl = 'https://svc.test/x';
    const endpointHash = 'a1b2'.repeat(16);
    let reportBody: Record<string, unknown> | null = null;
    let reportAuth: string | null = null;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: candidateUrl, endpoint_hash: endpointHash },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
      {
        match: (u) => u.endsWith('/api/report'),
        response: (_u, init) => {
          reportBody = JSON.parse(init.body as string);
          const h = (init.headers ?? {}) as Record<string, string>;
          reportAuth = h.Authorization ?? null;
          return new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
          });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      depositToken: 'L402 deposit:feed',
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.report_submitted).toBe(true);
    expect(reportBody).toMatchObject({
      target: endpointHash,
      outcome: 'success',
      preimage: 'be'.repeat(32),
      bolt11Raw: 'lnbc10n1ok',
      amountBucket: 'micro', // 1 sat invoice + 1 fee = 2 sats
    });
    expect(reportAuth).toBe('L402 deposit:feed');
  });

  it('skips report when no depositToken is configured', async () => {
    const candidateUrl = 'https://svc.test/x';
    let reportCalled = 0;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('{}', { status: 200 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
      {
        match: (u) => u.endsWith('/api/report'),
        response: () => {
          reportCalled += 1;
          return new Response('{}', { status: 200 });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      // no depositToken
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.report_submitted).toBe(false);
    expect(reportCalled).toBe(0);
  });

  it('reports outcome=failure when service returns 5xx after payment', async () => {
    const candidateUrl = 'https://svc.test/broken';
    let reportBody: Record<string, unknown> | null = null;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('boom', { status: 503 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1test"',
                },
              });
        },
      },
      {
        match: (u) => u.endsWith('/api/report'),
        response: (_u, init) => {
          reportBody = JSON.parse(init.body as string);
          return new Response('{}', { status: 200 });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      depositToken: 'L402 deposit:beef',
      retry_timeout_ms: 1000,
    } as unknown as ConstructorParameters<typeof SatRank>[0]);
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      retry_policy: 'none',
    });
    expect(res.success).toBe(false);
    expect(res.report_submitted).toBe(true);
    expect((reportBody as Record<string, unknown> | null)?.outcome).toBe(
      'failure',
    );
  });

  it('auto_report=false disables the call even with depositToken set', async () => {
    const candidateUrl = 'https://svc.test/x';
    let reportCalled = 0;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('{}', { status: 200 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
      {
        match: (u) => u.endsWith('/api/report'),
        response: () => {
          reportCalled += 1;
          return new Response('{}', { status: 200 });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      depositToken: 'L402 deposit:feed',
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      auto_report: false,
    });
    expect(res.success).toBe(true);
    expect(res.report_submitted).toBe(false);
    expect(reportCalled).toBe(0);
  });

  it('report failure does not fail fulfill (report_submitted=false)', async () => {
    const candidateUrl = 'https://svc.test/x';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('{}', { status: 200 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
      {
        match: (u) => u.endsWith('/api/report'),
        response: () =>
          new Response(
            JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }),
            { status: 401 },
          ),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      depositToken: 'L402 deposit:bad',
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.report_submitted).toBe(false);
  });
});

describe('SatRank.fulfill — edge behavior', () => {
  it('aborts remaining candidates when the wall-clock deadline is hit', async () => {
    const c1 = 'https://slow.test/svc';
    const c2 = 'https://unreached.test/svc';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: c1 },
                { endpoint_url: c2 },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === c1,
        // Never responds on its own — resolves only on AbortSignal, mirroring
        // real fetch semantics where AbortController.abort() rejects the promise.
        response: (_u, init) =>
          new Promise<Response>((_, reject) => {
            const signal = init.signal as AbortSignal | undefined;
            if (!signal) return;
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      },
      {
        match: (u) => u === c2,
        response: () => new Response('{}', { status: 200 }),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      timeout_ms: 30,
    });
    expect(res.success).toBe(false);
    // c1 attempted and aborted, c2 never tried (deadline already passed).
    expect(res.candidates_tried.length).toBeGreaterThanOrEqual(1);
    expect(res.candidates_tried[0].outcome).toBe('abort_timeout');
  });

  it('passes max_fee_sats through to wallet.payInvoice', async () => {
    const candidateUrl = 'https://svc.test/x';
    let seenMaxFee = -1;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('{}', { status: 200 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
    ]);
    const wallet = stubWallet({
      payInvoice: async (_bolt11, maxFee) => {
        seenMaxFee = maxFee;
        return { preimage: 'ab'.repeat(32), feePaidSats: 0 };
      },
    });
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet,
    });
    await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      max_fee_sats: 42,
    });
    expect(seenMaxFee).toBe(42);
  });

  it('propagates request.method / body / headers / query to the candidate call', async () => {
    const candidateUrl = 'https://svc.test/action';
    const seen: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u.startsWith(candidateUrl),
        response: (url, init) => {
          const headers = (init.headers ?? {}) as Record<string, string>;
          seen.push({
            url,
            method: init.method ?? 'GET',
            headers,
            body: init.body ? JSON.parse(init.body as string) : undefined,
          });
          return headers.Authorization
            ? new Response(JSON.stringify({ done: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1ok"',
                },
              });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      request: {
        method: 'POST',
        body: { prompt: 'hello' },
        headers: { 'X-Agent-Id': 'agent-42' },
        query: { lang: 'en' },
      },
    });
    expect(res.success).toBe(true);
    // Both attempts (unauth + auth) saw the same POST body, same custom headers.
    expect(seen).toHaveLength(2);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toEqual({ prompt: 'hello' });
    expect(seen[0].headers['X-Agent-Id']).toBe('agent-42');
    expect(seen[0].url).toContain('lang=en');
    expect(seen[1].headers.Authorization).toMatch(/^L402 t:/);
  });

  it('forwards constructor caller to /api/intent when opts.caller is missing', async () => {
    let capturedCaller: string | undefined;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: (_u, init) => {
          const body = JSON.parse(init.body as string);
          capturedCaller = body.caller;
          return new Response(
            JSON.stringify(makeIntentPayload([])),
            { status: 200 },
          );
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      caller: 'agent-from-ctor',
    });
    await sr.fulfill({ intent: { category: 'data' }, budget_sats: 10 });
    expect(capturedCaller).toBe('agent-from-ctor');
  });

  it('per-call caller overrides constructor caller', async () => {
    let capturedCaller: string | undefined;
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: (_u, init) => {
          const body = JSON.parse(init.body as string);
          capturedCaller = body.caller;
          return new Response(
            JSON.stringify(makeIntentPayload([])),
            { status: 200 },
          );
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
      caller: 'agent-from-ctor',
    });
    await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 10,
      caller: 'agent-from-call',
    });
    expect(capturedCaller).toBe('agent-from-call');
  });
});

describe('SatRank.fulfill — failure surfaces', () => {
  it('NO_CANDIDATES when the API returns an empty list', async () => {
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(makeIntentPayload([])),
            { status: 200 },
          ),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'nowhere' },
      budget_sats: 10,
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NO_CANDIDATES');
  });

  it('surfaces INTENT_FAILED when /api/intent errors', async () => {
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify({
              error: { code: 'VALIDATION_ERROR', message: 'bad category' },
            }),
            { status: 400 },
          ),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'bad' },
      budget_sats: 10,
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
  });

  it('no_invoice when 402 without parseable WWW-Authenticate', async () => {
    const candidateUrl = 'https://svc.test/bad';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: () => new Response('', { status: 402 }),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(false);
    expect(res.candidates_tried[0].outcome).toBe('no_invoice');
  });

  it('pay_failed when no wallet is configured', async () => {
    const candidateUrl = 'https://svc.test/x';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: () =>
          new Response('', {
            status: 402,
            headers: {
              'WWW-Authenticate': 'L402 token="t", invoice="lnbc1u1p"',
            },
          }),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      // deliberately no wallet
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(false);
    expect(res.candidates_tried[0].outcome).toBe('pay_failed');
    expect(res.candidates_tried[0].error).toContain('no wallet');
  });

  it('paid_failure when the 2nd call returns 5xx after payment', async () => {
    const candidateUrl = 'https://svc.test/broken';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: candidateUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === candidateUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          return h.Authorization
            ? new Response('oops', { status: 503 })
            : new Response('', {
                status: 402,
                headers: {
                  'WWW-Authenticate':
                    'L402 token="t", invoice="lnbc10n1test"',
                },
              });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
      retry_policy: 'none',
    });
    expect(res.success).toBe(false);
    expect(res.candidates_tried[0].outcome).toBe('paid_failure');
    expect(res.candidates_tried[0].response_code).toBe(503);
    // Money was spent even though call failed — 1 sat invoice + 1 sat fee.
    expect(res.cost_sats).toBe(2);
  });
});

describe('SatRank.fulfill — selection_explanation (1.0.3)', () => {
  it('on success, attaches chosen + alternatives with rejection reasons', async () => {
    const cheapUrl = 'https://svc.test/cheap';      // rank 1, registry price > budget → abort_budget
    const winnerUrl = 'https://svc.test/winner';    // rank 2, succeeds
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([
                { endpoint_url: cheapUrl, price_sats: 9999 },
                { endpoint_url: winnerUrl, price_sats: null, service_name: 'win' },
              ]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === winnerUrl,
        response: (_u, init) => {
          const h = (init.headers ?? {}) as Record<string, string>;
          if (!h.Authorization) {
            return new Response('', {
              status: 402,
              headers: { 'WWW-Authenticate': 'L402 token="t", invoice="lnbc100n1ok"' },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(true);
    expect(res.selection_explanation).toBeDefined();
    const sel = res.selection_explanation!;
    expect(sel.chosen_endpoint).toBe(winnerUrl);
    expect(sel.chosen_score).toBe(0.9);
    expect(sel.candidates_evaluated).toBe(2);
    expect(sel.alternatives_considered).toHaveLength(1);
    expect(sel.alternatives_considered[0].endpoint).toBe(cheapUrl);
    expect(sel.alternatives_considered[0].rejected_reason).toContain('budget');
    expect(sel.selection_strategy).toContain('p_success');
  });

  it('on total failure, chosen_* are null and all attempts appear as alternatives', async () => {
    const downUrl = 'https://svc.test/down';
    const fetchMock = fetchRouter([
      {
        match: (u) => u.endsWith('/api/intent'),
        response: () =>
          new Response(
            JSON.stringify(
              makeIntentPayload([{ endpoint_url: downUrl }]),
            ),
            { status: 200 },
          ),
      },
      {
        match: (u) => u === downUrl,
        response: () =>
          new Response('boom', { status: 500 }),
      },
    ]);
    const sr = new SatRank({
      apiBase: 'https://api.test',
      fetch: fetchMock,
      wallet: stubWallet(),
    });
    const res = await sr.fulfill({
      intent: { category: 'data' },
      budget_sats: 100,
    });
    expect(res.success).toBe(false);
    const sel = res.selection_explanation!;
    expect(sel).toBeDefined();
    expect(sel.chosen_endpoint).toBeNull();
    expect(sel.chosen_reason).toBeNull();
    expect(sel.chosen_score).toBeNull();
    expect(sel.alternatives_considered).toHaveLength(1);
    expect(sel.alternatives_considered[0].endpoint).toBe(downUrl);
    expect(sel.candidates_evaluated).toBe(1);
  });
});
