// @ts-nocheck — archived 2026-04-22 in Phase 12C (SQLite-era better-sqlite3 API, not ported to pg). See docs/phase-12c/TS-ERRORS-AUDIT.md.
// Phase 9 C4 — tests for the legacy-deposit backfill script.
// Covers: dry-run non-mutation, tier inference from max_quota, proportional
// credits calc, skips for below-floor / null max_quota, idempotence.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { migrateExistingDeposits } from '../scripts/migrateExistingDepositsToTiers';
let testDb: TestDb;

function seedLegacyToken(
  db: Pool,
  paymentHash: Buffer,
  remaining: number,
  maxQuota: number | null,
): void {
  // Insert without rate_sats_per_request/tier_id/balance_credits — simulates
  // the pre-v39 schema shape (null in the new columns).
  db.prepare(`
    INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota)
    VALUES (?, ?, ?, ?)
  `).run(paymentHash, remaining, 1_700_000_000, maxQuota);
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('migrateExistingDepositsToTiers', async () => {
  let db: Pool;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
});

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('dry-run reports counts but writes nothing', async () => {
    seedLegacyToken(db, Buffer.alloc(32, 1), 1000, 1000);
    seedLegacyToken(db, Buffer.alloc(32, 2), 500, 1000);

    const report = migrateExistingDeposits(db, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.scanned).toBe(2);
    expect(report.migrated).toBe(2);

    // Both rows still have NULL rate_sats_per_request
    const rows = db.prepare('SELECT rate_sats_per_request FROM token_balance').all() as Array<{ rate_sats_per_request: number | null }>;
    expect(rows.every(r => r.rate_sats_per_request === null)).toBe(true);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('migrates a tier-1 token (21 sats full → 21 credits)', async () => {
    const ph = Buffer.alloc(32, 1);
    seedLegacyToken(db, ph, 21, 21);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.migrated).toBe(1);
    expect(report.tierDistribution).toEqual({ 1: 1 });
    expect(report.totalCreditsGranted).toBe(21);

    const row = db.prepare('SELECT * FROM token_balance WHERE payment_hash = ?').get(ph) as {
      tier_id: number; rate_sats_per_request: number; balance_credits: number;
    };
    expect(row.tier_id).toBe(1);
    expect(row.rate_sats_per_request).toBe(1.0);
    expect(row.balance_credits).toBe(21);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('migrates a tier-2 token (1000 sats full → 2000 credits)', async () => {
    const ph = Buffer.alloc(32, 2);
    seedLegacyToken(db, ph, 1000, 1000);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.migrated).toBe(1);
    expect(report.tierDistribution).toEqual({ 2: 1 });
    expect(report.totalCreditsGranted).toBe(2000);

    const row = db.prepare('SELECT * FROM token_balance WHERE payment_hash = ?').get(ph) as {
      tier_id: number; rate_sats_per_request: number; balance_credits: number;
    };
    expect(row.tier_id).toBe(2);
    expect(row.rate_sats_per_request).toBe(0.5);
    expect(row.balance_credits).toBe(2000);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('partially-drained tier-2 token: 500/1000 remaining → 1000 credits', async () => {
    // Tier inferred from max_quota=1000 (tier 2, rate 0.5)
    // Credits from remaining: 500 / 0.5 = 1000
    const ph = Buffer.alloc(32, 3);
    seedLegacyToken(db, ph, 500, 1000);

    migrateExistingDeposits(db, { dryRun: false });

    const row = db.prepare('SELECT * FROM token_balance WHERE payment_hash = ?').get(ph) as {
      tier_id: number; rate_sats_per_request: number; balance_credits: number; remaining: number;
    };
    expect(row.tier_id).toBe(2);
    expect(row.balance_credits).toBe(1000);
    expect(row.remaining).toBe(500); // legacy column untouched
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('tier-5 token (1M sats → 20M credits)', async () => {
    const ph = Buffer.alloc(32, 4);
    seedLegacyToken(db, ph, 1_000_000, 1_000_000);

    migrateExistingDeposits(db, { dryRun: false });

    const row = db.prepare('SELECT balance_credits, tier_id FROM token_balance WHERE payment_hash = ?').get(ph) as {
      balance_credits: number; tier_id: number;
    };
    expect(row.tier_id).toBe(5);
    expect(row.balance_credits).toBe(20_000_000);
  });

  it('skips tokens with max_quota below the tier-1 floor', async () => {
    // Max_quota=20 is below the 21-sat floor → skip
    seedLegacyToken(db, Buffer.alloc(32, 5), 20, 20);
    seedLegacyToken(db, Buffer.alloc(32, 6), 5, 5);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.scanned).toBe(2);
    expect(report.migrated).toBe(0);
    expect(report.skippedBelowFloor).toBe(2);
  });

  it('skips tokens with NULL max_quota', async () => {
    seedLegacyToken(db, Buffer.alloc(32, 7), 10, null);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.skippedNullMaxQuota).toBe(1);
    expect(report.migrated).toBe(0);
  });

  it('distributes counts across tiers correctly', async () => {
    // One per tier
    seedLegacyToken(db, Buffer.alloc(32, 10), 21, 21);
    seedLegacyToken(db, Buffer.alloc(32, 11), 1000, 1000);
    seedLegacyToken(db, Buffer.alloc(32, 12), 10000, 10000);
    seedLegacyToken(db, Buffer.alloc(32, 13), 100000, 100000);
    seedLegacyToken(db, Buffer.alloc(32, 14), 1_000_000, 1_000_000);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.migrated).toBe(5);
    expect(report.tierDistribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
  });

  it('idempotent: re-running finds zero candidates', async () => {
    const ph = Buffer.alloc(32, 20);
    seedLegacyToken(db, ph, 1000, 1000);

    const first = migrateExistingDeposits(db, { dryRun: false });
    expect(first.migrated).toBe(1);

    const second = migrateExistingDeposits(db, { dryRun: false });
    expect(second.scanned).toBe(0);
    expect(second.migrated).toBe(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('does not touch Phase 9 tokens that already have a rate', async () => {
    // Seed a Phase 9 token directly (rate already set) + a legacy one
    const phPhase9 = Buffer.alloc(32, 30);
    const phLegacy = Buffer.alloc(32, 31);
    db.prepare(`
      INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota, tier_id, rate_sats_per_request, balance_credits)
      VALUES (?, 1000, 1700000000, 1000, 2, 0.5, 2000)
    `).run(phPhase9);
    seedLegacyToken(db, phLegacy, 21, 21);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.scanned).toBe(1); // only the legacy one
    expect(report.migrated).toBe(1);

    // Phase 9 row unchanged
    const phase9Row = db.prepare('SELECT balance_credits FROM token_balance WHERE payment_hash = ?').get(phPhase9) as { balance_credits: number };
    expect(phase9Row.balance_credits).toBe(2000);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('handles zero remaining: credits = 0 (fully drained token stays fully drained)', async () => {
    const ph = Buffer.alloc(32, 40);
    seedLegacyToken(db, ph, 0, 1000);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.migrated).toBe(1);

    const row = db.prepare('SELECT balance_credits, tier_id FROM token_balance WHERE payment_hash = ?').get(ph) as {
      balance_credits: number; tier_id: number;
    };
    expect(row.tier_id).toBe(2); // tier inferred from max_quota
    expect(row.balance_credits).toBe(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('between-tier max_quota rounds down for tier inference', async () => {
    // max_quota=999 is below the 1000 threshold → still tier 1
    const ph = Buffer.alloc(32, 50);
    seedLegacyToken(db, ph, 999, 999);

    migrateExistingDeposits(db, { dryRun: false });

    const row = db.prepare('SELECT tier_id, rate_sats_per_request, balance_credits FROM token_balance WHERE payment_hash = ?').get(ph) as {
      tier_id: number; rate_sats_per_request: number; balance_credits: number;
    };
    expect(row.tier_id).toBe(1);
    expect(row.rate_sats_per_request).toBe(1.0);
    expect(row.balance_credits).toBe(999);
  });
});