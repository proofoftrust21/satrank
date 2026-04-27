import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';
let testDb: TestDb;

describe('RegistryCrawler', async () => {
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

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('constructor accepts a BOLT11 decoder function', () => {
    const mockDecoder = async (_invoice: string) => ({ destination: '03' + 'a'.repeat(64) });
    const crawler = new RegistryCrawler(repo, mockDecoder);
    expect(crawler).toBeDefined();
  });

  it('sha256 of a pubkey produces a valid agent hash', () => {
    const pubkey = '03' + 'a'.repeat(64);
    const hash = sha256(pubkey);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('upsert from registry correctly populates service_endpoints', async () => {
    const pubkey = '03' + 'b'.repeat(64);
    const agentHash = sha256(pubkey);
    await repo.upsert(agentHash, 'https://registry-test.example.com', 0, 0);

    const entry = await repo.findByUrl('https://registry-test.example.com');
    expect(entry).toBeDefined();
    expect(entry!.agent_hash).toBe(agentHash);
    expect(entry!.last_http_status).toBe(0);
  });

  it('URL that changes node updates agent_hash on re-upsert', async () => {
    const pubkey1 = '03' + 'c'.repeat(64);
    const pubkey2 = '03' + 'd'.repeat(64);
    const hash1 = sha256(pubkey1);
    const hash2 = sha256(pubkey2);

    await repo.upsert(hash1, 'https://migrating-service.example.com', 0, 0);
    expect((await repo.findByUrl('https://migrating-service.example.com'))!.agent_hash).toBe(hash1);

    await repo.upsert(hash2, 'https://migrating-service.example.com', 0, 0);
    expect((await repo.findByUrl('https://migrating-service.example.com'))!.agent_hash).toBe(hash2);
  });

  // Phase 13D — regression coverage for service_price_sats population.
  // Bug: updatePrice() ran inside discoverNodeFromUrl() BEFORE upsert() created
  // the row, so the UPDATE affected 0 rows silently and 172/172 service_endpoints
  // ended up with service_price_sats=null in prod.

  function mockIndexAndEndpoint(serviceUrl: string, invoice: string): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        const body = JSON.stringify({
          services: [{ url: serviceUrl, protocol: 'L402', name: 'priced', description: null, category: null, provider: null }],
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === serviceUrl) {
        const headers = new Headers();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="${invoice}"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  it('new URL: upserts row THEN populates service_price_sats from num_satoshis', async () => {
    const url = 'https://priced-new.example.com';
    global.fetch = mockIndexAndEndpoint(url, 'lnbc30n1pfakeinvoicepriced');
    const pubkey = '02' + 'e'.repeat(64);
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '30' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);

    const result = await crawler.run();
    expect(result.discovered).toBeGreaterThanOrEqual(1);

    const entry = await repo.findByUrl(url);
    expect(entry).toBeDefined();
    expect(entry!.agent_hash).toBe(sha256(pubkey));
    expect(entry!.service_price_sats).toBe(30);
  });

  it('existing URL with null price: re-probes and populates price', async () => {
    const url = 'https://priced-backfill.example.com';
    const pubkey = '02' + 'f'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');
    const before = await repo.findByUrl(url);
    expect(before!.service_price_sats).toBeNull();

    global.fetch = mockIndexAndEndpoint(url, 'lnbc30n1pfakeinvoicebackfill');
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '42' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();

    const after = await repo.findByUrl(url);
    expect(after!.service_price_sats).toBe(42);
  });

  // Vague 3 phase 2 — POST support + per-host ingestion cap.

  it('POST: http_method=POST in 402index entry triggers POST fetch on the endpoint', async () => {
    const url = 'https://post-only-service.example.com/api/run';
    const pubkey = '02' + '7'.repeat(64);
    let postReceived = false;
    let getReceived = false;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        const body = JSON.stringify({
          services: [{ url, protocol: 'L402', name: 'post-only', description: null, category: null, provider: null, http_method: 'POST' }],
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === url) {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST') postReceived = true;
        if (method === 'GET') getReceived = true;
        const headers = new Headers();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc20n1pfakepostonly"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '20' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();
    expect(postReceived).toBe(true);
    expect(getReceived).toBe(false); // 402index already advertised POST, no GET attempted
    const entry = await repo.findByUrl(url);
    expect(entry).toBeDefined();
    expect(entry!.last_http_status).toBe(402);
  });

  it('POST fallback: GET returns 405, POST is retried and ingested', async () => {
    const url = 'https://get-405-post-ok.example.com/api/run';
    const pubkey = '02' + '8'.repeat(64);
    let methodSequence: string[] = [];
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        // 402index does NOT advertise http_method here; we still recover via 405 fallback
        const body = JSON.stringify({
          services: [{ url, protocol: 'L402', name: 'get-405', description: null, category: null, provider: null }],
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === url) {
        const method = (init?.method ?? 'GET').toUpperCase();
        methodSequence.push(method);
        if (method === 'GET') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }
        const headers = new Headers();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc20n1pfakefallbackpost"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '20' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();
    expect(methodSequence).toEqual(['GET', 'POST']);
    const entry = await repo.findByUrl(url);
    expect(entry).toBeDefined();
    expect(entry!.last_http_status).toBe(402);
  });

  it('host cap: 4 new URLs on the same host with cap=2 → 2 ingested, 2 capped', async () => {
    // We pass an explicit small cap to the constructor so the test does not
    // burn the 500ms-per-host rate limiter on a 50-URL synthetic load.
    const host = 'capped-host.example.com';
    const services = Array.from({ length: 4 }, (_, i) => ({
      url: `https://${host}/api/svc-${i}`,
      protocol: 'L402',
      name: `cap-${i}`,
      description: null,
      category: null,
      provider: null,
      http_method: 'GET',
    }));
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(JSON.stringify({ services }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.startsWith(`https://${host}/`)) {
        const headers = new Headers();
        const idx = urlStr.split('-').pop();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc10n1pfakecap${idx}"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const pubkey = '02' + '9'.repeat(64);
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '10' });
    // hostIngestionCapPerCycle = 2 for this test
    const crawler = new RegistryCrawler(repo, decodeBolt11, undefined, undefined, 2);
    const result = await crawler.run();
    expect(result.discovered).toBe(2);
    expect(result.capped).toBe(2);
    const ingestedCount = await Promise.all(
      services.map(s => repo.findByUrl(s.url))
    ).then(arr => arr.filter(x => x !== undefined).length);
    expect(ingestedCount).toBe(2);
  });

  it('existing URL with set price: skips re-probe (no needless GET)', async () => {
    const url = 'https://priced-healthy.example.com';
    const pubkey = '02' + '1'.repeat(64);
    await repo.upsert(sha256(pubkey), url, 402, 100, '402index');
    await repo.updatePrice(url, 50);
    const before = await repo.findByUrl(url);
    expect(before!.service_price_sats).toBe(50);

    let probedEndpoint = false;
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        const body = JSON.stringify({
          services: [{ url, protocol: 'L402', name: 'healthy', description: null, category: null, provider: null }],
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === url) {
        probedEndpoint = true;
        const headers = new Headers();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc30n1should-not-be-called"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '99' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();

    expect(probedEndpoint).toBe(false);
    const after = await repo.findByUrl(url);
    expect(after!.service_price_sats).toBe(50);
  });

  // Vague 3 Phase 2.6 — symmetric POST→GET 405 fallback + Accept header +
  // absolute host cap + 404 deprecation streak.

  it('POST→GET symmetric fallback: 402index advertises POST but server expects GET', async () => {
    const url = 'https://maxsats-like.example.com/api/run';
    const pubkey = '02' + 'a'.repeat(64);
    const methodSequence: string[] = [];
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(JSON.stringify({
          services: [{ url, protocol: 'L402', name: 'maxsats-like', description: null, category: null, provider: null, http_method: 'POST' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === url) {
        const method = (init?.method ?? 'GET').toUpperCase();
        methodSequence.push(method);
        if (method === 'POST') {
          // Server says use GET, mimicking maximumsats.com
          return new Response('', { status: 405, headers: { 'Allow': 'GET, HEAD, OPTIONS' } });
        }
        const headers = new Headers();
        headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc20n1pfakemaxsatslike"`);
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '20' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();
    expect(methodSequence).toEqual(['POST', 'GET']); // symmetric fallback fired
    const entry = await repo.findByUrl(url);
    expect(entry).toBeDefined();
    expect(entry!.last_http_status).toBe(402);
  });

  it('Accept header is sent on every probe (preferring JSON, accepting */* fallback)', async () => {
    const url = 'https://strict-accept.example.com/api/check';
    const pubkey = '02' + 'b'.repeat(64);
    let acceptObserved = '';
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(JSON.stringify({
          services: [{ url, protocol: 'L402', name: 'strict', description: null, category: null, provider: null, http_method: 'GET' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr === url) {
        const headers = init?.headers;
        if (headers && typeof headers === 'object' && !Array.isArray(headers) && 'Accept' in (headers as Record<string, string>)) {
          acceptObserved = (headers as Record<string, string>).Accept;
        } else if (headers && Array.isArray(headers)) {
          // Headers as tuples
          const found = (headers as [string, string][]).find(([k]) => k.toLowerCase() === 'accept');
          if (found) acceptObserved = found[1];
        } else if (headers instanceof Headers) {
          acceptObserved = headers.get('accept') ?? '';
        }
        const respHeaders = new Headers();
        respHeaders.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc20n1pfakeacceptcheck"`);
        return new Response('', { status: 402, headers: respHeaders });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '20' });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    await crawler.run();
    expect(acceptObserved).toBe('application/json, */*;q=0.5');
  });

  // Vague 3 Phase 2.7 — x402 protocol detection + invalid_l402 sub-bucketing.

  it('x402: 402 response with payment-required header is bucketed as protocol_x402, not invalid_l402', async () => {
    const url = 'https://x402-host.example.com/api/data';
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(
          JSON.stringify({ services: [{ url, protocol: 'L402', name: 'x402-mislabel' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr === url) {
        const headers = new Headers();
        // x402 servers respond 402 with `payment-required:` (base64 JSON) and
        // no WWW-Authenticate. Real example: api.myceliasignal.com.
        headers.set('payment-required', 'eyJ4NDAyVmVyc2lvbiI6Mn0=');
        headers.set('content-type', 'application/json');
        return new Response('{}', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: '02' + 'a'.repeat(64) });
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    const result = await crawler.run();
    expect(result.preCapSkipped.protocol_x402).toBe(1);
    expect(result.preCapSkipped.invalid_l402).toBe(0);
    expect(result.preCapSkipped.invalid_l402_no_bolt11).toBe(0);
    expect(result.discovered).toBe(0);
    expect(await repo.findByUrl(url)).toBeUndefined();
  });

  it('invalid_l402_no_bolt11: 402 with WWW-Authenticate but no invoice= field', async () => {
    const url = 'https://no-invoice.example.com/api';
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(
          JSON.stringify({ services: [{ url, protocol: 'L402', name: 'no-bolt11' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr === url) {
        const headers = new Headers();
        headers.set('www-authenticate', 'L402 macaroon="abcd", realm="paywall"');
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const crawler = new RegistryCrawler(repo, async () => ({ destination: '02' + 'b'.repeat(64) }));
    const result = await crawler.run();
    expect(result.preCapSkipped.invalid_l402_no_bolt11).toBe(1);
    expect(result.preCapSkipped.invalid_l402).toBe(1);
    expect(result.preCapSkipped.invalid_l402_decode_failed).toBe(0);
    expect(result.preCapSkipped.protocol_x402).toBe(0);
  });

  it('invalid_l402_no_decoder: BOLT11 found but decoder is undefined', async () => {
    const url = 'https://no-decoder.example.com/api';
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(
          JSON.stringify({ services: [{ url, protocol: 'L402', name: 'no-decoder' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr === url) {
        const headers = new Headers();
        headers.set('www-authenticate', 'L402 macaroon="x", invoice="lnbc10n1pfakenodecoder"');
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    // No decodeBolt11 passed → 'no_decoder' branch.
    const crawler = new RegistryCrawler(repo);
    const result = await crawler.run();
    expect(result.preCapSkipped.invalid_l402_no_decoder).toBe(1);
    expect(result.preCapSkipped.invalid_l402).toBe(1);
    expect(result.preCapSkipped.invalid_l402_no_bolt11).toBe(0);
  });

  it('invalid_l402_decode_failed: decoder returns null destination', async () => {
    const url = 'https://decode-fail.example.com/api';
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(
          JSON.stringify({ services: [{ url, protocol: 'L402', name: 'decode-fail' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr === url) {
        const headers = new Headers();
        headers.set('www-authenticate', 'L402 macaroon="x", invoice="lnbc10n1pfakedecodefail"');
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    // Decoder returns null → 'decode_failed' branch.
    const decodeBolt11 = async () => null;
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    const result = await crawler.run();
    expect(result.preCapSkipped.invalid_l402_decode_failed).toBe(1);
    expect(result.preCapSkipped.invalid_l402).toBe(1);
  });

  it('invalid_l402_invoice_malformed: decoder throws bech32-charset error', async () => {
    const url = 'https://malformed.example.com/api';
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(
          JSON.stringify({ services: [{ url, protocol: 'L402', name: 'malformed' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr === url) {
        const headers = new Headers();
        headers.set('www-authenticate', 'L402 macaroon="x", invoice="lnbcgarbageinvoice"');
        return new Response('', { status: 402, headers });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const decodeBolt11 = async () => {
      throw new Error('checksum failed: invalid character not part of charset');
    };
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    const result = await crawler.run();
    expect(result.preCapSkipped.invalid_l402_invoice_malformed).toBe(1);
    expect(result.preCapSkipped.invalid_l402).toBe(1);
  });

  it('invalid_l402 sub-buckets sum to the aggregate count', async () => {
    // Build a synthetic 402index page with 4 endpoints exhibiting each sub-bucket.
    const services = [
      { url: 'https://no-bolt.example/a', protocol: 'L402', name: 'a' },
      { url: 'https://no-decoder.example/b', protocol: 'L402', name: 'b' },
      { url: 'https://decode-null.example/c', protocol: 'L402', name: 'c' },
      { url: 'https://malformed.example/d', protocol: 'L402', name: 'd' },
    ];
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(JSON.stringify({ services }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const h = new Headers();
      if (urlStr.includes('no-bolt.example')) {
        h.set('www-authenticate', 'L402 macaroon="x", realm="paywall"');
      } else {
        h.set('www-authenticate', 'L402 macaroon="x", invoice="lnbc10n1pfakeforsumtest"');
      }
      return new Response('', { status: 402, headers: h });
    }) as typeof fetch;
    // Decoder dispatches per URL: no-decoder host gets undefined decoder via a
    // separate crawler instance below; here we model decode_null + malformed.
    let firstCallSeen = false;
    const decodeBolt11 = async (_invoice: string) => {
      // First decode call → null (decode_failed); second → throw malformed.
      if (!firstCallSeen) {
        firstCallSeen = true;
        return null;
      }
      throw new Error('failed converting data: invalid character not part of charset');
    };
    // Skip the no_decoder URL by removing it from the synthetic page so the
    // assertion doesn't depend on the order in which 402index serves them.
    services.splice(1, 1);
    const crawler = new RegistryCrawler(repo, decodeBolt11);
    const result = await crawler.run();
    const sumSubBuckets =
      result.preCapSkipped.invalid_l402_no_bolt11 +
      result.preCapSkipped.invalid_l402_decode_failed +
      result.preCapSkipped.invalid_l402_invoice_malformed +
      result.preCapSkipped.invalid_l402_no_decoder;
    expect(sumSubBuckets).toBe(result.preCapSkipped.invalid_l402);
    expect(result.preCapSkipped.invalid_l402).toBeGreaterThanOrEqual(2);
  });

  it('absolute host cap: pre-existing host count blocks new ingestion', async () => {
    // Pre-seed 2 URLs on the host so existingByHost = 2 at the start of run.
    const host = 'overcapped.example.com';
    const pre1 = `https://${host}/old1`;
    const pre2 = `https://${host}/old2`;
    const pubkey = '02' + 'c'.repeat(64);
    await repo.upsert(sha256(pubkey), pre1, 402, 100, '402index');
    await repo.upsert(sha256(pubkey), pre2, 402, 100, '402index');

    // 402index advertises 3 NEW URLs on the same host. With absoluteCap=2,
    // none of the 3 should be ingested because the host is already at lifetime cap.
    const newUrls = Array.from({ length: 3 }, (_, i) => ({
      url: `https://${host}/new-${i}`,
      protocol: 'L402',
      name: 'over',
      description: null,
      category: null,
      provider: null,
      http_method: 'GET',
    }));
    global.fetch = (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (urlStr.includes('402index.io/api/v1/services')) {
        return new Response(JSON.stringify({ services: newUrls }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // If the cap is honoured, no /new-N URL is ever requested.
      const headers = new Headers();
      headers.set('www-authenticate', `L402 macaroon="fake", invoice="lnbc10n1pfakeshouldnotrun"`);
      return new Response('', { status: 402, headers });
    }) as typeof fetch;
    const decodeBolt11 = async () => ({ destination: pubkey, num_satoshis: '10' });
    const crawler = new RegistryCrawler(repo, decodeBolt11, undefined, undefined, 50, 2);
    const result = await crawler.run();
    expect(result.discovered).toBe(0);
    expect(result.absoluteCapped).toBe(3);
    // None of the new URLs landed in DB.
    for (const s of newUrls) {
      expect(await repo.findByUrl(s.url)).toBeUndefined();
    }
  });
});
