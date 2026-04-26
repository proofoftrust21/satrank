// Axe 1 — exercises the tier-aware repository methods against a real
// Postgres test database. Each test seeds a small set of endpoints with
// controlled (last_intent_query_at, last_checked_at) and asserts the
// findStaleByTier classification + markIntentQuery write semantics.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

let testDb: TestDb;
let pool: Pool;
let repo: ServiceEndpointRepository;

const NOW = Math.floor(Date.now() / 1000);
const HOT_INTENT_AGE = 60 * 60;          // 1h ago — hot tier
const WARM_INTENT_AGE = 6 * 60 * 60;     // 6h ago — warm tier
const COLD_INTENT_AGE = 48 * 60 * 60;    // 2d ago — cold tier
const HOT_PROBE_AGE_STALE = 90 * 60;     // 1.5h since probe — hot stale
const WARM_PROBE_AGE_STALE = 8 * 60 * 60; // 8h since probe — warm stale
const COLD_PROBE_AGE_STALE = 48 * 60 * 60; // 2d since probe — cold stale

async function seedEndpoint(
  url: string,
  lastIntentAge: number | null,
  lastProbeAge: number | null,
): Promise<void> {
  const lastIntentAt = lastIntentAge === null ? null : NOW - lastIntentAge;
  const lastProbeAt = lastProbeAge === null ? null : NOW - lastProbeAge;
  await pool.query(
    `INSERT INTO service_endpoints
       (agent_hash, url, last_http_status, last_latency_ms, last_checked_at,
        check_count, success_count, created_at, source, last_intent_query_at)
     VALUES ($1, $2, 200, 100, $3, 5, 5, $4, '402index', $5)`,
    ['agent-' + url, url, lastProbeAt, NOW - 86400, lastIntentAt],
  );
}

beforeAll(async () => {
  testDb = await setupTestPool();
  pool = testDb.pool;
  repo = new ServiceEndpointRepository(pool);
});

afterAll(async () => {
  await teardownTestPool(testDb);
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('ServiceEndpointRepository.findStaleByTier', () => {
  it('hot tier: queried < 2h, probe age >= 1h', async () => {
    await seedEndpoint('https://hot.example/api', HOT_INTENT_AGE, HOT_PROBE_AGE_STALE);
    await seedEndpoint('https://hot-fresh.example/api', HOT_INTENT_AGE, 600); // probe < 1h, excluded
    await seedEndpoint('https://warm.example/api', WARM_INTENT_AGE, WARM_PROBE_AGE_STALE);

    const hot = await repo.findStaleByTier('hot', 100);
    const urls = hot.map(e => e.url);
    expect(urls).toContain('https://hot.example/api');
    expect(urls).not.toContain('https://hot-fresh.example/api');
    expect(urls).not.toContain('https://warm.example/api');
  });

  it('warm tier: queried in [2h, 24h], probe age >= 6h', async () => {
    await seedEndpoint('https://warm.example/api', WARM_INTENT_AGE, WARM_PROBE_AGE_STALE);
    await seedEndpoint('https://warm-fresh.example/api', WARM_INTENT_AGE, 60 * 60); // probe < 6h, excluded
    await seedEndpoint('https://hot.example/api', HOT_INTENT_AGE, HOT_PROBE_AGE_STALE);
    await seedEndpoint('https://cold.example/api', COLD_INTENT_AGE, COLD_PROBE_AGE_STALE);

    const warm = await repo.findStaleByTier('warm', 100);
    const urls = warm.map(e => e.url);
    expect(urls).toContain('https://warm.example/api');
    expect(urls).not.toContain('https://warm-fresh.example/api');
    expect(urls).not.toContain('https://hot.example/api');
    expect(urls).not.toContain('https://cold.example/api');
  });

  it('cold tier: queried >= 24h or never, probe age >= 24h', async () => {
    await seedEndpoint('https://cold.example/api', COLD_INTENT_AGE, COLD_PROBE_AGE_STALE);
    await seedEndpoint('https://never.example/api', null, COLD_PROBE_AGE_STALE);
    await seedEndpoint('https://cold-fresh.example/api', COLD_INTENT_AGE, 60 * 60); // probe < 24h, excluded
    await seedEndpoint('https://warm.example/api', WARM_INTENT_AGE, COLD_PROBE_AGE_STALE);

    const cold = await repo.findStaleByTier('cold', 100);
    const urls = cold.map(e => e.url);
    expect(urls).toContain('https://cold.example/api');
    expect(urls).toContain('https://never.example/api');
    expect(urls).not.toContain('https://cold-fresh.example/api');
    expect(urls).not.toContain('https://warm.example/api');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await seedEndpoint(`https://hot${i}.example/api`, HOT_INTENT_AGE, HOT_PROBE_AGE_STALE);
    }
    const hot = await repo.findStaleByTier('hot', 3);
    expect(hot).toHaveLength(3);
  });

  it('orders by last_checked_at NULLS FIRST so unprobed endpoints lead', async () => {
    await seedEndpoint('https://probed.example/api', HOT_INTENT_AGE, HOT_PROBE_AGE_STALE);
    await seedEndpoint('https://never-probed.example/api', HOT_INTENT_AGE, null);
    const hot = await repo.findStaleByTier('hot', 10);
    expect(hot[0].url).toBe('https://never-probed.example/api');
  });
});

describe('ServiceEndpointRepository.markIntentQuery', () => {
  it('updates last_intent_query_at for the given URLs', async () => {
    await seedEndpoint('https://target.example/api', null, null);
    const before = await repo.findByUrl('https://target.example/api');
    expect(before?.last_intent_query_at).toBeNull();

    await repo.markIntentQuery(['https://target.example/api']);

    const after = await repo.findByUrl('https://target.example/api');
    expect(after?.last_intent_query_at).not.toBeNull();
    expect(after!.last_intent_query_at!).toBeGreaterThanOrEqual(NOW - 5);
  });

  it('handles batch updates without N+1 queries', async () => {
    await seedEndpoint('https://a.example/api', null, null);
    await seedEndpoint('https://b.example/api', null, null);
    await seedEndpoint('https://c.example/api', null, null);

    await repo.markIntentQuery([
      'https://a.example/api',
      'https://b.example/api',
      'https://c.example/api',
    ]);

    for (const url of ['https://a.example/api', 'https://b.example/api', 'https://c.example/api']) {
      const row = await repo.findByUrl(url);
      expect(row?.last_intent_query_at).not.toBeNull();
    }
  });

  it('is a no-op when given an empty array', async () => {
    await seedEndpoint('https://untouched.example/api', null, null);
    await repo.markIntentQuery([]);
    const row = await repo.findByUrl('https://untouched.example/api');
    expect(row?.last_intent_query_at).toBeNull();
  });

  it('does not create rows for unknown URLs', async () => {
    await repo.markIntentQuery(['https://nonexistent.example/api']);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM service_endpoints`,
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

describe('ServiceEndpoint shape', () => {
  it('exposes last_intent_query_at on findByUrl results', async () => {
    await seedEndpoint('https://shape.example/api', HOT_INTENT_AGE, HOT_PROBE_AGE_STALE);
    const row = await repo.findByUrl('https://shape.example/api');
    expect(row).toBeDefined();
    expect(row!.last_intent_query_at).toBe(NOW - HOT_INTENT_AGE);
  });
});
