// Phase 5.14 — endpoint_stage_posteriors repo : roundtrip observe + read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import {
  EndpointStagePosteriorsRepository,
  STAGE_CHALLENGE,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';

let testDb: TestDb;

describe('EndpointStagePosteriorsRepository', () => {
  let pool: Pool;
  let repo: EndpointStagePosteriorsRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new EndpointStagePosteriorsRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  it('observe inserts a row with default prior + 1 success', async () => {
    const url = 'https://stage-test-1.example.com/api';
    await repo.observe({ endpoint_url: url, stage: STAGE_CHALLENGE, success: true });
    const stages = await repo.findAllStages(url);
    expect(stages.size).toBe(1);
    const ch = stages.get(STAGE_CHALLENGE)!;
    // After 1 success starting from prior Beta(1.5, 1.5) → α≈2.5, β≈1.5
    expect(ch.alpha).toBeCloseTo(2.5, 1);
    expect(ch.beta).toBeCloseTo(1.5, 1);
    expect(ch.p_success).toBeCloseTo(2.5 / 4, 1);
  });

  it('observe accumulates successes and failures correctly', async () => {
    const url = 'https://stage-test-2.example.com/api';
    const now = 1_700_000_000;
    // 5 successes + 2 failures, in same epoch (no decay between).
    for (let i = 0; i < 5; i++) {
      await repo.observe({ endpoint_url: url, stage: STAGE_PAYMENT, success: true }, now);
    }
    for (let i = 0; i < 2; i++) {
      await repo.observe({ endpoint_url: url, stage: STAGE_PAYMENT, success: false }, now);
    }
    // Read at exactly the same `now` → no decay applied.
    const stages = await repo.findAllStages(url, now);
    const pay = stages.get(STAGE_PAYMENT)!;
    // α ≈ 1.5 + 5 = 6.5, β ≈ 1.5 + 2 = 3.5, p ≈ 0.65
    expect(pay.alpha).toBeCloseTo(6.5, 1);
    expect(pay.beta).toBeCloseTo(3.5, 1);
    expect(pay.p_success).toBeCloseTo(0.65, 1);
    expect(pay.n_obs_effective).toBeCloseTo(7, 1);
  });

  it('weighted observation uses the provided weight', async () => {
    const url = 'https://stage-test-3.example.com/api';
    const now = 1_700_000_000;
    await repo.observe(
      { endpoint_url: url, stage: STAGE_PAYMENT, success: true, weight: 2 },
      now,
    );
    const stages = await repo.findAllStages(url, now);
    const pay = stages.get(STAGE_PAYMENT)!;
    // α ≈ 1.5 + 2 = 3.5
    expect(pay.alpha).toBeCloseTo(3.5, 1);
  });

  it('decay-at-read : reading at t + 7 days halves the evidence mass towards prior', async () => {
    const url = 'https://stage-test-4.example.com/api';
    const t0 = 1_700_000_000;
    // 10 successes → α ≈ 11.5, β ≈ 1.5
    for (let i = 0; i < 10; i++) {
      await repo.observe({ endpoint_url: url, stage: STAGE_DELIVERY, success: true }, t0);
    }
    const sevenDays = 7 * 24 * 3600;
    const stagesAt7d = await repo.findAllStages(url, t0 + sevenDays);
    const at7d = stagesAt7d.get(STAGE_DELIVERY)!;
    // Decay factor = exp(-1) ≈ 0.368 (since τ = 7 days)
    // α' = 1.5 + (11.5 - 1.5) × 0.368 ≈ 1.5 + 3.68 = 5.18
    expect(at7d.alpha).toBeCloseTo(5.18, 1);
    expect(at7d.beta).toBeCloseTo(1.5, 1);
    // p_success stays high (mass loss is symmetric in this example, but
    // proportions on success-only data don't drift much).
    expect(at7d.p_success).toBeGreaterThan(0.7);
  });

  it('multiple stages on the same endpoint are stored independently', async () => {
    const url = 'https://stage-test-5.example.com/api';
    const now = 1_700_000_000;
    await repo.observe({ endpoint_url: url, stage: STAGE_CHALLENGE, success: true }, now);
    await repo.observe({ endpoint_url: url, stage: STAGE_PAYMENT, success: false }, now);
    const stages = await repo.findAllStages(url, now);
    expect(stages.size).toBe(2);
    expect(stages.get(STAGE_CHALLENGE)!.p_success).toBeGreaterThan(0.5);
    expect(stages.get(STAGE_PAYMENT)!.p_success).toBeLessThan(0.5);
    expect(stages.has(STAGE_DELIVERY)).toBe(false); // not observed
  });

  it('findAllStages returns an empty map for an unknown endpoint', async () => {
    const url = 'https://unknown-endpoint.example.com/api';
    const stages = await repo.findAllStages(url);
    expect(stages.size).toBe(0);
  });
});
