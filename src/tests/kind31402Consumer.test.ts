// Sim 8 follow-up — Kind31402Consumer tests.
//
// We don't test the live relay subscription path (covered by integration);
// instead we exercise the event handler logic by injecting events directly
// through the public handleEvent method via a test harness.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { Kind31402Consumer, isLightningPmi, isCrawlerOriginEvent } from '../nostr/kind31402Consumer';
import type { ProbeResult, RegistryCrawler } from '../crawler/registryCrawler';
import type { NostrEventLike } from '../nostr/nostrEventSubscriber';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

describe('isLightningPmi', () => {
  it('matches Lightning rails', () => {
    expect(isLightningPmi(['l402'])).toBe(true);
    expect(isLightningPmi(['lightning'])).toBe(true);
    expect(isLightningPmi(['bitcoin-lightning-bolt11'])).toBe(true);
    expect(isLightningPmi(['bolt11'])).toBe(true);
    expect(isLightningPmi(['l402', 'x402'])).toBe(true); // mixed → still Lightning
  });

  it('rejects non-Lightning rails', () => {
    expect(isLightningPmi([])).toBe(false);
    expect(isLightningPmi(['x402'])).toBe(false);
    expect(isLightningPmi(['cashu'])).toBe(false);
    expect(isLightningPmi(['xcashu'])).toBe(false);
    expect(isLightningPmi(['payment'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLightningPmi(['L402'])).toBe(true);
    expect(isLightningPmi(['Lightning'])).toBe(true);
  });
});

describe('isCrawlerOriginEvent', () => {
  it('detects source=crawl tag', () => {
    expect(isCrawlerOriginEvent([['source', 'crawl']])).toBe(true);
    expect(isCrawlerOriginEvent([['source', 'CRAWL']])).toBe(true);
  });
  it('passes self-announced events', () => {
    expect(isCrawlerOriginEvent([['source', 'self']])).toBe(false);
    expect(isCrawlerOriginEvent([])).toBe(false);
    expect(isCrawlerOriginEvent([['name', 'foo']])).toBe(false);
  });
});

describe('Kind31402Consumer.handleEvent', async () => {
  let pool: Pool;
  let repo: ServiceEndpointRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new ServiceEndpointRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(() => { /* no-op */ });

  afterEach(async () => {
    await pool.query('TRUNCATE service_endpoints RESTART IDENTITY CASCADE');
  });

  function buildEvent(tags: string[][], opts: { id?: string; pubkey?: string } = {}): NostrEventLike {
    return {
      id: opts.id ?? 'evt-' + Math.random().toString(36).slice(2, 10),
      pubkey: opts.pubkey ?? 'a'.repeat(64),
      kind: 31402,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '{}',
      sig: 'b'.repeat(128),
    };
  }

  function fakeProber(map: Record<string, ProbeResult>): Pick<RegistryCrawler, 'probeUrl'> {
    return {
      probeUrl: async (url: string): Promise<ProbeResult> =>
        map[url] ?? { result: null, outcome: { finalStatus: 0, methodUsed: 'GET', reason: 'network_error' } },
    };
  }

  /** Bypass the live subscriber by reaching into the consumer's event
   *  handler. This isolates the ingestion logic from the relay layer. */
  function dispatch(consumer: Kind31402Consumer, event: NostrEventLike): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (consumer as any).handleEvent(event);
  }

  /** Always-true verify for tests where signature isn't the focus. */
  const verifyOk = () => true;
  const verifyReject = () => false;

  it('ingests new clearnet HTTPS URLs from a Lightning event', async () => {
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'a'.repeat(64)), priceSats: 10, latencyMs: 30 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({ 'https://op.example/x': probe }),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['d', 'op-x'],
      ['name', 'op'],
      ['url', 'https://op.example/x'],
      ['pmi', 'l402'],
    ]));
    const stats = consumer.getStats();
    expect(stats.eventsReceived).toBe(1);
    expect(stats.urlsDiscovered).toBe(1);
  });

  it('audit M1 — events with bad signature are rejected, no probe fired', async () => {
    let proberCalls = 0;
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: { probeUrl: async () => { proberCalls++; return { result: null, outcome: null }; } },
      verifyEvent: verifyReject,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://attacker.example/api'],
      ['pmi', 'l402'],
    ]));
    expect(proberCalls).toBe(0);
    expect(consumer.getStats().eventsIgnoredBadSignature).toBe(1);
    expect(consumer.getStats().urlsAttempted).toBe(0);
  });

  it('audit M1 — verifier throwing is treated as fail-closed', async () => {
    const verifyThrows = () => { throw new Error('schnorr lib failure'); };
    let proberCalls = 0;
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: { probeUrl: async () => { proberCalls++; return { result: null, outcome: null }; } },
      verifyEvent: verifyThrows,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://x.example/api'],
      ['pmi', 'l402'],
    ]));
    expect(proberCalls).toBe(0);
    expect(consumer.getStats().eventsIgnoredBadSignature).toBe(1);
  });

  it('audit M2 — events with > MAX_URLS_PER_EVENT URLs are truncated', async () => {
    const probeMap: Record<string, ProbeResult> = {};
    for (let i = 0; i < 20; i++) {
      probeMap[`https://h${i}.example/x`] = {
        result: { agentHash: sha256(`02${'9'.repeat(62)}${i}`.padEnd(66, '0')), priceSats: 1, latencyMs: 5 },
        outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
      };
    }
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber(probeMap),
      verifyEvent: verifyOk,
    });
    const tags: string[][] = [['pmi', 'l402']];
    for (let i = 0; i < 20; i++) tags.push(['url', `https://h${i}.example/x`]);
    await dispatch(consumer, buildEvent(tags));
    // Cap is 5 — only first 5 URLs are probed.
    expect(consumer.getStats().urlsAttempted).toBe(5);
    expect(consumer.getStats().eventsTruncatedUrls).toBe(1);
  });

  it('drops crawler-origin events to avoid HTTP-discovered duplicates', async () => {
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({}),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['d', 'crawl-x'],
      ['url', 'https://x.example/x'],
      ['pmi', 'l402'],
      ['source', 'crawl'],
    ]));
    const stats = consumer.getStats();
    expect(stats.eventsIgnoredCrawler).toBe(1);
    expect(stats.urlsAttempted).toBe(0);
  });

  it('drops x402-only events (Lightning-pure invariant)', async () => {
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({}),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://usdc.example/x'],
      ['pmi', 'x402'],
    ]));
    expect(consumer.getStats().eventsIgnoredNonLightning).toBe(1);
    expect(consumer.getStats().urlsAttempted).toBe(0);
  });

  it('ingests when one of multiple PMIs is Lightning', async () => {
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'b'.repeat(64)), priceSats: 5, latencyMs: 25 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({ 'https://multi.example/x': probe }),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://multi.example/x'],
      ['pmi', 'l402'],
      ['pmi', 'x402'],
    ]));
    expect(consumer.getStats().urlsDiscovered).toBe(1);
  });

  it('skips .onion and other non-HTTPS URL transports without erroring', async () => {
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'c'.repeat(64)), priceSats: 5, latencyMs: 20 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({ 'https://clearnet.example/x': probe }),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://clearnet.example/x'],
      ['url', 'http://abcdefg.onion/x'],
      ['url', 'http://insecure.example/x'],
      ['pmi', 'l402'],
    ]));
    expect(consumer.getStats().urlsAttempted).toBe(1);
    expect(consumer.getStats().urlsDiscovered).toBe(1);
  });

  it('cross-source dedup: existing 402index URL gets nostr_31402 appended', async () => {
    const url = 'https://known.example/x';
    await repo.upsert(sha256('02' + 'd'.repeat(64)), url, 402, 50, '402index');

    let proberCalls = 0;
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: { probeUrl: async () => { proberCalls++; return { result: null, outcome: null }; } },
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['url', url],
      ['pmi', 'l402'],
    ]));
    expect(proberCalls).toBe(0);
    expect(consumer.getStats().urlsMergedExisting).toBe(1);
    const after = await repo.findByUrl(url);
    expect(after!.sources.sort()).toEqual(['402index', 'nostr_31402']);
  });

  it('events without url tags are counted malformed but do not crash', async () => {
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({}),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['d', 'no-url'],
      ['name', 'malformed'],
      ['pmi', 'l402'],
    ]));
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('skips templated URL but continues processing other URLs in same event', async () => {
    const probe: ProbeResult = {
      result: { agentHash: sha256('02' + 'e'.repeat(64)), priceSats: 1, latencyMs: 10 },
      outcome: { finalStatus: 402, methodUsed: 'GET', reason: 'success' },
    };
    const consumer = new Kind31402Consumer({
      serviceEndpointRepo: repo,
      registryCrawler: fakeProber({ 'https://op.example/api': probe }),
      verifyEvent: verifyOk,
    });
    await dispatch(consumer, buildEvent([
      ['url', 'https://op.example/api/{id}'],
      ['url', 'https://op.example/api'],
      ['pmi', 'l402'],
    ]));
    expect(consumer.getStats().urlsSkippedTemplated).toBe(1);
    expect(consumer.getStats().urlsDiscovered).toBe(1);
  });
});
