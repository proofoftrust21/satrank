// Phase 4 (2026-05-01) — PoolAccountingService tests.
//
// Cover: lifetime + 24h aggregation, circuit breaker thresholds, headroom
// calculation, cache TTL behavior.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { PoolAccountingService } from '../services/poolAccountingService';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import { RefundLedgerRepository } from '../repositories/refundLedgerRepository';

let testDb: TestDb;

describe('PoolAccountingService', () => {
  let pool: Pool;
  let fulfillJobRepo: FulfillJobRepository;
  let refundLedgerRepo: RefundLedgerRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    fulfillJobRepo = new FulfillJobRepository(pool);
    refundLedgerRepo = new RefundLedgerRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE refund_ledger RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE fulfill_jobs RESTART IDENTITY CASCADE');
  });

  async function seedSuccessfulJob(jobId: string, premiumSats: number, settledAt: number): Promise<void> {
    await fulfillJobRepo.create({
      job_id: jobId,
      agent_pubkey: 'agent-' + jobId,
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: settledAt - 1,
    });
    await fulfillJobRepo.settleSuccess({
      job_id: jobId,
      attempts: [],
      sats_spent: 5,
      premium_sats: premiumSats,
      preimage: 'p'.repeat(64),
      result_body_sha256: 'h'.repeat(64),
      settled_at: settledAt,
    });
  }

  async function seedAbsorbed(jobId: string, sats: number, ts: number): Promise<void> {
    await fulfillJobRepo.create({
      job_id: jobId,
      agent_pubkey: 'agent-' + jobId,
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: ts - 10,
    });
    await refundLedgerRepo.record({
      job_id: jobId,
      candidate_url: 'https://x.example/' + jobId,
      agent_pubkey: 'agent-' + jobId,
      sats_absorbed: sats,
      classification: 'tier1_http_5xx',
      ts,
    });
  }

  it('balance = premium_revenue - sats_absorbed (zero on empty)', async () => {
    const svc = new PoolAccountingService({ pool, minPoolSats: 0 });
    const balance = await svc.refresh();
    expect(balance.balance_sats).toBe(0);
    expect(balance.premium_revenue_sats).toBe(0);
    expect(balance.sats_absorbed_sats).toBe(0);
    expect(balance.circuit_breaker_open).toBe(false);
  });

  it('aggregates lifetime + 24h windows separately', async () => {
    const nowSec = 1_777_600_000;
    const yesterday = nowSec - 86400;
    const twoDaysAgo = nowSec - 2 * 86400;
    await seedSuccessfulJob('recent-1', 10, nowSec - 100);
    await seedSuccessfulJob('recent-2', 5, nowSec - 200);
    await seedSuccessfulJob('old-1', 20, twoDaysAgo);
    await seedAbsorbed('absorb-recent', 7, nowSec - 50);
    await seedAbsorbed('absorb-old', 30, twoDaysAgo);

    const svc = new PoolAccountingService({ pool, minPoolSats: 0, now: () => nowSec });
    const balance = await svc.refresh();
    // Lifetime: 10 + 5 + 20 = 35 premium; 7 + 30 = 37 absorbed → balance -2.
    expect(balance.premium_revenue_sats).toBe(35);
    expect(balance.sats_absorbed_sats).toBe(37);
    expect(balance.balance_sats).toBe(-2);
    // 24h: 10 + 5 = 15 premium; 7 absorbed.
    expect(balance.premium_revenue_24h).toBe(15);
    expect(balance.sats_absorbed_24h).toBe(7);
  });

  it('circuit breaker opens when balance < min_pool_sats', async () => {
    const nowSec = 1_777_600_000;
    await seedSuccessfulJob('p1', 100, nowSec - 100);
    await seedAbsorbed('a1', 50, nowSec - 50);
    // balance = 50, min_pool = 100 → breaker open
    const svc = new PoolAccountingService({ pool, minPoolSats: 100, now: () => nowSec });
    const balance = await svc.refresh();
    expect(balance.balance_sats).toBe(50);
    expect(balance.circuit_breaker_open).toBe(true);
    expect(balance.headroom_sats).toBe(0);
  });

  it('circuit breaker closed when balance >= min_pool_sats, headroom = balance - min', async () => {
    const nowSec = 1_777_600_000;
    await seedSuccessfulJob('p1', 200, nowSec - 100);
    await seedAbsorbed('a1', 50, nowSec - 50);
    const svc = new PoolAccountingService({ pool, minPoolSats: 100, now: () => nowSec });
    const balance = await svc.refresh();
    expect(balance.balance_sats).toBe(150);
    expect(balance.circuit_breaker_open).toBe(false);
    expect(balance.headroom_sats).toBe(50);
  });

  it('cache returns same snapshot within TTL window', async () => {
    const svc = new PoolAccountingService({ pool, minPoolSats: 0 });
    const a = await svc.getBalance();
    // Insert new revenue — without cache invalidation this won't show.
    await seedSuccessfulJob('cache-test', 1234, Math.floor(Date.now() / 1000));
    const b = await svc.getBalance();
    expect(b.balance_sats).toBe(a.balance_sats); // cache served the old snapshot
    // Force refresh skips cache.
    const c = await svc.refresh();
    expect(c.balance_sats).toBeGreaterThanOrEqual(1234);
  });
});
