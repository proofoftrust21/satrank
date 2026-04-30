// Sim 8 follow-up — AwesomeL402Crawler tests.
//
// Covers: markdown URL extraction (link + bare), blocklist enforcement,
// cross-source dedup, net-new probe ingestion.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { AwesomeL402Crawler, extractHttpsUrls } from '../crawler/awesomeL402Crawler';
import type { ProbeResult, RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

const README_URL = 'https://raw.githubusercontent.com/Fewsats/awesome-L402/main/README.md';

describe('extractHttpsUrls', () => {
  it('extracts URLs from markdown links', () => {
    const md = '[Foo](https://example.com/foo) and [Bar](https://example.org/bar?q=1)';
    expect(extractHttpsUrls(md).sort()).toEqual([
      'https://example.com/foo',
      'https://example.org/bar?q=1',
    ]);
  });

  it('extracts bare URLs', () => {
    const md = 'See https://bare.example/x for more.';
    expect(extractHttpsUrls(md)).toContain('https://bare.example/x');
  });

  it('deduplicates link + bare for the same URL', () => {
    const md = '[Foo](https://example.com/x) — also at https://example.com/x';
    expect(extractHttpsUrls(md)).toEqual(['https://example.com/x']);
  });

  it('strips trailing punctuation', () => {
    const md = 'Visit https://example.com/x.';
    expect(extractHttpsUrls(md)).toEqual(['https://example.com/x']);
  });

  it('skips http:// (HTTP only)', () => {
    expect(extractHttpsUrls('http://insecure.example')).toEqual([]);
  });
});

describe('AwesomeL402Crawler', async () => {
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

  function readmeFetch(markdown: string, status = 200): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr === README_URL) {
        return new Response(markdown, { status, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  function fakeProber(map: Record<string, ProbeResult>): Pick<RegistryCrawler, 'probeUrl'> {
    return {
      probeUrl: async (url: string): Promise<ProbeResult> =>
        map[url] ?? { result: null, outcome: { finalStatus: 0, methodUsed: 'GET', reason: 'not_402' } },
    };
  }

  it('blocklists GitHub repos and known dormant services', async () => {
    global.fetch = readmeFetch(`
- [GitHub repo](https://github.com/Fewsats/awesome-L402)
- [Satring](https://satring.com)
- [Bitcoinsearch chat](https://chat.bitcoinsearch.xyz)
- [Real service](https://maybe-l402.example/api)
    `);
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'a'.repeat(64)), priceSats: 5, latencyMs: 30 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const crawler = new AwesomeL402Crawler(
      repo,
      fakeProber({ 'https://maybe-l402.example/api': probe }),
    );
    const r = await crawler.run();
    expect(r.preCapSkipped.blocklisted).toBeGreaterThanOrEqual(3);
    expect(r.discovered).toBe(1);
  });

  it('cross-source dedup: existing 402index URL gets awesome_l402 appended', async () => {
    const url = 'https://hyperdope.com/api';
    await repo.upsert(sha256('02' + 'b'.repeat(64)), url, 402, 50, '402index');

    // README must be ≥100 chars or the malformed_readme guard kicks in.
    global.fetch = readmeFetch(`
# Awesome-L402

A curated list of L402 services.

## Projects

- [Hyperdope](${url}) — video streaming
    `);

    let proberCalls = 0;
    const observing: Pick<RegistryCrawler, 'probeUrl'> = {
      probeUrl: async () => {
        proberCalls++;
        return { result: null, outcome: null };
      },
    };
    const crawler = new AwesomeL402Crawler(repo, observing);
    const r = await crawler.run();
    expect(proberCalls).toBe(0);
    expect(r.mergedExisting).toBe(1);
    const after = await repo.findByUrl(url);
    expect(after!.sources.sort()).toEqual(['402index', 'awesome_l402']);
  });

  it('README fetch failure increments errors and returns gracefully', async () => {
    global.fetch = readmeFetch('boom', 500);
    const crawler = new AwesomeL402Crawler(repo, fakeProber({}));
    const r = await crawler.run();
    expect(r.errors).toBe(1);
    expect(r.preCapSkipped.no_response).toBe(1);
    expect(r.discovered).toBe(0);
  });

  it('README too short → malformed_readme bucket', async () => {
    global.fetch = readmeFetch('# tiny');
    const crawler = new AwesomeL402Crawler(repo, fakeProber({}));
    const r = await crawler.run();
    expect(r.preCapSkipped.malformed_readme).toBe(1);
  });

  it('non-L402 candidates land in not_402 funnel without ingesting', async () => {
    global.fetch = readmeFetch(`
The README is a useful place that mostly lists things like
[some homepage](https://homepage.example) plus the long
description that brings the document above the malformed-readme threshold
of 100 characters used by the crawler.
    `);
    const crawler = new AwesomeL402Crawler(
      repo,
      fakeProber({}),  // default is not_402
    );
    const r = await crawler.run();
    expect(r.candidates).toBe(1);
    expect(r.preCapSkipped.not_402).toBe(1);
    expect(r.discovered).toBe(0);
  });
});
