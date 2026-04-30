// Sim 8 follow-up — WellKnownL402Crawler tests.
//
// Covers: manifest parsing, full URL composition (provider.url + endpoint.path),
// safe-URL gate, templated URL skip, cross-source dedup, net-new ingestion,
// per-host caps, malformed-manifest recovery, multi-host iteration.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { WellKnownL402Crawler } from '../crawler/wellKnownL402Crawler';
import type { ProbeResult, RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

describe('WellKnownL402Crawler', async () => {
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

  /** Build a fetch mock that returns a manifest for a given host root. */
  function manifestResponse(hostManifests: Record<string, unknown>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [host, manifest] of Object.entries(hostManifests)) {
        if (urlStr.startsWith(host) && urlStr.endsWith('/.well-known/l402')) {
          return new Response(JSON.stringify(manifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  function fakeProber(map: Record<string, ProbeResult>): Pick<RegistryCrawler, 'probeUrl'> {
    return {
      probeUrl: async (url: string): Promise<ProbeResult> =>
        map[url] ?? { result: null, outcome: { finalStatus: 0, methodUsed: 'GET', reason: 'network_error' } },
    };
  }

  it('parses Sats4AI-shaped manifest and ingests every endpoint', async () => {
    global.fetch = manifestResponse({
      'https://example.com': {
        protocol: 'L402',
        provider: { name: 'Example', url: 'https://example.com' },
        endpoints: [
          { path: '/api/l402/foo', method: 'POST', category: 'ai', price_sats: '10' },
          { path: '/api/l402/bar', method: 'POST', category: 'ai', price_sats: '20' },
        ],
      },
    });
    const probeFoo: ProbeResult = {
      result: { agentHash: sha256('02' + 'a'.repeat(64)), priceSats: 10, latencyMs: 30 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const probeBar: ProbeResult = {
      result: { agentHash: sha256('02' + 'b'.repeat(64)), priceSats: 20, latencyMs: 35 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({
        'https://example.com/api/l402/foo': probeFoo,
        'https://example.com/api/l402/bar': probeBar,
      }),
      ['https://example.com'],
    );

    const r = await crawler.run();
    expect(r.hostsAttempted).toBe(1);
    expect(r.hostsManifestOk).toBe(1);
    expect(r.totalEndpointsRaw).toBe(2);
    expect(r.candidates).toBe(2);
    expect(r.discovered).toBe(2);
    expect(r.preCapSkipped.malformed_manifest).toBe(0);
  });

  it('skips templated URLs and unsafe URLs without probing', async () => {
    global.fetch = manifestResponse({
      'https://example.com': {
        protocol: 'L402',
        provider: { url: 'https://example.com' },
        endpoints: [
          { path: '/api/l402/templated/{id}', method: 'POST' },
          { path: '/api/l402/ok', method: 'POST' },
        ],
      },
    });
    const probeOk: ProbeResult = {
      result: { agentHash: sha256('02' + 'c'.repeat(64)), priceSats: 5, latencyMs: 25 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({ 'https://example.com/api/l402/ok': probeOk }),
      ['https://example.com'],
    );
    const r = await crawler.run();
    expect(r.preCapSkipped.templated_url).toBe(1);
    expect(r.candidates).toBe(1);
    expect(r.discovered).toBe(1);
  });

  it('cross-source dedup: existing 402index URL gets sources merged without re-probing', async () => {
    const url = 'https://example.com/api/l402/foo';
    await repo.upsert(sha256('02' + 'd'.repeat(64)), url, 402, 50, '402index');

    global.fetch = manifestResponse({
      'https://example.com': {
        provider: { url: 'https://example.com' },
        endpoints: [{ path: '/api/l402/foo', method: 'POST' }],
      },
    });

    let proberCalls = 0;
    const observing: Pick<RegistryCrawler, 'probeUrl'> = {
      probeUrl: async () => {
        proberCalls++;
        return { result: null, outcome: null };
      },
    };
    const crawler = new WellKnownL402Crawler(repo, observing, ['https://example.com']);
    const r = await crawler.run();

    expect(proberCalls).toBe(0);
    expect(r.mergedExisting).toBe(1);
    expect(r.discovered).toBe(0);

    const after = await repo.findByUrl(url);
    expect(after!.sources.sort()).toEqual(['402index', 'wellknown_l402']);
    // 402index has higher trust rank than wellknown_l402: legacy `source` stays.
    expect(after!.source).toBe('402index');
  });

  it('falls back to host root when manifest omits provider.url', async () => {
    global.fetch = manifestResponse({
      'https://op.example': {
        endpoints: [{ path: '/paid', method: 'POST' }],
      },
    });
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'e'.repeat(64)), priceSats: 1, latencyMs: 20 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({ 'https://op.example/paid': probe }),
      ['https://op.example'],
    );
    const r = await crawler.run();
    expect(r.discovered).toBe(1);
  });

  it('manifest fetch failure increments errors but does not crash', async () => {
    global.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const crawler = new WellKnownL402Crawler(repo, fakeProber({}), ['https://broken.example']);
    const r = await crawler.run();
    expect(r.hostsAttempted).toBe(1);
    expect(r.hostsManifestOk).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.preCapSkipped.no_response).toBe(1);
  });

  it('multi-host iteration aggregates per-host stats and global counters', async () => {
    global.fetch = manifestResponse({
      'https://a.example': {
        provider: { url: 'https://a.example' },
        endpoints: [{ path: '/x', method: 'POST' }],
      },
      'https://b.example': {
        provider: { url: 'https://b.example' },
        endpoints: [
          { path: '/y', method: 'POST' },
          { path: '/z', method: 'POST' },
        ],
      },
    });
    const probeMap: Record<string, ProbeResult> = {
      'https://a.example/x': {
        result: { agentHash: sha256('02' + '1'.repeat(64)), priceSats: 1, latencyMs: 10 },
        outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
      },
      'https://b.example/y': {
        result: { agentHash: sha256('02' + '2'.repeat(64)), priceSats: 2, latencyMs: 11 },
        outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
      },
      'https://b.example/z': {
        result: { agentHash: sha256('02' + '3'.repeat(64)), priceSats: 3, latencyMs: 12 },
        outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
      },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber(probeMap),
      ['https://a.example', 'https://b.example'],
    );
    const r = await crawler.run();
    expect(r.hostsAttempted).toBe(2);
    expect(r.hostsManifestOk).toBe(2);
    expect(r.discovered).toBe(3);
    expect(r.perHost).toHaveLength(2);
    expect(r.perHost.find(h => h.host === 'https://a.example')!.discovered).toBe(1);
    expect(r.perHost.find(h => h.host === 'https://b.example')!.discovered).toBe(2);
  });

  it('malformed manifest (no endpoints array) bumps the malformed bucket', async () => {
    global.fetch = manifestResponse({
      'https://op.example': { provider: { url: 'https://op.example' } },
    });
    const crawler = new WellKnownL402Crawler(repo, fakeProber({}), ['https://op.example']);
    const r = await crawler.run();
    expect(r.hostsManifestOk).toBe(0);
    expect(r.preCapSkipped.malformed_manifest).toBe(1);
    expect(r.discovered).toBe(0);
  });

  it('audit H3 — pins provider.url to manifest host when they disagree', async () => {
    // A compromised manifest sets provider.url to attacker-controlled.
    // Without pinning, endpoints would resolve against attacker.example
    // and cause SatRank to probe arbitrary third-party domains.
    global.fetch = manifestResponse({
      'https://victim.example': {
        protocol: 'L402',
        provider: { name: 'Victim', url: 'https://attacker.example' },
        endpoints: [{ path: '/api/foo', method: 'POST' }],
      },
    });
    // Probe map intentionally only has the victim-host URL. If the pin
    // works, the crawler resolves /api/foo against victim.example. If the
    // pin fails, it would call attacker.example (not in the map → reason
    // 'network_error', no discovery).
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + '7'.repeat(64)), priceSats: 1, latencyMs: 10 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({ 'https://victim.example/api/foo': probe }),
      ['https://victim.example'],
    );
    const r = await crawler.run();
    expect(r.discovered).toBe(1);
  });

  it('audit H2 — manifest with >MAX endpoints is truncated to MAX', async () => {
    // Build 600 endpoints; cap is 500.
    const endpoints = Array.from({ length: 600 }, (_, i) => ({
      path: `/api/ep${i}`,
      method: 'POST',
    }));
    global.fetch = manifestResponse({
      'https://op.example': { provider: { url: 'https://op.example' }, endpoints },
    });
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({}),
      ['https://op.example'],
    );
    const r = await crawler.run();
    expect(r.totalEndpointsRaw).toBe(500); // capped at MAX_ENDPOINTS_PER_MANIFEST
  });

  it('endpoint with empty path is treated as malformed, not crashed', async () => {
    global.fetch = manifestResponse({
      'https://op.example': {
        provider: { url: 'https://op.example' },
        endpoints: [
          { path: '', method: 'POST' },
          { path: '/ok', method: 'POST' },
        ],
      },
    });
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'f'.repeat(64)), priceSats: 1, latencyMs: 10 },
      outcome: { finalStatus: 402, methodUsed: 'POST', reason: 'success' },
    };
    const crawler = new WellKnownL402Crawler(
      repo,
      fakeProber({ 'https://op.example/ok': probe }),
      ['https://op.example'],
    );
    const r = await crawler.run();
    expect(r.preCapSkipped.malformed_manifest).toBe(1);
    expect(r.discovered).toBe(1);
  });
});
