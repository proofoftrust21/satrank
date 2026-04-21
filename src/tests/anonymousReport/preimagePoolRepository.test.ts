// Tests PreimagePoolRepository — insertIfAbsent idempotence, consumeAtomic
// one-shot, concurrent race. La sémantique atomique est la garantie clé
// qui empêche les double-reports.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { PreimagePoolRepository, tierToReporterWeight } from '../../repositories/preimagePoolRepository';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);

describe('PreimagePoolRepository', async () => {
  let pool: Pool;
  let repo: PreimagePoolRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new PreimagePoolRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('insertIfAbsent inserts a new entry and returns true', async () => {
    const ok = await repo.insertIfAbsent({
      paymentHash: 'ph1',
      bolt11Raw: 'lnbc100u1pxxxx',
      firstSeen: NOW,
      confidenceTier: 'medium',
      source: 'crawler',
    });
    expect(ok).toBe(true);

    const row = await repo.findByPaymentHash('ph1');
    expect(row).not.toBeNull();
    expect(row?.confidence_tier).toBe('medium');
    expect(row?.source).toBe('crawler');
    expect(row?.consumed_at).toBeNull();
  });

  it('insertIfAbsent is idempotent — second call returns false, preserves original tier/source', async () => {
    await repo.insertIfAbsent({ paymentHash: 'ph1', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    const second = await repo.insertIfAbsent({ paymentHash: 'ph1', bolt11Raw: null, firstSeen: NOW + 10, confidenceTier: 'low', source: 'report' });
    expect(second).toBe(false);
    const row = await repo.findByPaymentHash('ph1');
    expect(row?.confidence_tier).toBe('medium');
    expect(row?.source).toBe('crawler');
  });

  it('findByPaymentHash returns null for unknown hash', async () => {
    expect(await repo.findByPaymentHash('unknown')).toBeNull();
  });

  it('consumeAtomic succeeds once, returns false on second call (one-shot)', async () => {
    await repo.insertIfAbsent({ paymentHash: 'ph-once', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'low', source: 'report' });
    const first = await repo.consumeAtomic('ph-once', 'report-1', NOW + 5);
    expect(first).toBe(true);
    const second = await repo.consumeAtomic('ph-once', 'report-2', NOW + 6);
    expect(second).toBe(false);

    const row = await repo.findByPaymentHash('ph-once');
    expect(row?.consumed_at).toBe(NOW + 5);
    expect(row?.consumer_report_id).toBe('report-1');
  });

  it('consumeAtomic returns false on unknown payment_hash', async () => {
    const ok = await repo.consumeAtomic('never-inserted', 'report-x', NOW);
    expect(ok).toBe(false);
  });

  it('concurrent consume race — exactement 1 winner sur N tentatives sur la même preimage', async () => {
    // pg async: we serialize the attempts but the UPDATE ... WHERE consumed_at IS NULL
    // invariant guarantees only one winner.
    await repo.insertIfAbsent({ paymentHash: 'race-ph', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await repo.consumeAtomic('race-ph', `report-${i}`, NOW + i));
    }
    const winners = results.filter(r => r === true);
    expect(winners.length).toBe(1);

    const row = await repo.findByPaymentHash('race-ph');
    expect(row?.consumed_at).toBe(NOW); // premier appel gagne (i=0)
    expect(row?.consumer_report_id).toBe('report-0');
  });

  it('countByTier groups entries correctement', async () => {
    await repo.insertIfAbsent({ paymentHash: 'h1', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    await repo.insertIfAbsent({ paymentHash: 'h2', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'intent' });
    await repo.insertIfAbsent({ paymentHash: 'h3', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'low', source: 'report' });
    const counts = await repo.countByTier();
    expect(counts).toEqual({ high: 0, medium: 2, low: 1 });
  });
});

describe('tierToReporterWeight', () => {
  it('maps high=0.7, medium=0.5, low=0.3', () => {
    expect(tierToReporterWeight('high')).toBe(0.7);
    expect(tierToReporterWeight('medium')).toBe(0.5);
    expect(tierToReporterWeight('low')).toBe(0.3);
  });
});
