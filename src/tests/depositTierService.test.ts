// Tests for DepositTierService: pure tier lookup from amount.
// The controller-level engraving test lives in depositControllerTiers.test.ts —
// this file isolates the lookup algorithm so a mis-ordered tier table or a
// boundary-off bug gets caught without pulling in LND mocking.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { DepositTierService } from '../services/depositTierService';
let testDb: TestDb;

describe('DepositTierService.listTiers', async () => {
  let db: Pool;
  let svc: DepositTierService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    svc = new DepositTierService(db);
  });

  it('returns all 5 seeded tiers ordered by min_deposit_sats ascending', async () => {
    const tiers = await svc.listTiers();
    expect(tiers.map(t => t.min_deposit_sats)).toEqual([21, 1000, 10000, 100000, 1000000]);
    expect(tiers.map(t => t.rate_sats_per_request)).toEqual([1.0, 0.5, 0.2, 0.1, 0.05]);
    expect(tiers.map(t => t.discount_pct)).toEqual([0, 50, 80, 90, 95]);
  });
});

describe('DepositTierService.lookupTierForAmount — boundary cases', async () => {
  let db: Pool;
  let svc: DepositTierService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    svc = new DepositTierService(db);
  });

  it('returns null below floor (< 21 sats)', async () => {
    expect(await svc.lookupTierForAmount(0)).toBeNull();
    expect(await svc.lookupTierForAmount(20)).toBeNull();
  });

  it('returns null for non-finite / non-positive input', async () => {
    expect(await svc.lookupTierForAmount(NaN)).toBeNull();
    expect(await svc.lookupTierForAmount(-1)).toBeNull();
    expect(await svc.lookupTierForAmount(Infinity)).toBeNull();
  });

  it('exactly at the floor (21 sats) picks tier 1 (rate=1.0)', async () => {
    const t = await svc.lookupTierForAmount(21);
    expect(t).not.toBeNull();
    expect(t!.min_deposit_sats).toBe(21);
    expect(t!.rate_sats_per_request).toBe(1.0);
  });

  it('between tiers rounds DOWN (incentive to reach the next palier)', async () => {
    // 999 sats → still tier 1 (rate=1.0), not yet tier 2 (rate=0.5)
    const t = await svc.lookupTierForAmount(999);
    expect(t!.min_deposit_sats).toBe(21);
    expect(t!.rate_sats_per_request).toBe(1.0);
  });

  it('exactly at next tier threshold switches', async () => {
    expect((await svc.lookupTierForAmount(1000))!.min_deposit_sats).toBe(1000);
    expect((await svc.lookupTierForAmount(1000))!.rate_sats_per_request).toBe(0.5);
  });

  it('picks the correct tier for each schedule step', async () => {
    expect((await svc.lookupTierForAmount(10000))!.min_deposit_sats).toBe(10000);
    expect((await svc.lookupTierForAmount(99999))!.min_deposit_sats).toBe(10000); // below 100k
    expect((await svc.lookupTierForAmount(100000))!.min_deposit_sats).toBe(100000);
    expect((await svc.lookupTierForAmount(999999))!.min_deposit_sats).toBe(100000); // below 1M
    expect((await svc.lookupTierForAmount(1000000))!.min_deposit_sats).toBe(1000000);
  });

  it('beyond the top tier still returns the top tier (1M threshold)', async () => {
    const t = await svc.lookupTierForAmount(21_000_000);
    expect(t!.min_deposit_sats).toBe(1000000);
    expect(t!.rate_sats_per_request).toBe(0.05);
  });
});

describe('DepositTierService.computeCredits', async () => {
  let db: Pool;
  let svc: DepositTierService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    svc = new DepositTierService(db);
  });

  it('returns 0 for null tier (safety default)', async () => {
    expect(svc.computeCredits(1000, null)).toBe(0);
  });

  it('21 sats / rate 1.0 = 21 credits', async () => {
    const t = await svc.lookupTierForAmount(21)!;
    expect(svc.computeCredits(21, t)).toBe(21);
  });

  it('1000 sats / rate 0.5 = 2000 credits (brief example)', async () => {
    const t = await svc.lookupTierForAmount(1000)!;
    expect(svc.computeCredits(1000, t)).toBe(2000);
  });

  it('10000 sats / rate 0.2 = 50000 credits (brief example)', async () => {
    const t = await svc.lookupTierForAmount(10000)!;
    expect(svc.computeCredits(10000, t)).toBe(50000);
  });

  it('100000 sats / rate 0.1 = 1_000_000 credits (brief example)', async () => {
    const t = await svc.lookupTierForAmount(100000)!;
    expect(svc.computeCredits(100000, t)).toBe(1_000_000);
  });

  it('1_000_000 sats / rate 0.05 = 20_000_000 credits (brief example)', async () => {
    const t = await svc.lookupTierForAmount(1_000_000)!;
    expect(svc.computeCredits(1_000_000, t)).toBe(20_000_000);
  });

  it('between-tier amount uses the ENGRAVED rate of the inferior tier', async () => {
    // 500 sats is above the 21 floor but below the 1000 threshold, so it
    // stays at rate=1.0. Credits = 500/1.0 = 500.
    const t = await svc.lookupTierForAmount(500)!;
    expect(t.rate_sats_per_request).toBe(1.0);
    expect(svc.computeCredits(500, t)).toBe(500);
  });
});
