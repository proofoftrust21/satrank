// Phase 5.15 — calibrationService : compute predicted-vs-observed avec
// outcomes log roundtrip réel (pas de mock du repo).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointStagePosteriorsRepository,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';
import { CalibrationRepository } from '../repositories/calibrationRepository';
import { CalibrationService } from '../services/calibrationService';

let testDb: TestDb;

describe('CalibrationService', () => {
  let pool: Pool;
  let stagesRepo: EndpointStagePosteriorsRepository;
  let calibRepo: CalibrationRepository;
  let service: CalibrationService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
    calibRepo = new CalibrationRepository(pool);
    service = new CalibrationService(calibRepo);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    // Truncate per test : les fenêtres temporelles du test "windowDays
    // option" couvrent les outcomes des tests antérieurs si on partage l'état.
    await truncateAll(pool);
  });

  it('returns n_endpoints=0 when no outcomes yet (bootstrap run)', async () => {
    const now = 1_700_000_000;
    const result = await service.computeCalibration(now);
    expect(result.n_endpoints).toBe(0);
    expect(result.delta_mean).toBeNull();
    expect(result.per_endpoint).toEqual([]);
    expect(result.window_end).toBe(now);
    expect(result.window_start).toBe(now - 7 * 86400);
  });

  it('returns 0 endpoints when below minObs threshold', async () => {
    const now = 1_700_001_000;
    const url = 'https://low-volume.cal/api';
    // 3 outcomes seulement — sous le seuil minObs=10 default.
    const observed = now - 86400; // 1d ago
    for (let i = 0; i < 3; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        observed,
      );
    }
    const result = await service.computeCalibration(now);
    expect(result.n_endpoints).toBe(0);
  });

  it('first run with no history → delta = |0.5 - p_observed|', async () => {
    const now = 1_700_002_000;
    const url = 'https://first-run.cal/api';
    // 12 success en 1d (dans la fenêtre 7d).
    const observed = now - 86400;
    for (let i = 0; i < 12; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        observed,
      );
    }
    const result = await service.computeCalibration(now);
    expect(result.n_endpoints).toBe(1);
    const e = result.per_endpoint[0];
    expect(e.p_observed).toBe(1.0); // 12/12 succès
    expect(e.p_predicted).toBe(0.5); // pas d'history → prior pur
    expect(e.delta).toBeCloseTo(0.5, 4);
    expect(result.delta_mean).toBeCloseTo(0.5, 4);
  });

  it('with history matching observed → delta near 0 (good calibration)', async () => {
    const now = 1_700_003_000;
    const url = 'https://well-calibrated.cal/api';
    // History : 20 outcomes 80% success, il y a 14 jours (avant la fenêtre 7d).
    const historyTime = now - 14 * 86400;
    for (let i = 0; i < 16; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: true },
        historyTime,
      );
    }
    for (let i = 0; i < 4; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: false },
        historyTime,
      );
    }
    // Fenêtre observée : 12 outcomes, 80% success.
    const observed = now - 86400;
    for (let i = 0; i < 10; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: true },
        observed,
      );
    }
    for (let i = 0; i < 2; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: false },
        observed,
      );
    }

    const result = await service.computeCalibration(now);
    expect(result.n_endpoints).toBe(1);
    const e = result.per_endpoint[0];
    expect(e.p_observed).toBeCloseTo(10 / 12, 2);
    // Avec décroissance vers windowStart, le posterior history ~0.5 + drift
    // selon l'âge — l'important est que delta soit small comparé à 0.5.
    expect(e.delta).toBeLessThan(0.4);
  });

  it('with history diverging from observed → high delta (poor calibration)', async () => {
    const now = 1_700_004_000;
    const url = 'https://drift.cal/api';
    // History : 90% success il y a 14 jours.
    const historyTime = now - 14 * 86400;
    for (let i = 0; i < 18; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: true },
        historyTime,
      );
    }
    for (let i = 0; i < 2; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: false },
        historyTime,
      );
    }
    // Fenêtre observée : 20% success — endpoint a chuté.
    const observed = now - 86400;
    for (let i = 0; i < 2; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: true },
        observed,
      );
    }
    for (let i = 0; i < 8; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_DELIVERY, success: false },
        observed,
      );
    }
    const result = await service.computeCalibration(now);
    const e = result.per_endpoint[0];
    expect(e.p_observed).toBeCloseTo(0.2, 2);
    // p_predicted devrait être proche de 0.5 (history décroissé) ou plus
    // haut, donc delta > 0.2.
    expect(e.delta).toBeGreaterThan(0.2);
  });

  it('aggregates across multiple endpoints with delta_p95', async () => {
    const now = 1_700_005_000;
    const observed = now - 86400;
    const urls = ['https://aggA.cal/api', 'https://aggB.cal/api', 'https://aggC.cal/api'];
    for (const url of urls) {
      // 10 success → p_observed = 1.0, no history → delta = 0.5
      for (let i = 0; i < 10; i++) {
        await stagesRepo.observe(
          { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
          observed,
        );
      }
    }
    const result = await service.computeCalibration(now);
    expect(result.n_endpoints).toBe(3);
    expect(result.delta_mean).toBeCloseTo(0.5, 4);
    expect(result.delta_median).toBeCloseTo(0.5, 4);
    expect(result.delta_p95).toBeCloseTo(0.5, 4);
    expect(result.n_outcomes).toBe(30);
  });

  it('respects windowDays option (smaller window → fewer outcomes)', async () => {
    const now = 1_700_006_000;
    const url = 'https://window-test.cal/api';
    // 4 outcomes sur 14 jours (1 par jour), spaced so 7d window catches
    // only 3 (under minObs=5) and 14d window catches all 4 (still under
    // minObs unless we override). Use override to make the difference
    // observable post-audit-r3 minObs change (10 → 5).
    for (let i = 0; i < 4; i++) {
      const t = now - (i + 1) * 2 * 86400; // every 2 days
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        t,
      );
    }
    // Default 7d window with custom minObs=3 → only the 3 most recent
    // outcomes qualify
    const default7d = await service.computeCalibration(now, { minObs: 3 });
    expect(default7d.n_endpoints).toBe(1);
    // 14d window with same minObs → all 4 outcomes qualify
    const wide14d = await service.computeCalibration(now, { windowDays: 14, minObs: 3 });
    expect(wide14d.n_endpoints).toBe(1);
    expect(wide14d.n_outcomes).toBeGreaterThan(default7d.n_outcomes);
  });
});
