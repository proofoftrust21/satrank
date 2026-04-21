// Phase 3 C12 — rétention des tables Bayesian.
//
// Tests :
//   - buckets > 30j sont purgés, ≤ 30j sont gardés
//   - streaming_posteriors dormantes (> 90j sans update) sont purgées
//   - run idempotent : 2ème passage = 0 changements
//   - override env / option pour tests reproductibles
//   - échec sur une table ne bloque pas les autres (best-effort)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  dayKeyUTC,
} from '../repositories/dailyBucketsRepository';
import {
  EndpointStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { runPrune } from '../scripts/pruneBayesianRetention';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('pruneBayesianRetention', async () => {
  let db: Pool;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
});

  afterEach(async () => { await teardownTestPool(testDb); });

  it('buckets > 30j sont purgés, ≤ 30j conservés', async () => {
    const target = 'aa'.repeat(32);
    const buckets = new EndpointDailyBucketsRepository(db);

    // rows à 45j, 31j, 29j, 7j — seules les deux premières doivent partir.
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 45 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 31 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 29 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 7 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });

    const result = runPrune({ db, nowSec: NOW });
    expect(result.buckets.endpoint).toBeGreaterThanOrEqual(2);
    expect(result.errors).toBe(0);

    const remaining = await buckets.findAllForId(target);
    expect(remaining).toHaveLength(2);
    const days = remaining.map(r => r.day).sort();
    expect(days).toEqual([
      dayKeyUTC(NOW - 29 * DAY),
      dayKeyUTC(NOW - 7 * DAY),
    ].sort());
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('streaming dormantes (> 90j) purgées', async () => {
    const target = 'bb'.repeat(32);
    // Insert manuellement : last_update_ts à 100j (dormant) et 80j (active).
    db.prepare(`
      INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
      VALUES (?, 'probe', 1.5, 1.5, ?, 1)
    `).run(target, NOW - 100 * DAY);
    db.prepare(`
      INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
      VALUES (?, 'report', 1.5, 1.5, ?, 1)
    `).run(target, NOW - 80 * DAY);

    const result = runPrune({ db, nowSec: NOW });
    expect(result.streaming.endpoint).toBe(1);

    const streaming = new EndpointStreamingPosteriorRepository(db);
    expect(await streaming.findStored(target, 'probe')).toBeUndefined();
    expect(await streaming.findStored(target, 'report')).not.toBeUndefined();
  });

  it('2ème passage = 0 changements (idempotence)', async () => {
    const target = 'cc'.repeat(32);
    const buckets = new EndpointDailyBucketsRepository(db);
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 100 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });

    const first = runPrune({ db, nowSec: NOW });
    expect(first.buckets.endpoint).toBe(1);

    const second = runPrune({ db, nowSec: NOW });
    expect(second.buckets.endpoint).toBe(0);
    expect(second.streaming.endpoint).toBe(0);
    expect(second.errors).toBe(0);
  });

  it('override bucketRetentionDays = 7 purge agressivement', async () => {
    const target = 'dd'.repeat(32);
    const buckets = new ServiceDailyBucketsRepository(db);
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 10 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 3 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });

    const result = runPrune({ db, nowSec: NOW, bucketRetentionDays: 7 });
    expect(result.buckets.service).toBe(1);

    const remaining = await buckets.findAllForId(target);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].day).toBe(dayKeyUTC(NOW - 3 * DAY));
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('rows récentes dans toutes les tables ne sont pas touchées', async () => {
    const target = 'ee'.repeat(32);
    const buckets = new EndpointDailyBucketsRepository(db);
    await buckets.bump(target, 'probe', {
      day: dayKeyUTC(NOW - 1 * DAY), nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0,
    });

    db.prepare(`
      INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
      VALUES (?, 'probe', 2.5, 1.5, ?, 1)
    `).run(target, NOW - 3600);

    const result = runPrune({ db, nowSec: NOW });
    expect(result.buckets.total).toBe(0);
    expect(result.streaming.total).toBe(0);
  });
});
