// Sim 8 follow-up — L402IndexRssCrawler tests.
//
// Covers: RSS parser (regex-based), x402 filtering (Lightning-pure invariant),
// templated URL skip, cross-source dedup, net-new probe ingestion, malformed
// feed recovery, fetch failure handling.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { L402IndexRssCrawler, parseFeed } from '../crawler/l402IndexRssCrawler';
import type { ProbeResult, RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

const FEED_URL = 'https://402index.io/feed.xml';

function buildFeed(items: Array<{ url: string; method?: string; protocol?: 'L402' | 'x402' | string }>): string {
  const itemsXml = items
    .map(it => {
      const methodAttr = it.method ? ` method="${it.method}"` : '';
      const protoAttr = it.protocol ? `<l402:protocol type="${it.protocol}" health="healthy" reliability="90"/>` : '';
      return `
  <item>
    <title>x</title>
    <link>https://402index.io/service/x</link>
    <category>data</category>
    <l402:endpoint url="${it.url}"${methodAttr}/>
    ${protoAttr}
    <l402:price sats="10" usd=""/>
  </item>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:l402="https://402index.io/ns/l402">
  <channel>
    <title>402 Index</title>
    <link>https://402index.io</link>${itemsXml}
  </channel>
</rss>`;
}

describe('parseFeed', () => {
  it('extracts L402 endpoints, drops x402, keeps method', () => {
    const xml = buildFeed([
      { url: 'https://a.example/x', method: 'GET', protocol: 'L402' },
      { url: 'https://b.example/y', method: 'POST', protocol: 'x402' },
      { url: 'https://c.example/z', method: 'POST', protocol: 'L402' },
    ]);
    const r = parseFeed(xml);
    expect(r.rawCount).toBe(3);
    expect(r.x402Filtered).toBe(1);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({ url: 'https://a.example/x', method: 'GET', protocol: 'L402' });
    expect(r.items[1]).toEqual({ url: 'https://c.example/z', method: 'POST', protocol: 'L402' });
  });

  it('defaults method=GET when unspecified, includes unknown-protocol items', () => {
    const xml = buildFeed([
      { url: 'https://a.example/x' },
    ]);
    const r = parseFeed(xml);
    expect(r.items[0].method).toBe('GET');
    expect(r.items[0].protocol).toBe('unknown');
  });

  it('returns empty on malformed XML without throwing', () => {
    expect(() => parseFeed('<rss>not closed')).not.toThrow();
    const r = parseFeed('<rss>not closed');
    expect(r.items).toEqual([]);
    expect(r.rawCount).toBe(0);
  });
});

describe('L402IndexRssCrawler', async () => {
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

  function feedFetch(xml: string, status = 200): typeof fetch {
    return (async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr === FEED_URL) {
        return new Response(xml, { status, headers: { 'Content-Type': 'application/rss+xml' } });
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

  it('ingests new L402 items, drops x402 items into the funnel', async () => {
    global.fetch = feedFetch(buildFeed([
      { url: 'https://lightning.example/x', method: 'GET', protocol: 'L402' },
      { url: 'https://usdc.example/y', method: 'POST', protocol: 'x402' },
    ]));
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'a'.repeat(64)), priceSats: 10, latencyMs: 30 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const crawler = new L402IndexRssCrawler(
      repo,
      fakeProber({ 'https://lightning.example/x': probe }),
    );
    const r = await crawler.run();
    expect(r.totalItemsRaw).toBe(2);
    expect(r.preCapSkipped.protocol_x402).toBe(1);
    expect(r.candidates).toBe(1);
    expect(r.discovered).toBe(1);
  });

  it('cross-source dedup: existing 402index URL gets l402index_rss appended without re-probing', async () => {
    const url = 'https://overlap.example/api';
    await repo.upsert(sha256('02' + 'b'.repeat(64)), url, 402, 50, '402index');

    global.fetch = feedFetch(buildFeed([
      { url, method: 'GET', protocol: 'L402' },
    ]));

    let proberCalls = 0;
    const observing: Pick<RegistryCrawler, 'probeUrl'> = {
      probeUrl: async () => {
        proberCalls++;
        return { result: null, outcome: null };
      },
    };
    const crawler = new L402IndexRssCrawler(repo, observing);
    const r = await crawler.run();
    expect(proberCalls).toBe(0);
    expect(r.mergedExisting).toBe(1);
    const after = await repo.findByUrl(url);
    expect(after!.sources.sort()).toEqual(['402index', 'l402index_rss']);
  });

  it('feed fetch failure increments errors and no_response, returns gracefully', async () => {
    global.fetch = feedFetch('boom', 500);
    const crawler = new L402IndexRssCrawler(repo, fakeProber({}));
    const r = await crawler.run();
    expect(r.errors).toBe(1);
    expect(r.preCapSkipped.no_response).toBe(1);
    expect(r.discovered).toBe(0);
  });

  it('skips templated URLs into dedicated bucket', async () => {
    global.fetch = feedFetch(buildFeed([
      { url: 'https://template.example/api/{id}', method: 'GET', protocol: 'L402' },
      { url: 'https://normal.example/api', method: 'GET', protocol: 'L402' },
    ]));
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'c'.repeat(64)), priceSats: 1, latencyMs: 20 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const crawler = new L402IndexRssCrawler(
      repo,
      fakeProber({ 'https://normal.example/api': probe }),
    );
    const r = await crawler.run();
    expect(r.preCapSkipped.templated_url).toBe(1);
    expect(r.discovered).toBe(1);
  });

  it('audit H2 — feed with >MAX items is truncated', async () => {
    const items: Array<{ url: string; method?: string; protocol?: string }> = [];
    for (let i = 0; i < 600; i++) items.push({ url: `https://h${i}.example/x`, method: 'GET', protocol: 'L402' });
    global.fetch = feedFetch(buildFeed(items));
    const crawler = new L402IndexRssCrawler(repo, fakeProber({}));
    const r = await crawler.run();
    expect(r.totalItemsRaw).toBe(500); // capped at MAX_ITEMS_PARSED
  });

  it('100-item realistic feed: aggregate funnel totals match input', async () => {
    const items: Array<{ url: string; method?: string; protocol?: string }> = [];
    for (let i = 0; i < 50; i++) items.push({ url: `https://lh${i}.example/x`, method: 'GET', protocol: 'L402' });
    for (let i = 0; i < 30; i++) items.push({ url: `https://us${i}.example/x`, method: 'GET', protocol: 'x402' });
    global.fetch = feedFetch(buildFeed(items));
    // Probe map: only ingest the first 5 successfully so the rest land in a
    // concrete miss bucket (simulating real probe outcomes).
    const probeMap: Record<string, ProbeResult> = {};
    for (let i = 0; i < 5; i++) {
      probeMap[`https://lh${i}.example/x`] = {
        result: { agentHash: sha256(`02${'d'.repeat(62)}${i}`.padEnd(66, '0')), priceSats: 5, latencyMs: 20 },
        outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
      };
    }
    const crawler = new L402IndexRssCrawler(repo, fakeProber(probeMap));
    const r = await crawler.run();
    expect(r.totalItemsRaw).toBe(80);
    expect(r.preCapSkipped.protocol_x402).toBe(30);
    expect(r.candidates).toBe(50);
    expect(r.discovered).toBe(5);
  });
});
