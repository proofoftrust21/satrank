import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { backfillServicePrices } from '../scripts/backfillServicePrices';
import { sha256 } from '../utils/crypto';
import type { LndGraphClient } from '../crawler/lndGraphClient';

let testDb: TestDb;

// Minimal LND stub — only decodePayReq is exercised. Other methods throw to
// catch accidental misuse by the backfill script.
function mockLndClient(
  decodeMap: Record<string, { destination: string; num_satoshis?: string } | null>,
  strictErrorMap: Record<string, string> = {},
): LndGraphClient {
  return {
    getInfo: async () => { throw new Error('unexpected getInfo call'); },
    getGraph: async () => { throw new Error('unexpected getGraph call'); },
    getNodeInfo: async () => { throw new Error('unexpected getNodeInfo call'); },
    queryRoutes: async () => { throw new Error('unexpected queryRoutes call'); },
    decodePayReq: async (payReq: string) => decodeMap[payReq] ?? null,
    decodePayReqStrict: async (payReq: string) => {
      if (strictErrorMap[payReq]) throw new Error(strictErrorMap[payReq]);
      const r = decodeMap[payReq];
      if (!r?.destination) throw new Error(`mock decode: no result for ${payReq}`);
      return r;
    },
  } as LndGraphClient;
}

describe('backfillServicePrices', async () => {
  let pool: Pool;
  let repo: ServiceEndpointRepository;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new ServiceEndpointRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await pool.query('DELETE FROM service_endpoints');
  });

  function mockFetch(responses: Record<string, { status: number; invoice?: string; wwwAuth?: string }>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const entry = responses[urlStr];
      if (!entry) return new Response('not found', { status: 404 });
      const headers = new Headers();
      if (entry.wwwAuth) headers.set('www-authenticate', entry.wwwAuth);
      else if (entry.invoice) headers.set('www-authenticate', `L402 macaroon="fake", invoice="${entry.invoice}"`);
      return new Response('', { status: entry.status, headers });
    }) as typeof fetch;
  }

  // Per-URL attempt-tracking mock for retry tests. Advance through the array of
  // responses on each call; stay on the last entry once consumed.
  function mockFetchWithAttempts(
    urlToResponses: Record<string, Array<{ status: number; invoice?: string; error?: string }>>,
  ): { fetch: typeof fetch; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const impl = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const attempts = urlToResponses[urlStr];
      if (!attempts) return new Response('not found', { status: 404 });
      const idx = counts[urlStr] ?? 0;
      counts[urlStr] = idx + 1;
      const entry = attempts[Math.min(idx, attempts.length - 1)];
      if (entry.error) throw new Error(entry.error);
      const headers = new Headers();
      if (entry.invoice) headers.set('www-authenticate', `L402 macaroon="fake", invoice="${entry.invoice}"`);
      return new Response('', { status: entry.status, headers });
    }) as typeof fetch;
    return { fetch: impl, counts };
  }

  it('prices rows with null service_price_sats from BOLT11 num_satoshis', async () => {
    const url = 'https://backfill-new.example.com';
    const pubkey = '02' + 'a'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc30n1pfakeinvoiceone';
    global.fetch = mockFetch({ [url]: { status: 402, invoice } });
    const lnd = mockLndClient({ [invoice]: { destination: pubkey, num_satoshis: '30' } });

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.scanned).toBe(1);
    expect(summary.priced).toBe(1);

    const after = await repo.findByUrl(url);
    expect(after!.service_price_sats).toBe(30);
  });

  it('dry-run rolls back mutations', async () => {
    const url = 'https://backfill-dryrun.example.com';
    const pubkey = '02' + 'b'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc30n1pfakeinvoicedryrun';
    global.fetch = mockFetch({ [url]: { status: 402, invoice } });
    const lnd = mockLndClient({ [invoice]: { destination: pubkey, num_satoshis: '30' } });

    const summary = await backfillServicePrices(pool, lnd, { dryRun: true, rateLimitMs: 0 });

    expect(summary.priced).toBe(1);

    const after = await repo.findByUrl(url);
    expect(after!.service_price_sats).toBeNull();
  });

  it('skips rows with non-null service_price_sats', async () => {
    const url = 'https://backfill-priced.example.com';
    const pubkey = '02' + 'c'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');
    await repo.updatePrice(url, 99);

    global.fetch = mockFetch({});
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.scanned).toBe(0);
    expect(summary.priced).toBe(0);
  });

  it('skips ad_hoc source rows (trust hierarchy)', async () => {
    const url = 'https://backfill-adhoc.example.com';
    const pubkey = '02' + 'd'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, 'ad_hoc');

    global.fetch = mockFetch({});
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.scanned).toBe(0);
  });

  it('counts skippedNoInvoice when WWW-Authenticate lacks BOLT11', async () => {
    const url = 'https://backfill-noinvoice.example.com';
    const pubkey = '02' + 'e'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    global.fetch = mockFetch({ [url]: { status: 402, wwwAuth: 'Basic realm="x"' } });
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.scanned).toBe(1);
    expect(summary.skippedNoInvoice).toBe(1);
    expect(summary.priced).toBe(0);
  });

  it('counts skippedNotL402 when endpoint returns non-402 status', async () => {
    const url = 'https://backfill-200.example.com';
    const pubkey = '02' + 'f'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    global.fetch = mockFetch({ [url]: { status: 200 } });
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.skippedNotL402).toBe(1);
    expect(summary.priced).toBe(0);
  });

  it('counts skippedDecodeFailed when LND returns null', async () => {
    const url = 'https://backfill-decode-fail.example.com';
    const pubkey = '02' + '1'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbcfailingdecode';
    global.fetch = mockFetch({ [url]: { status: 402, invoice } });
    const lnd = mockLndClient({ [invoice]: null });

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.skippedDecodeFailed).toBe(1);
  });

  it('counts skippedInvoiceMalformed on LND bech32 parse errors', async () => {
    const url = 'https://backfill-malformed.example.com';
    const pubkey = '02' + '3'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc1pvjluezsp5zyg3zyg3';
    global.fetch = mockFetch({ [url]: { status: 402, invoice } });
    const lnd = mockLndClient(
      {},
      { [invoice]: 'HTTP 500: Internal Server Error — {"code":2, "message":"invalid index of 1"}' },
    );

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.skippedInvoiceMalformed).toBe(1);
    expect(summary.skippedDecodeFailed).toBe(0);
  });

  it('counts skippedBreakerOpen when LND circuit breaker is open', async () => {
    const url = 'https://backfill-breaker.example.com';
    const pubkey = '02' + '4'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc10n1pbreakeropen';
    global.fetch = mockFetch({ [url]: { status: 402, invoice } });
    const lnd = mockLndClient(
      {},
      { [invoice]: 'LND circuit breaker open — skipping request: /v1/payreq/...' },
    );

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0 });

    expect(summary.skippedBreakerOpen).toBe(1);
    expect(summary.skippedDecodeFailed).toBe(0);
  });

  it('throws if decodePayReq is not available on the client', async () => {
    const lnd = {
      getInfo: async () => { throw new Error('unused'); },
      getGraph: async () => { throw new Error('unused'); },
      getNodeInfo: async () => { throw new Error('unused'); },
      queryRoutes: async () => { throw new Error('unused'); },
    } as LndGraphClient;

    await expect(backfillServicePrices(pool, lnd, { rateLimitMs: 0 })).rejects.toThrow(/decodePayReq/);
  });

  it('respects limit option', async () => {
    const pubkey = '02' + '2'.repeat(64);
    for (let i = 0; i < 5; i++) {
      await repo.upsert(sha256(pubkey), `https://backfill-limit-${i}.example.com`, 402, 100, '402index');
    }

    global.fetch = mockFetch({});
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, limit: 2 });

    expect(summary.scanned).toBe(2);
  });

  it('retries on ECONNRESET/ETIMEDOUT and succeeds on 3rd attempt', async () => {
    const url = 'https://backfill-retry-reset.example.com';
    const pubkey = '02' + '5'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc30n1pfakeretry1';
    const m = mockFetchWithAttempts({
      [url]: [
        { status: 0, error: 'fetch failed: ECONNRESET' },
        { status: 0, error: 'ETIMEDOUT: connect timeout' },
        { status: 402, invoice },
      ],
    });
    global.fetch = m.fetch;
    const lnd = mockLndClient({ [invoice]: { destination: pubkey, num_satoshis: '30' } });

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, retryBackoffsMs: [0, 0] });

    expect(summary.priced).toBe(1);
    expect(summary.skippedNetworkError).toBe(0);
    expect(m.counts[url]).toBe(3);
  });

  it('retries on 5xx and succeeds on 2nd attempt', async () => {
    const url = 'https://backfill-retry-5xx.example.com';
    const pubkey = '02' + '6'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const invoice = 'lnbc30n1pfakeretry2';
    const m = mockFetchWithAttempts({
      [url]: [
        { status: 503 },
        { status: 402, invoice },
      ],
    });
    global.fetch = m.fetch;
    const lnd = mockLndClient({ [invoice]: { destination: pubkey, num_satoshis: '30' } });

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, retryBackoffsMs: [0, 0] });

    expect(summary.priced).toBe(1);
    expect(m.counts[url]).toBe(2);
  });

  it('classifies persistent 5xx as network_error after retries exhausted', async () => {
    const url = 'https://backfill-5xx-persist.example.com';
    const pubkey = '02' + '7'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const m = mockFetchWithAttempts({
      [url]: [
        { status: 503 },
        { status: 503 },
        { status: 503 },
      ],
    });
    global.fetch = m.fetch;
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, retryBackoffsMs: [0, 0] });

    expect(summary.skippedNetworkError).toBe(1);
    expect(summary.skippedNotL402).toBe(0);
    expect(m.counts[url]).toBe(3);
  });

  it('does not retry on 4xx responses', async () => {
    const url = 'https://backfill-no-retry-4xx.example.com';
    const pubkey = '02' + '8'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const m = mockFetchWithAttempts({
      [url]: [
        { status: 403 },
        { status: 402 },
      ],
    });
    global.fetch = m.fetch;
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, retryBackoffsMs: [0, 0] });

    expect(summary.skippedNotL402).toBe(1);
    expect(summary.priced).toBe(0);
    expect(m.counts[url]).toBe(1);
  });

  it('does not retry on non-retryable errors (e.g. DNS failure)', async () => {
    const url = 'https://backfill-no-retry-dns.example.com';
    const pubkey = '02' + '9'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');

    const m = mockFetchWithAttempts({
      [url]: [
        { status: 0, error: 'ENOTFOUND: getaddrinfo failed' },
        { status: 402 },
      ],
    });
    global.fetch = m.fetch;
    const lnd = mockLndClient({});

    const summary = await backfillServicePrices(pool, lnd, { rateLimitMs: 0, retryBackoffsMs: [0, 0] });

    expect(summary.skippedNetworkError).toBe(1);
    expect(m.counts[url]).toBe(1);
  });
});
