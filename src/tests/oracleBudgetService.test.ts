// Phase 6.4 — OracleBudgetService : log + multi-window aggregation.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { OracleBudgetService } from '../services/oracleBudgetService';

let testDb: TestDb;

describe('OracleBudgetService (Phase 6.4)', () => {
  let pool: Pool;
  let service: OracleBudgetService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    service = new OracleBudgetService(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('logRevenue inserts a row + getBudget reflects it', async () => {
    await service.logRevenue('fresh_query', 2, { route: '/intent' });
    const snap = await service.getBudget();
    expect(snap.revenue_sats).toBe(2);
    expect(snap.spending_sats).toBe(0);
    expect(snap.balance_sats).toBe(2);
    expect(snap.coverage_ratio).toBeNull(); // spending=0
    expect(snap.n_revenue_events).toBe(1);
  });

  it('logSpending tracks spending side', async () => {
    await service.logSpending('paid_probe', 5, { endpoint: 'a.test' });
    const snap = await service.getBudget();
    expect(snap.revenue_sats).toBe(0);
    expect(snap.spending_sats).toBe(5);
    expect(snap.balance_sats).toBe(-5);
    expect(snap.coverage_ratio).toBe(0); // 0 / 5
    expect(snap.n_spending_events).toBe(1);
  });

  it('skips zero or negative amounts (no-op insert)', async () => {
    await service.logRevenue('fresh_query', 0);
    await service.logRevenue('fresh_query', -1);
    await service.logSpending('paid_probe', 0);
    const snap = await service.getBudget();
    expect(snap.revenue_sats).toBe(0);
    expect(snap.spending_sats).toBe(0);
    expect(snap.n_revenue_events).toBe(0);
  });

  it('coverage_ratio = revenue / spending when both present', async () => {
    await service.logRevenue('fresh_query', 10);
    await service.logSpending('paid_probe', 5);
    const snap = await service.getBudget();
    expect(snap.coverage_ratio).toBe(2); // 10/5
    expect(snap.balance_sats).toBe(5);
  });

  it('window filter applies cutoff correctly', async () => {
    const now = Math.floor(Date.now() / 1000);
    await service.log({
      type: 'revenue',
      source: 'fresh_query',
      amount_sats: 100,
      observed_at: now - 14 * 86400, // 14d ago
    });
    await service.log({
      type: 'revenue',
      source: 'fresh_query',
      amount_sats: 50,
      observed_at: now - 1 * 86400, // 1d ago
    });
    const last7d = await service.getBudget({ windowSec: 7 * 86400 });
    expect(last7d.revenue_sats).toBe(50); // only the 1d-ago entry
    const last30d = await service.getBudget({ windowSec: 30 * 86400 });
    expect(last30d.revenue_sats).toBe(150); // both
  });

  it('getBudgetMultiWindow returns lifetime + 30d + 7d in one call', async () => {
    await service.logRevenue('fresh_query', 8);
    await service.logSpending('paid_probe', 3);
    const multi = await service.getBudgetMultiWindow();
    expect(multi.lifetime.window_sec).toBeNull();
    expect(multi.last_30d.window_sec).toBe(30 * 86400);
    expect(multi.last_7d.window_sec).toBe(7 * 86400);
    expect(multi.lifetime.balance_sats).toBe(5);
    expect(multi.last_7d.balance_sats).toBe(5);
  });

  it('aggregates over multiple sources', async () => {
    await service.logRevenue('fresh_query', 2);
    await service.logRevenue('probe_query', 5);
    await service.logRevenue('verdict_query', 1);
    await service.logRevenue('profile_query', 1);
    const snap = await service.getBudget();
    expect(snap.revenue_sats).toBe(9);
    expect(snap.n_revenue_events).toBe(4);
  });
});
