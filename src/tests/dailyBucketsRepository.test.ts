// Phase 3 refactor — DailyBucketsRepository (C4).
//
// Garanties :
//   - bump cumule sur (id, source, day) via ON CONFLICT
//   - observer est accepté (contrat Q3)
//   - recentActivity agrège toutes les sources (observer inclus)
//   - recentActivity(24h/7d/30d) calcule sur les plages UTC attendues
//   - sumSuccessFailureBetween retourne les cumuls corrects (pour riskProfile C5)
//   - pruneOlderThan supprime les rows au-delà du cutoff
//   - dayKeyUTC formate YYYY-MM-DD correctement (cross-fuseau)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointDailyBucketsRepository,
  RouteDailyBucketsRepository,
  dayKeyUTC,
} from '../repositories/dailyBucketsRepository';
let testDb: TestDb;

describe('dayKeyUTC', () => {
  it('formate en YYYY-MM-DD UTC', async () => {
    // 2026-04-18T12:00:00Z = 1_776_000_000 + offset ≈ 1_776_081_600
    const ts = Date.UTC(2026, 3, 18, 12, 0, 0) / 1000; // 0-indexed month
    expect(dayKeyUTC(ts)).toBe('2026-04-18');
  });

  it('respecte la frontière UTC 00:00 (pas de fuseau local)', async () => {
    const justBefore = Date.UTC(2026, 3, 18, 23, 59, 59) / 1000;
    const justAfter = Date.UTC(2026, 3, 19, 0, 0, 1) / 1000;
    expect(dayKeyUTC(justBefore)).toBe('2026-04-18');
    expect(dayKeyUTC(justAfter)).toBe('2026-04-19');
  });
});

describe('EndpointDailyBucketsRepository', async () => {
  let db: Pool;
  let repo: EndpointDailyBucketsRepository;
  const NOW = Date.UTC(2026, 3, 18, 12, 0, 0) / 1000;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new EndpointDailyBucketsRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('bump crée la row au premier appel', async () => {
    await repo.bump('h1', 'probe', {
      day: '2026-04-18',
      nObsDelta: 1,
      nSuccessDelta: 1,
      nFailureDelta: 0,
    });
    const rows = await repo.findAllForId('h1');
    expect(rows).toHaveLength(1);
    expect(rows[0].nObs).toBe(1);
    expect(rows[0].source).toBe('probe');
  });

  it('bump cumule sur (id, source, day) via ON CONFLICT', async () => {
    await repo.bump('h1', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    await repo.bump('h1', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 0, nFailureDelta: 1 });
    const rows = await repo.findAllForId('h1');
    expect(rows).toHaveLength(1);
    expect(rows[0].nObs).toBe(2);
    expect(rows[0].nSuccess).toBe(1);
    expect(rows[0].nFailure).toBe(1);
  });

  it('observer est accepté (contrat Q3)', async () => {
    await expect(
      repo.bump('h1', 'observer', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 }),
    ).resolves.not.toThrow();
    const rows = await repo.findAllForId('h1');
    expect(rows[0].source).toBe('observer');
  });

  it('recentActivity agrège toutes les sources sur la plage', async () => {
    // Jour J (2026-04-18)
    await repo.bump('h2', 'probe', { day: '2026-04-18', nObsDelta: 2, nSuccessDelta: 2, nFailureDelta: 0 });
    await repo.bump('h2', 'observer', { day: '2026-04-18', nObsDelta: 5, nSuccessDelta: 5, nFailureDelta: 0 });
    // Jour J-5 (2026-04-13) — dans 7d, dans 30d, pas dans 24h
    await repo.bump('h2', 'report', { day: '2026-04-13', nObsDelta: 3, nSuccessDelta: 3, nFailureDelta: 0 });
    // Jour J-20 (2026-03-29) — dans 30d, pas dans 7d
    await repo.bump('h2', 'probe', { day: '2026-03-29', nObsDelta: 10, nSuccessDelta: 7, nFailureDelta: 3 });
    // Jour J-40 — hors 30d
    await repo.bump('h2', 'probe', { day: '2026-03-09', nObsDelta: 100, nSuccessDelta: 50, nFailureDelta: 50 });

    const activity = await repo.recentActivity('h2', NOW);
    expect(activity.last_24h).toBe(2 + 5); // probe + observer du jour
    expect(activity.last_7d).toBe(2 + 5 + 3); // + report J-5
    expect(activity.last_30d).toBe(2 + 5 + 3 + 10); // + probe J-20, pas J-40
  });

  it('sumSuccessFailureBetween retourne les cumuls (pour riskProfile)', async () => {
    await repo.bump('h3', 'probe', { day: '2026-04-18', nObsDelta: 5, nSuccessDelta: 4, nFailureDelta: 1 });
    await repo.bump('h3', 'report', { day: '2026-04-17', nObsDelta: 3, nSuccessDelta: 2, nFailureDelta: 1 });
    const sum = await repo.sumSuccessFailureBetween('h3', '2026-04-17', '2026-04-18');
    expect(sum.nObs).toBe(8);
    expect(sum.nSuccess).toBe(6);
    expect(sum.nFailure).toBe(2);
  });

  it('pruneOlderThan supprime les rows strictement antérieures au cutoff', async () => {
    await repo.bump('h4', 'probe', { day: '2026-03-01', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    await repo.bump('h4', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    const deleted = await repo.pruneOlderThan('2026-03-20');
    expect(deleted).toBe(1);
    const remaining = await repo.findAllForId('h4');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].day).toBe('2026-04-18');
  });

  it('rows vides → recentActivity renvoie 0 partout (pas d\'erreur)', async () => {
    const activity = await repo.recentActivity('no-rows', NOW);
    expect(activity).toEqual({ last_24h: 0, last_7d: 0, last_30d: 0 });
  });
});

describe('RouteDailyBucketsRepository', async () => {
  let db: Pool;
  let repo: RouteDailyBucketsRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new RouteDailyBucketsRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('bump stocke caller_hash et target_hash à la création', async () => {
    await repo.bump('r1', 'caller-A', 'target-B', 'probe', {
      day: '2026-04-18',
      nObsDelta: 1,
      nSuccessDelta: 1,
      nFailureDelta: 0,
    });
    const rows = await repo.findAllForId('r1');
    expect(rows[0].callerHash).toBe('caller-A');
    expect(rows[0].targetHash).toBe('target-B');
  });

  it('bump cumulatif respecte ON CONFLICT même sur route', async () => {
    await repo.bump('r2', 'caller-A', 'target-B', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 1, nFailureDelta: 0 });
    await repo.bump('r2', 'caller-X', 'target-Y', 'probe', { day: '2026-04-18', nObsDelta: 1, nSuccessDelta: 0, nFailureDelta: 1 });
    const rows = await repo.findAllForId('r2');
    expect(rows).toHaveLength(1);
    expect(rows[0].nObs).toBe(2);
    // caller/target restent inchangés (ON CONFLICT n'écrase pas ces colonnes)
    expect(rows[0].callerHash).toBe('caller-A');
  });
});
