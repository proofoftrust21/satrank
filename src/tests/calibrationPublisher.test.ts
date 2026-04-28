// Phase 5.15 — calibrationPublisher : pure builder + cycle integration.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointStagePosteriorsRepository,
  STAGE_PAYMENT,
} from '../repositories/endpointStagePosteriorsRepository';
import { CalibrationRepository } from '../repositories/calibrationRepository';
import { CalibrationService } from '../services/calibrationService';
import {
  CalibrationPublisher,
  buildCalibrationTemplate,
  KIND_ORACLE_CALIBRATION,
} from '../services/calibrationPublisher';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';

let testDb: TestDb;
const ORACLE_PK = 'satrank-test-pubkey';

describe('buildCalibrationTemplate (pure)', () => {
  it('emits kind 30783 with required tags + content schema', () => {
    const template = buildCalibrationTemplate(
      {
        window_start: 1_700_000_000,
        window_end: 1_700_604_800,
        delta_mean: 0.0345,
        delta_median: 0.0214,
        delta_p95: 0.0892,
        n_endpoints: 287,
        n_outcomes: 4521,
        per_endpoint: [],
      },
      ORACLE_PK,
      1_700_604_800,
    );
    expect(template.kind).toBe(KIND_ORACLE_CALIBRATION);
    expect(template.kind).toBe(30783);
    expect(template.created_at).toBe(1_700_604_800);
    const tagMap = Object.fromEntries(template.tags.map((t) => [t[0], t[1]]));
    expect(tagMap.d).toBe('satrank-calibration');
    expect(tagMap.delta_mean).toBe('0.0345');
    expect(tagMap.n_endpoints).toBe('287');
    expect(tagMap.oracle_pubkey).toBe(ORACLE_PK);
    const content = JSON.parse(template.content);
    expect(content.schema_version).toBe(1);
    expect(content.aggregate.delta_mean).toBeCloseTo(0.0345, 4);
  });

  it('embeds top 20 per-endpoint deltas sorted DESC', () => {
    const perEndpoint = Array.from({ length: 50 }, (_, i) => ({
      endpoint_url_hash: `h${i}`.padEnd(64, '0'),
      stage: 4,
      n_obs: 12,
      p_predicted: 0.8,
      p_observed: 0.8 - i * 0.01, // i=0 → delta=0, i=49 → delta=0.49
      delta: i * 0.01,
    }));
    const template = buildCalibrationTemplate(
      {
        window_start: 0,
        window_end: 1,
        delta_mean: 0.245,
        delta_median: 0.245,
        delta_p95: 0.465,
        n_endpoints: 50,
        n_outcomes: 600,
        per_endpoint: perEndpoint,
      },
      ORACLE_PK,
      1,
    );
    const content = JSON.parse(template.content);
    expect(content.top_deltas).toHaveLength(20);
    // Sorted DESC, top should be i=49 (delta=0.49).
    expect(content.top_deltas[0].delta).toBeCloseTo(0.49, 4);
    expect(content.top_deltas[19].delta).toBeCloseTo(0.30, 4);
  });

  it('emits null tag value when delta is null (bootstrap run)', () => {
    const template = buildCalibrationTemplate(
      {
        window_start: 0,
        window_end: 1,
        delta_mean: null,
        delta_median: null,
        delta_p95: null,
        n_endpoints: 0,
        n_outcomes: 0,
        per_endpoint: [],
      },
      ORACLE_PK,
      1,
    );
    const tagMap = Object.fromEntries(template.tags.map((t) => [t[0], t[1]]));
    expect(tagMap.delta_mean).toBe('null');
    const content = JSON.parse(template.content);
    expect(content.note).toContain('Bootstrap run');
  });
});

describe('CalibrationPublisher.publishCycle (integration)', () => {
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
    await truncateAll(pool);
  });

  it('publishes when no recent run exists; persists run record locally', async () => {
    const now = 1_700_010_000;
    const url = 'https://pub.cal/api';
    for (let i = 0; i < 12; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        now - 86400,
      );
    }
    let publishedTemplate: { kind: number; tags: string[][]; content: string } | null = null;
    const fakePublisher = {
      publishTemplate: async (template: { kind: number; tags: string[][]; content: string }) => {
        publishedTemplate = template;
        return { eventId: 'e'.repeat(64), kind: template.kind, publishedAt: 0, acks: [], anySuccess: true };
      },
    } as unknown as NostrMultiKindPublisher;

    const publisher = new CalibrationPublisher({
      service,
      repo: calibRepo,
      publisher: fakePublisher,
      oraclePubkey: ORACLE_PK,
      now: () => now,
    });
    const cycleResult = await publisher.publishCycle();
    expect(cycleResult).not.toBeNull();
    expect(cycleResult!.eventId).toBe('e'.repeat(64));
    expect(cycleResult!.result.n_endpoints).toBe(1);
    expect(publishedTemplate).not.toBeNull();
    expect(publishedTemplate!.kind).toBe(30783);

    // Persisted in oracle_calibration_runs.
    const latest = await calibRepo.findLatestRun();
    expect(latest).not.toBeNull();
    expect(latest!.published_event_id).toBe('e'.repeat(64));
  });

  it('skips publish when a recent run (< 6 days) already exists (idempotence)', async () => {
    const t1 = 1_700_020_000;
    const url = 'https://idem.cal/api';
    for (let i = 0; i < 12; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        t1 - 86400,
      );
    }
    let publishCount = 0;
    const fakePublisher = {
      publishTemplate: async (t: { kind: number }) => {
        publishCount += 1;
        return { eventId: 'e'.repeat(64), kind: t.kind, publishedAt: 0, acks: [], anySuccess: true };
      },
    } as unknown as NostrMultiKindPublisher;

    const publisher = new CalibrationPublisher({
      service,
      repo: calibRepo,
      publisher: fakePublisher,
      oraclePubkey: ORACLE_PK,
      now: () => t1,
    });
    await publisher.publishCycle();
    expect(publishCount).toBe(1);

    // 2nd call within 6 days → skipped
    const publisher2 = new CalibrationPublisher({
      service,
      repo: calibRepo,
      publisher: fakePublisher,
      oraclePubkey: ORACLE_PK,
      now: () => t1 + 3 * 86400, // +3 days
    });
    const skipped = await publisher2.publishCycle();
    expect(skipped).toBeNull();
    expect(publishCount).toBe(1); // pas de second publish
  });

  it('persists run even when publisher is absent (local-only mode)', async () => {
    const now = 1_700_030_000;
    const url = 'https://nopub.cal/api';
    for (let i = 0; i < 12; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_PAYMENT, success: true },
        now - 86400,
      );
    }
    const publisher = new CalibrationPublisher({
      service,
      repo: calibRepo,
      // pas de publisher
      oraclePubkey: ORACLE_PK,
      now: () => now,
    });
    const result = await publisher.publishCycle();
    expect(result).not.toBeNull();
    expect(result!.eventId).toBeNull();
    const latest = await calibRepo.findLatestRun();
    expect(latest!.published_event_id).toBeNull();
    expect(latest!.window_end).toBe(now);
  });
});
