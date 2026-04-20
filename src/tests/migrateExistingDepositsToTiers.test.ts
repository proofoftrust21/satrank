// Phase 9 C4 — tests for the legacy-deposit backfill script.
// Covers: dry-run non-mutation, tier inference from max_quota, proportional
// credits calc, skips for below-floor / null max_quota, idempotence.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { migrateExistingDeposits } from '../scripts/migrateExistingDepositsToTiers';

function seedLegacyToken(
  db: Database.Database,
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

describe('migrateExistingDepositsToTiers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  it('dry-run reports counts but writes nothing', () => {
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

  it('migrates a tier-1 token (21 sats full → 21 credits)', () => {
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

  it('migrates a tier-2 token (1000 sats full → 2000 credits)', () => {
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

  it('partially-drained tier-2 token: 500/1000 remaining → 1000 credits', () => {
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

  it('tier-5 token (1M sats → 20M credits)', () => {
    const ph = Buffer.alloc(32, 4);
    seedLegacyToken(db, ph, 1_000_000, 1_000_000);

    migrateExistingDeposits(db, { dryRun: false });

    const row = db.prepare('SELECT balance_credits, tier_id FROM token_balance WHERE payment_hash = ?').get(ph) as {
      balance_credits: number; tier_id: number;
    };
    expect(row.tier_id).toBe(5);
    expect(row.balance_credits).toBe(20_000_000);
  });

  it('skips tokens with max_quota below the tier-1 floor', () => {
    // Max_quota=20 is below the 21-sat floor → skip
    seedLegacyToken(db, Buffer.alloc(32, 5), 20, 20);
    seedLegacyToken(db, Buffer.alloc(32, 6), 5, 5);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.scanned).toBe(2);
    expect(report.migrated).toBe(0);
    expect(report.skippedBelowFloor).toBe(2);
  });

  it('skips tokens with NULL max_quota', () => {
    seedLegacyToken(db, Buffer.alloc(32, 7), 10, null);

    const report = migrateExistingDeposits(db, { dryRun: false });
    expect(report.skippedNullMaxQuota).toBe(1);
    expect(report.migrated).toBe(0);
  });

  it('distributes counts across tiers correctly', () => {
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

  it('idempotent: re-running finds zero candidates', () => {
    const ph = Buffer.alloc(32, 20);
    seedLegacyToken(db, ph, 1000, 1000);

    const first = migrateExistingDeposits(db, { dryRun: false });
    expect(first.migrated).toBe(1);

    const second = migrateExistingDeposits(db, { dryRun: false });
    expect(second.scanned).toBe(0);
    expect(second.migrated).toBe(0);
  });

  it('does not touch Phase 9 tokens that already have a rate', () => {
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

  it('handles zero remaining: credits = 0 (fully drained token stays fully drained)', () => {
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

  it('between-tier max_quota rounds down for tier inference', () => {
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
