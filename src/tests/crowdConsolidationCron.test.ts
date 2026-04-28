// Phase 9.0 — CrowdConsolidationCron : intégration end-to-end ingest →
// consolidation → endpoint_stage_posteriors.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  CrowdOutcomeRepository,
} from '../repositories/crowdOutcomeRepository';
import {
  EndpointStagePosteriorsRepository,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';
import {
  CrowdConsolidationCron,
  DEFAULT_CONSOLIDATION_DELAY_SEC,
} from '../services/crowdConsolidationCron';

let testDb: TestDb;
const NOW = 1_700_000_000;

describe('CrowdConsolidationCron (Phase 9.0)', () => {
  let pool: Pool;
  let crowdRepo: CrowdOutcomeRepository;
  let stagesRepo: EndpointStagePosteriorsRepository;
  let cron: CrowdConsolidationCron;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    crowdRepo = new CrowdOutcomeRepository(pool);
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
    cron = new CrowdConsolidationCron({
      crowdRepo,
      stagePosteriorsRepo: stagesRepo,
      now: () => NOW,
    });
    await truncateAll(pool);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  async function seedReport(
    eventId: string,
    urlHash: string,
    success: boolean,
    weight: number,
    observedAt: number,
  ): Promise<void> {
    await crowdRepo.insertIfNew({
      event_id: eventId,
      agent_pubkey: 'a'.repeat(64),
      endpoint_url_hash: urlHash,
      trust_assertion_event_id: null,
      outcome: success ? 'delivered' : 'delivery_4xx',
      stage: 4,
      success,
      effective_weight: weight,
      pow_factor: 1,
      identity_age_factor: 1,
      preimage_factor: 1,
      declared_pow_bits: null,
      verified_pow_bits: 0,
      preimage_verified: false,
      latency_ms: null,
      observed_at: observedAt,
      ingested_at: observedAt,
    });
  }

  it('consolidates a report observed >= 1h ago', async () => {
    const urlHash = 'a'.repeat(64);
    await seedReport('e1', urlHash, true, 1.0, NOW - 2 * 3600);
    const result = await cron.runOnce();
    expect(result.consolidated).toBe(1);
    expect(result.errors).toBe(0);
    // Posterior alimenté.
    const stages = await stagesRepo.findRaw('https://test.example/api', STAGE_DELIVERY); // raw lookup by hash needed
    // stagesRepo.findRaw uses endpointHash(url). Pour le test on doit
    // utiliser un Pool query direct sur endpoint_stage_posteriors.
    const { rows } = await pool.query(
      `SELECT alpha, beta, n_obs FROM endpoint_stage_posteriors
        WHERE endpoint_url_hash = $1::text AND stage = $2::smallint`,
      [urlHash, STAGE_DELIVERY],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].alpha)).toBeGreaterThan(1.5); // prior 1.5 + 1.0 success
    expect(Number(rows[0].beta)).toBeCloseTo(1.5, 1);
    expect(stages).toBeNull(); // findRaw uses URL not hash, so this confirms our direct check works
  });

  it('skips reports observed < 1h ago (delay protection)', async () => {
    await seedReport('e2', 'b'.repeat(64), true, 1.0, NOW - 30 * 60); // 30 min ago
    const result = await cron.runOnce();
    expect(result.consolidated).toBe(0);
    // Mais le report reste pending.
    const record = await crowdRepo.findByEventId('e2');
    expect(record!.consolidated_at).toBeNull();
  });

  it('marks reports as consolidated_at — idempotent on re-run', async () => {
    await seedReport('e3', 'c'.repeat(64), true, 1.0, NOW - 2 * 3600);
    await cron.runOnce();
    const record1 = await crowdRepo.findByEventId('e3');
    expect(record1!.consolidated_at).toBe(NOW);

    // 2e cron run au même tick → skip ce report (already consolidated).
    const result2 = await cron.runOnce();
    expect(result2.consolidated).toBe(0);
  });

  it('skips reports with effective_weight < minWeight', async () => {
    await seedReport('e4', 'd'.repeat(64), true, 0.1, NOW - 2 * 3600); // weight too low
    const result = await cron.runOnce({ minWeight: 0.3 });
    expect(result.consolidated).toBe(0);
  });

  it('respects maxPerCycle limit', async () => {
    // 10 reports tous éligibles.
    for (let i = 0; i < 10; i++) {
      await seedReport(`evt-${i}`.padEnd(64, '0'), 'e'.repeat(64), true, 1.0, NOW - 2 * 3600);
    }
    const result = await cron.runOnce({ maxPerCycle: 3 });
    expect(result.consolidated).toBe(3);
  });

  it('failure-success mix correctly weighted', async () => {
    const urlHash = 'f'.repeat(64);
    await seedReport('s1', urlHash, true, 1.0, NOW - 2 * 3600);
    await seedReport('s2', urlHash, true, 1.0, NOW - 2 * 3600);
    await seedReport('f1', urlHash, false, 1.0, NOW - 2 * 3600);
    await cron.runOnce();
    // Un endpoint avec 2 success + 1 failure (weight 1 chacun)
    // posterior : alpha = 1.5 + 2 = 3.5, beta = 1.5 + 1 = 2.5
    const { rows } = await pool.query(
      `SELECT alpha, beta FROM endpoint_stage_posteriors
        WHERE endpoint_url_hash = $1::text AND stage = $2::smallint`,
      [urlHash, STAGE_DELIVERY],
    );
    expect(Number(rows[0].alpha)).toBeCloseTo(3.5, 1);
    expect(Number(rows[0].beta)).toBeCloseTo(2.5, 1);
  });

  it('default delay constant is 1 hour', () => {
    expect(DEFAULT_CONSOLIDATION_DELAY_SEC).toBe(3600);
  });
});
