// Voie 1 — alimentation de preimage_pool via crawler (402index).
// L'idempotence repose sur INSERT OR IGNORE au niveau DB ; on vérifie ici
// qu'un second run ne modifie pas le tier/source.
//
// Phase 10 (2026-04-20) : Voie 2 (/api/decide bolt11Raw) retirée avec
// l'endpoint. Le pool reste alimenté par le crawler (voie 1) et par les
// reports voie 3 qui self-déclarent un bolt11Raw.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { PreimagePoolRepository } from '../../repositories/preimagePoolRepository';
import { ServiceEndpointRepository } from '../../repositories/serviceEndpointRepository';
import { RegistryCrawler } from '../../crawler/registryCrawler';
let testDb: TestDb;

// BOLT11 mainnet from BOLT11 spec (payment_hash connu, utilisé aussi dans bolt11Parser.test.ts)
const MAINNET_INVOICE = 'lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq';
const MAINNET_PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

// Mock 402index response server handler — returns a single L402 endpoint
// whose WWW-Authenticate carries the BOLT11 fixture.
function mockFetchFactory(invoiceToReturn: string): typeof fetch {
  const fakeFetch: typeof fetch = async (input: string | URL | Request) => {
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    if (urlStr.includes('402index.io/api/v1/services')) {
      const body = JSON.stringify({
        services: [{ url: 'https://api.example.com/svc', protocol: 'L402', name: 'example', description: null, category: null, provider: null }],
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('api.example.com/svc')) {
      const headers = new Headers();
      headers.set('www-authenticate', `L402 macaroon="fakemacaroon", invoice="${invoiceToReturn}"`);
      return new Response('', { status: 402, headers });
    }
    return new Response('not found', { status: 404 });
  };
  return fakeFetch;
}

describe('Voie 1 — registryCrawler alimente preimage_pool (tier=medium, source=crawler)', async () => {
  let db: Pool;
  let serviceEndpointRepo: ServiceEndpointRepository;
  let preimagePoolRepo: PreimagePoolRepository;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    serviceEndpointRepo = new ServiceEndpointRepository(db);
    preimagePoolRepo = new PreimagePoolRepository(db);
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await teardownTestPool(testDb);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('insère le payment_hash du BOLT11 découvert avec tier=medium, source=crawler', async () => {
    global.fetch = mockFetchFactory(MAINNET_INVOICE);
    const decodeBolt11 = async () => ({ destination: '02' + 'a'.repeat(64), num_satoshis: '2000' });
    const crawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo);
    await crawler.run();

    const entry = await preimagePoolRepo.findByPaymentHash(MAINNET_PAYMENT_HASH);
    expect(entry).not.toBeNull();
    expect(entry?.confidence_tier).toBe('medium');
    expect(entry?.source).toBe('crawler');
    expect(entry?.bolt11_raw).toBe(MAINNET_INVOICE);
    expect(entry?.consumed_at).toBeNull();
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('est idempotent — un second run ne modifie pas le tier/source', async () => {
    global.fetch = mockFetchFactory(MAINNET_INVOICE);
    const decodeBolt11 = async () => ({ destination: '02' + 'a'.repeat(64), num_satoshis: '2000' });
    const crawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo);
    await crawler.run();
    await crawler.run();

    const counts = await preimagePoolRepo.countByTier();
    expect(counts.medium).toBe(1);
    expect(counts.low).toBe(0);
  });
});
