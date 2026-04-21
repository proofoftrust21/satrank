// Phase 12B B6.1 — warmup probe never crashes the boot.
//
// The probe must succeed on an empty schema (no service_endpoints at all)
// and on a populated DB (at least one category). It must also swallow any
// query error and return `ok: false` without throwing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { runWarmup } from '../warmup';

describe('runWarmup — Phase 12B B6.1', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestPool();
  });

  afterAll(async () => {
    await teardownTestPool(db);
  });

  it('resolves on an empty schema without throwing', async () => {
    await truncateAll(db.pool);
    const result = await runWarmup(db.pool);
    expect(result.ok).toBe(true);
    expect(result.categoriesLoaded).toBe(0);
    expect(result.firstCategory).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('loads categories when data is present', async () => {
    await truncateAll(db.pool);
    const now = Math.floor(Date.now() / 1000);
    await db.pool.query(
      `INSERT INTO service_endpoints
         (url, agent_hash, provider, category, name, check_count, success_count, last_checked_at, created_at, source)
       VALUES
         ($1, $2, 'test', 'data', 'demo', 10, 9, $5, $5, 'self_registered'),
         ($3, $4, 'test', 'tools', 'demo2', 10, 9, $5, $5, 'self_registered')`,
      [
        'https://example.com/a',
        'a'.repeat(64),
        'https://example.com/b',
        'b'.repeat(64),
        now,
      ],
    );

    const result = await runWarmup(db.pool);
    expect(result.ok).toBe(true);
    expect(result.categoriesLoaded).toBeGreaterThan(0);
    expect(result.firstCategory).not.toBeNull();
  });

  it('returns ok=false when the pool is closed, without throwing', async () => {
    const dead = new Pool({ connectionString: db.databaseUrl, max: 1 });
    await dead.end();
    const result = await runWarmup(dead);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
