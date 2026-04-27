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
});
