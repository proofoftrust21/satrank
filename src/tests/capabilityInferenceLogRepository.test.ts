// Phase 12.1 (2026-05-05) — capability inference audit-log repository tests.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { CapabilityInferenceLogRepository } from '../repositories/capabilityInferenceLogRepository';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;

describe('Phase 12.1 — CapabilityInferenceLogRepository', () => {
  let repo: CapabilityInferenceLogRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new CapabilityInferenceLogRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE capability_inference_log RESTART IDENTITY CASCADE');
  });

  it('create + findLatestByEndpoint round-trip', async () => {
    const entry = await repo.create({
      endpoint_url: 'https://api.example.com/v1/data',
      model_id: 'claude-haiku-4-5-20251001',
      prompt_hash: 'p'.repeat(64),
      prompt_raw: 'Given the endpoint description...',
      response_raw: '{"input_schema": {...}, "modalities": ["text"]}',
      parsed_capability: {
        input_schema: { type: 'object' },
        modalities: ['text'],
        languages: ['en'],
      },
      run_kind: 'backfill',
      run_id: 'backfill-2026-05-05-01',
      created_at: NOW,
    });
    expect(entry.log_id).toBeGreaterThan(0);
    expect(entry.applied).toBe(false);
    expect(entry.applied_at).toBeNull();
    expect(entry.parsed_capability).toEqual({
      input_schema: { type: 'object' },
      modalities: ['text'],
      languages: ['en'],
    });
    const fetched = await repo.findLatestByEndpoint('https://api.example.com/v1/data');
    expect(fetched).toEqual(entry);
  });

  it('markApplied flips applied + stamps applied_at, only once', async () => {
    const entry = await repo.create({
      endpoint_url: 'https://x.example/api',
      model_id: 'claude-haiku-4-5-20251001',
      prompt_hash: 'a'.repeat(64),
      prompt_raw: '...',
      response_raw: '{}',
      parsed_capability: {},
      run_kind: 'backfill',
      run_id: 'r-1',
      created_at: NOW,
    });
    expect(await repo.markApplied(entry.log_id, NOW + 100)).toBe(true);
    expect(await repo.markApplied(entry.log_id, NOW + 200)).toBe(false); // already applied
    const fetched = await repo.findLatestByEndpoint('https://x.example/api');
    expect(fetched!.applied).toBe(true);
    expect(fetched!.applied_at).toBe(NOW + 100);
  });

  it('findLatestByEndpoint returns the newest of multiple runs', async () => {
    const url = 'https://x.example/api';
    await repo.create({
      endpoint_url: url,
      model_id: 'm1',
      prompt_hash: 'a'.repeat(64),
      prompt_raw: 'v1',
      response_raw: '{}',
      parsed_capability: { v: 1 },
      run_kind: 'backfill',
      run_id: 'r-1',
      created_at: NOW,
    });
    await repo.create({
      endpoint_url: url,
      model_id: 'm2',
      prompt_hash: 'b'.repeat(64),
      prompt_raw: 'v2',
      response_raw: '{}',
      parsed_capability: { v: 2 },
      run_kind: 'review',
      run_id: 'r-2',
      created_at: NOW + 1000,
    });
    const latest = await repo.findLatestByEndpoint(url);
    expect(latest!.parsed_capability).toEqual({ v: 2 });
    expect(latest!.run_kind).toBe('review');
  });

  it('findByRunId returns rows for a given backfill batch', async () => {
    for (let i = 0; i < 3; i += 1) {
      await repo.create({
        endpoint_url: `https://x.example/api${i}`,
        model_id: 'm',
        prompt_hash: 'h'.repeat(64),
        prompt_raw: 'p',
        response_raw: '{}',
        parsed_capability: {},
        run_kind: 'backfill',
        run_id: 'batch-A',
        created_at: NOW + i,
      });
    }
    await repo.create({
      endpoint_url: 'https://x.example/other',
      model_id: 'm',
      prompt_hash: 'h'.repeat(64),
      prompt_raw: 'p',
      response_raw: '{}',
      parsed_capability: {},
      run_kind: 'backfill',
      run_id: 'batch-B',
      created_at: NOW + 100,
    });
    const a = await repo.findByRunId('batch-A');
    expect(a).toHaveLength(3);
    const b = await repo.findByRunId('batch-B');
    expect(b).toHaveLength(1);
  });

  it('runStats counts total/applied/failed', async () => {
    const entry1 = await repo.create({
      endpoint_url: 'https://x.example/a',
      model_id: 'm',
      prompt_hash: 'h'.repeat(64),
      prompt_raw: 'p',
      response_raw: '{}',
      parsed_capability: {},
      run_kind: 'backfill',
      run_id: 'r-1',
      created_at: NOW,
    });
    await repo.create({
      endpoint_url: 'https://x.example/b',
      model_id: 'm',
      prompt_hash: 'h'.repeat(64),
      prompt_raw: 'p',
      response_raw: '{}',
      parsed_capability: {},
      run_kind: 'backfill',
      run_id: 'r-1',
      created_at: NOW + 1,
    });
    await repo.markApplied(entry1.log_id, NOW + 5);
    const stats = await repo.runStats('r-1');
    expect(stats.total).toBe(2);
    expect(stats.applied).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('rejects invalid run_kind', async () => {
    await expect(
      repo.create({
        endpoint_url: 'https://x.example/api',
        model_id: 'm',
        prompt_hash: 'h'.repeat(64),
        prompt_raw: 'p',
        response_raw: '{}',
        parsed_capability: {},
        run_kind: 'invalid' as never,
        run_id: 'r',
        created_at: NOW,
      }),
    ).rejects.toThrow();
  });
});
