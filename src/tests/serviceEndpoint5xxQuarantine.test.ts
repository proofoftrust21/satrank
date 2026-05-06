// Phase 12.6 (2026-05-06) — operator quarantine via consecutive_5xx_count.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

let testDb: TestDb;
let pool: Pool;

const URL = 'https://dead-cloudflare.example/api';
const URL_2 = 'https://other.example/api';

async function seed(repo: ServiceEndpointRepository, url: string): Promise<void> {
  // Seed with null agent_hash — quarantine logic doesn't depend on
  // agent linkage. Upsert defaults source='ad_hoc' which is fine here.
  await repo.upsert(null, url, 200, 100);
}

describe('Phase 12.6 — record5xx / clear5xxStreak', () => {
  let repo: ServiceEndpointRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new ServiceEndpointRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE service_endpoints CASCADE');
  });

  it('record5xx increments and stays not-deprecated below threshold', async () => {
    await seed(repo, URL);
    const r1 = await repo.record5xx(URL, 3);
    expect(r1.count).toBe(1);
    expect(r1.deprecated).toBe(false);
    const r2 = await repo.record5xx(URL, 3);
    expect(r2.count).toBe(2);
    expect(r2.deprecated).toBe(false);
  });

  it('record5xx flips deprecated at threshold with reason="5xx_persistent"', async () => {
    await seed(repo, URL);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3);
    const r3 = await repo.record5xx(URL, 3);
    expect(r3.count).toBe(3);
    expect(r3.deprecated).toBe(true);
    const row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true);
    expect(row!.deprecated_reason).toBe('5xx_persistent');
    expect(row!.consecutive_5xx_count).toBe(3);
  });

  it('clear5xxStreak resets counter + clears deprecated when reason matches', async () => {
    await seed(repo, URL);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3); // deprecated
    await repo.clear5xxStreak(URL);
    const row = await repo.findByUrl(URL);
    expect(row!.consecutive_5xx_count).toBe(0);
    expect(row!.deprecated).toBe(false);
    expect(row!.deprecated_reason).toBeNull();
  });

  it('clear5xxStreak does NOT clear deprecated when reason was 404_persistent', async () => {
    await seed(repo, URL);
    // Force a 404-deprecated state via record404 (existing path).
    const r1 = await repo.record404(URL, 3);
    const r2 = await repo.record404(URL, 3);
    const r3 = await repo.record404(URL, 3);
    let row = await repo.findByUrl(URL);
    // record404 returns the last seen state ; the row in DB may differ if
    // there's a probe-side reset. Cross-check both views for fail diagnosis.
    expect({ count: row!.consecutive_404_count, deprecated: row!.deprecated, returns: [r1, r2, r3] })
      .toMatchObject({ count: 3, deprecated: true, returns: [
        { count: 1, deprecated: false },
        { count: 2, deprecated: false },
        { count: 3, deprecated: true },
      ] });
    expect(row!.deprecated_reason).toBe('404_persistent');
    // Pretend a 5xx happened later (race), then clear5xxStreak. Must NOT
    // unstick the 404 deprecation.
    await repo.record5xx(URL, 3);
    await repo.clear5xxStreak(URL);
    row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true); // still 404-deprecated
    expect(row!.deprecated_reason).toBe('404_persistent');
  });

  it('clear5xxStreak is no-op when count was 0', async () => {
    await seed(repo, URL);
    await repo.clear5xxStreak(URL);
    const row = await repo.findByUrl(URL);
    expect(row!.consecutive_5xx_count).toBe(0);
    expect(row!.deprecated).toBe(false);
  });

  it('record5xx unknown URL returns count=0 deprecated=false', async () => {
    const r = await repo.record5xx('https://unknown.example/api', 3);
    expect(r.count).toBe(0);
    expect(r.deprecated).toBe(false);
  });

  it('5xx and 404 streaks are independent counters per row', async () => {
    await seed(repo, URL);
    await seed(repo, URL_2);
    await repo.record5xx(URL, 3);
    await repo.record404(URL_2, 3);
    const a = await repo.findByUrl(URL);
    const b = await repo.findByUrl(URL_2);
    expect(a!.consecutive_5xx_count).toBe(1);
    expect(a!.consecutive_404_count).toBe(0);
    expect(b!.consecutive_5xx_count).toBe(0);
    expect(b!.consecutive_404_count).toBe(1);
  });
});
