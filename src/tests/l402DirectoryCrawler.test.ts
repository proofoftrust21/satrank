// Vague 3 Phase 3 — l402.directory crawler tests.
//
// Covers: feed parsing, paid+live filtering, templated URL skip, cross-source
// dedup (existing 402index URL → attachSource without re-probe), net-new
// ingestion through registry probe primitive, conservation of the funnel,
// per-host caps re-use.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { L402DirectoryCrawler } from '../crawler/l402DirectoryCrawler';
import type { ProbeResult, RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

describe('L402DirectoryCrawler', async () => {
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
    await pool.query('TRUNCATE service_endpoints RESTART IDENTITY CASCADE');
  });

  /** Build a fake l402.directory feed response. */
  function feedResponse(services: unknown[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('l402.directory/api/services')) {
        return new Response(JSON.stringify({ count: services.length, services }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  /** Mock RegistryCrawler.probeUrl that maps URL → fixed result. */
  function fakeProber(map: Record<string, ProbeResult>): Pick<RegistryCrawler, 'probeUrl'> {
    return {
      probeUrl: async (url: string): Promise<ProbeResult> =>
        map[url] ?? { result: null, outcome: { finalStatus: 0, methodUsed: 'GET', reason: 'network_error' } },
    };
  }

  it('parses feed shape: count + services + endpoints', async () => {
    global.fetch = feedResponse([
      {
        service_id: 'svc1',
        name: 'Test',
        status: 'live',
        endpoints: [
          { url: 'https://example.com/paid', method: 'GET', pricing: { amount: 10, currency: 'sats', model: 'per-request' } },
        ],
        provider: { name: 'TestCo', contact: 'ops@test.co' },
      },
    ]);
    const probeResult: ProbeResult = {
      result: { agentHash: sha256('02' + 'a'.repeat(64)), priceSats: 10, latencyMs: 42 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const crawler = new L402DirectoryCrawler(repo, fakeProber({ 'https://example.com/paid': probeResult }));

    const r = await crawler.run();
    expect(r.totalServices).toBe(1);
    expect(r.totalEndpointsRaw).toBe(1);
    expect(r.candidates).toBe(1);
    expect(r.discovered).toBe(1);
  });

  it('skips offline services, free endpoints, and templated URLs into dedicated buckets', async () => {
    global.fetch = feedResponse([
      // offline service — entire endpoints array contributes to service_offline
      {
        service_id: 'offline',
        name: 'Offline',
        status: 'offline',
        endpoints: [
          { url: 'https://offline.example/paid', method: 'GET', pricing: { amount: 10 } },
        ],
        provider: {},
      },
      // live service with mix of paid/free/templated
      {
        service_id: 'live',
        name: 'Live',
        status: 'live',
        endpoints: [
          { url: 'https://live.example/free', method: 'GET', pricing: { amount: 0, model: 'free' } },
          { url: 'https://live.example/paid/{id}', method: 'GET', pricing: { amount: 10 } },
          { url: 'https://live.example/paid', method: 'GET', pricing: { amount: 10 } },
        ],
        provider: {},
      },
    ]);
    const probeResult: ProbeResult = {
      result: { agentHash: sha256('02' + 'b'.repeat(64)), priceSats: 10, latencyMs: 42 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const crawler = new L402DirectoryCrawler(repo, fakeProber({ 'https://live.example/paid': probeResult }));
    const r = await crawler.run();

    expect(r.totalEndpointsRaw).toBe(4);
    expect(r.preCapSkipped.service_offline).toBe(1);
    expect(r.preCapSkipped.not_paid).toBe(1);
    expect(r.preCapSkipped.templated_url).toBe(1);
    expect(r.candidates).toBe(1);
    expect(r.discovered).toBe(1);
  });

  it('cross-source dedup: existing 402index URL gets sources merged without re-probing', async () => {
    const url = 'https://overlap.example.com/api';
    const existingHash = sha256('02' + 'c'.repeat(64));
    await repo.upsert(existingHash, url, 402, 50, '402index');

    const before = await repo.findByUrl(url);
    expect(before!.sources).toEqual(['402index']);

    global.fetch = feedResponse([
      {
        service_id: 'svc',
        name: 'Overlap',
        status: 'live',
        endpoints: [
          { url, method: 'GET', pricing: { amount: 5 }, consumption: { type: 'api_response' } },
        ],
        provider: { contact: 'merge@example.com' },
      },
    ]);

    // Critical assertion: the prober should NEVER be called for an existing URL.
    let proberCalls = 0;
    const observingProber: Pick<RegistryCrawler, 'probeUrl'> = {
      probeUrl: async () => {
        proberCalls++;
        return { result: null, outcome: null };
      },
    };
    const crawler = new L402DirectoryCrawler(repo, observingProber);
    const r = await crawler.run();

    expect(proberCalls).toBe(0);
    expect(r.mergedExisting).toBe(1);
    expect(r.discovered).toBe(0);

    const after = await repo.findByUrl(url);
    expect(after!.sources.sort()).toEqual(['402index', 'l402directory']);
    // 402index has higher trust rank than l402directory: legacy `source` stays.
    expect(after!.source).toBe('402index');
    // New signals filled in.
    expect(after!.consumption_type).toBe('api_response');
    expect(after!.provider_contact).toBe('merge@example.com');
    // Probe counters NOT incremented — attachSource doesn't touch them.
    expect(after!.check_count).toBe(before!.check_count);
  });

  it('re-running on already-attributed URL is a no-op (alreadyAttributed bucket)', async () => {
    const url = 'https://idem.example.com/api';
    await repo.upsert(sha256('02' + 'd'.repeat(64)), url, 402, 50, '402index');
    await repo.attachSource(url, 'l402directory', { consumption_type: 'api_response' });

    global.fetch = feedResponse([
      {
        service_id: 'svc',
        name: 'Idem',
        status: 'live',
        endpoints: [{ url, method: 'GET', pricing: { amount: 5 }, consumption: { type: 'api_response' } }],
        provider: {},
      },
    ]);
    const crawler = new L402DirectoryCrawler(repo, fakeProber({}));
    const r = await crawler.run();

    expect(r.alreadyAttributed).toBe(1);
    expect(r.mergedExisting).toBe(0);
    expect(r.discovered).toBe(0);
  });

  it('net-new endpoint via probe: persists source=l402directory and consumption_type', async () => {
    const url = 'https://newonly.example.com/api';
    global.fetch = feedResponse([
      {
        service_id: 'newsvc',
        name: 'NewOnly',
        status: 'live',
        endpoints: [{ url, method: 'POST', pricing: { amount: 100 }, consumption: { type: 'browser' } }],
        provider: { contact: 'hello@newonly.com' },
      },
    ]);
    const probeResult: ProbeResult = {
      result: { agentHash: sha256('02' + 'e'.repeat(64)), priceSats: 100, latencyMs: 75 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new L402DirectoryCrawler(repo, fakeProber({ [url]: probeResult }));
    const r = await crawler.run();

    expect(r.discovered).toBe(1);
    const ep = await repo.findByUrl(url);
    expect(ep!.source).toBe('l402directory');
    expect(ep!.sources).toEqual(['l402directory']);
    expect(ep!.consumption_type).toBe('browser');
    expect(ep!.provider_contact).toBe('hello@newonly.com');
  });

  it('absolute host cap blocks new ingestion when host already saturated', async () => {
    // Pre-saturate "saturated.example.com" with 2 endpoints; cap=2.
    await repo.upsert(sha256('02' + 'f'.repeat(64)), 'https://saturated.example.com/a', 402, 50, '402index');
    await repo.upsert(sha256('02' + 'f'.repeat(64)), 'https://saturated.example.com/b', 402, 50, '402index');

    global.fetch = feedResponse([
      {
        service_id: 'sat',
        name: 'Saturated',
        status: 'live',
        endpoints: [
          { url: 'https://saturated.example.com/c', method: 'GET', pricing: { amount: 10 } },
        ],
        provider: {},
      },
    ]);
    let proberCalls = 0;
    const observingProber: Pick<RegistryCrawler, 'probeUrl'> = {
      probeUrl: async () => {
        proberCalls++;
        return { result: null, outcome: null };
      },
    };
    const crawler = new L402DirectoryCrawler(repo, observingProber, 50, 2);
    const r = await crawler.run();

    expect(r.absoluteCapped).toBe(1);
    expect(r.discovered).toBe(0);
    expect(r.absoluteCappedHosts).toContain('saturated.example.com');
    // Prober must not be called when the cap kicks in — saves rate-limited probes.
    expect(proberCalls).toBe(0);
  });

  it('conservation: totalEndpointsRaw = sum of every outcome bucket', async () => {
    global.fetch = feedResponse([
      {
        service_id: 'svc',
        name: 'Mix',
        status: 'live',
        endpoints: [
          { url: 'https://example.com/a', method: 'GET', pricing: { amount: 10 } }, // discovered
          { url: 'https://example.com/free', method: 'GET', pricing: { amount: 0 } }, // not_paid
          { url: 'https://example.com/{id}', method: 'GET', pricing: { amount: 10 } }, // templated_url
          { url: 'https://example.com/dead', method: 'GET', pricing: { amount: 10 } }, // 404
        ],
        provider: {},
      },
      {
        service_id: 'off',
        name: 'Offline',
        status: 'offline',
        endpoints: [
          { url: 'https://offline.example/x', method: 'GET', pricing: { amount: 10 } }, // service_offline
        ],
        provider: {},
      },
    ]);
    const successProbe: ProbeResult = {
      result: { agentHash: sha256('aa'.repeat(32)), priceSats: 10, latencyMs: 50 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const fossilProbe: ProbeResult = {
      result: null,
      outcome: { finalStatus: 404, methodUsed: 'GET', reason: 'fossil_404' },
    };
    const crawler = new L402DirectoryCrawler(
      repo,
      fakeProber({ 'https://example.com/a': successProbe, 'https://example.com/dead': fossilProbe }),
    );
    const r = await crawler.run();

    const skippedSum =
      r.preCapSkipped.not_paid +
      r.preCapSkipped.service_offline +
      r.preCapSkipped.templated_url +
      r.preCapSkipped.unsafe_url +
      r.preCapSkipped.no_response +
      r.preCapSkipped.method_405_both +
      r.preCapSkipped.not_acceptable_406 +
      r.preCapSkipped.not_402 +
      r.preCapSkipped.fossil_404 +
      r.preCapSkipped.invalid_l402 +
      r.preCapSkipped.other;

    expect(r.discovered + r.mergedExisting + r.alreadyAttributed + r.capped + r.absoluteCapped + skippedSum).toBe(
      r.totalEndpointsRaw,
    );
    expect(r.discovered).toBe(1);
    expect(r.preCapSkipped.fossil_404).toBe(1);
    expect(r.preCapSkipped.not_paid).toBe(1);
    expect(r.preCapSkipped.templated_url).toBe(1);
    expect(r.preCapSkipped.service_offline).toBe(1);
  });

  it('feed fetch failure: errors counted, no crash', async () => {
    global.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const crawler = new L402DirectoryCrawler(repo, fakeProber({}));
    const r = await crawler.run();

    expect(r.errors).toBe(1);
    expect(r.totalServices).toBe(0);
    expect(r.totalEndpointsRaw).toBe(0);
  });
});

describe('attachSource — cross-source dedup primitive', async () => {
  let pool: Pool;
  let repo: ServiceEndpointRepository;
  let testDb2: TestDb;

  beforeAll(async () => {
    testDb2 = await setupTestPool();
    pool = testDb2.pool;
    repo = new ServiceEndpointRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb2);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE service_endpoints RESTART IDENTITY CASCADE');
  });

  it('sources column starts with the inserted source via upsert', async () => {
    const url = 'https://attach1.example.com';
    await repo.upsert(sha256('aa'.repeat(32)), url, 402, 100, '402index');
    const ep = await repo.findByUrl(url);
    expect(ep!.sources).toEqual(['402index']);
  });

  it('attachSource adds source and reports added=true on first call', async () => {
    const url = 'https://attach2.example.com';
    await repo.upsert(sha256('bb'.repeat(32)), url, 402, 100, '402index');
    const r = await repo.attachSource(url, 'l402directory');
    expect(r).toEqual({ found: true, added: true });
    const ep = await repo.findByUrl(url);
    expect(ep!.sources.sort()).toEqual(['402index', 'l402directory']);
  });

  it('attachSource is idempotent: second call reports added=false', async () => {
    const url = 'https://attach3.example.com';
    await repo.upsert(sha256('cc'.repeat(32)), url, 402, 100, '402index');
    await repo.attachSource(url, 'l402directory');
    const r = await repo.attachSource(url, 'l402directory');
    expect(r).toEqual({ found: true, added: false });
    const ep = await repo.findByUrl(url);
    expect(ep!.sources.sort()).toEqual(['402index', 'l402directory']);
  });

  it('attachSource on unknown URL returns found=false', async () => {
    const r = await repo.attachSource('https://does-not-exist.example.com', 'l402directory');
    expect(r).toEqual({ found: false, added: false });
  });

  it('attachSource fills consumption_type and provider_contact only when NULL', async () => {
    const url = 'https://attach4.example.com';
    await repo.upsert(sha256('dd'.repeat(32)), url, 402, 100, '402index');

    // First attach fills in.
    await repo.attachSource(url, 'l402directory', {
      consumption_type: 'browser',
      provider_contact: 'first@example.com',
    });
    const after1 = await repo.findByUrl(url);
    expect(after1!.consumption_type).toBe('browser');
    expect(after1!.provider_contact).toBe('first@example.com');

    // Second attach must NOT overwrite — COALESCE keeps the existing value.
    await repo.attachSource(url, 'l402directory', {
      consumption_type: 'api_response',
      provider_contact: 'second@example.com',
    });
    const after2 = await repo.findByUrl(url);
    expect(after2!.consumption_type).toBe('browser');
    expect(after2!.provider_contact).toBe('first@example.com');
  });

  it('legacy `source` upgrades when a higher-trust attribution arrives', async () => {
    const url = 'https://attach5.example.com';
    // Start with l402directory (rank 3).
    await repo.upsert(sha256('ee'.repeat(32)), url, 402, 100, 'l402directory');
    const after1 = await repo.findByUrl(url);
    expect(after1!.source).toBe('l402directory');

    // 402index attribution (rank 4) arrives — must promote.
    await repo.attachSource(url, '402index');
    const after2 = await repo.findByUrl(url);
    expect(after2!.source).toBe('402index');
    expect(after2!.sources.sort()).toEqual(['402index', 'l402directory']);
  });

  it('legacy `source` does NOT downgrade when a lower-trust attribution arrives', async () => {
    const url = 'https://attach6.example.com';
    await repo.upsert(sha256('ff'.repeat(32)), url, 402, 100, '402index');
    await repo.attachSource(url, 'self_registered');
    const ep = await repo.findByUrl(url);
    expect(ep!.source).toBe('402index'); // unchanged
    expect(ep!.sources.sort()).toEqual(['402index', 'self_registered']);
  });

  it('countBySources returns the diversification breakdown', async () => {
    await repo.upsert(sha256('11'.repeat(32)), 'https://both.example.com', 402, 100, '402index');
    await repo.attachSource('https://both.example.com', 'l402directory');
    await repo.upsert(sha256('22'.repeat(32)), 'https://only-402.example.com', 402, 100, '402index');
    await repo.upsert(sha256('33'.repeat(32)), 'https://only-l402.example.com', 402, 100, 'l402directory');

    const breakdown = await repo.countBySources();
    const map = new Map<string, number>(breakdown.map((b) => [b.sources.sort().join(','), b.count]));
    expect(map.get('402index')).toBe(1);
    expect(map.get('l402directory')).toBe(1);
    expect(map.get('402index,l402directory')).toBe(1);
  });
});
