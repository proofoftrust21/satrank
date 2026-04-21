import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
let testDb: TestDb;

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('ServiceEndpointRepository', async () => {
  let db: Pool;
  let repo: ServiceEndpointRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new ServiceEndpointRepository(db);
  });

  afterAll(async () => { await teardownTestPool(testDb); });

  it('upsert creates a new entry on first call', async () => {
    await repo.upsert('hash1', 'https://example.com/api', 200, 50);
    const entry = await repo.findByUrl('https://example.com/api');
    expect(entry).toBeDefined();
    expect(entry!.agent_hash).toBe('hash1');
    expect(entry!.last_http_status).toBe(200);
    expect(entry!.last_latency_ms).toBe(50);
    expect(entry!.check_count).toBe(1);
    expect(entry!.success_count).toBe(1);
  });

  it('upsert increments counts on subsequent calls', async () => {
    await repo.upsert('hash1', 'https://example.com/api', 200, 40);
    const entry = await repo.findByUrl('https://example.com/api');
    expect(entry!.check_count).toBe(2);
    expect(entry!.success_count).toBe(2);
  });

  it('402 counts as success', async () => {
    await repo.upsert('hash2', 'https://l402.example.com', 402, 100);
    const entry = await repo.findByUrl('https://l402.example.com');
    expect(entry!.success_count).toBe(1);
  });

  it('500 does not count as success', async () => {
    await repo.upsert('hash3', 'https://down.example.com', 500, 200);
    const entry = await repo.findByUrl('https://down.example.com');
    expect(entry!.check_count).toBe(1);
    expect(entry!.success_count).toBe(0);
  });

  it('findByAgent returns only trusted-source endpoints (excludes ad_hoc)', async () => {
    // ad_hoc is the default source — filtered out of findByAgent (untrusted URL↔agent binding)
    await repo.upsert('agentA', 'https://a1.example.com', 200, 10);
    await repo.upsert('agentA', 'https://a2.example.com', 200, 20);
    // 402index is trusted — visible
    await repo.upsert('agentA', 'https://trusted.example.com', 200, 10, '402index');
    const endpoints = await repo.findByAgent('agentA');
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].url).toBe('https://trusted.example.com');
  });

  it('UNIQUE(url) prevents duplicates but updates agent_hash', async () => {
    await repo.upsert('oldHash', 'https://migrate.example.com', 200, 10);
    await repo.upsert('newHash', 'https://migrate.example.com', 200, 10);
    const entry = await repo.findByUrl('https://migrate.example.com');
    expect(entry!.agent_hash).toBe('newHash');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('findStale returns entries with enough checks and old last_checked_at', async () => {
    // Create an entry that was checked a long time ago
    db.prepare(`
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at)
      VALUES ('staleHash', 'https://stale.example.com', 200, 10, 1000000, 5, 5, 1000000)
    `).run();
    const stale = await repo.findStale(3, 1800, 100);
    expect(stale.some(e => e.url === 'https://stale.example.com')).toBe(true);
  });
});

describe('SSRF protection', () => {
  // Import the function indirectly via the module
  it('blocks private IPs in URLs', async () => {
    const blockedHosts = [
      'http://localhost/api',
      'http://127.0.0.1/api',
      'http://10.0.0.1/api',
      'http://192.168.1.1/api',
      'http://172.16.0.1/api',
      'http://0.0.0.0/api',
      'http://[::1]/api',
    ];
    // We test the regex pattern directly since isUrlBlocked is not exported
    const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;
    for (const url of blockedHosts) {
      const hostname = new URL(url).hostname;
      expect(BLOCKED_HOSTS.test(hostname), `${url} should be blocked`).toBe(true);
    }
  });

  it('allows public URLs', async () => {
    const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;
    const allowedHosts = ['api.example.com', 'satrank.dev', '8.8.8.8'];
    for (const host of allowedHosts) {
      expect(BLOCKED_HOSTS.test(host), `${host} should be allowed`).toBe(false);
    }
  });
});
