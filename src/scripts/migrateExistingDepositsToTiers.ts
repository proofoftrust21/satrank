#!/usr/bin/env tsx
// Phase 9 C4 — backfill tier_id / rate_sats_per_request / balance_credits on
// legacy token_balance rows that pre-date the engraved-rate schema (v39).
//
// Usage :
//   npx tsx src/scripts/migrateExistingDepositsToTiers.ts [--dry-run]
//
// Options :
//   --dry-run : scan and report only, no UPDATE executed.
//
// Semantics :
//   - Only rows with rate_sats_per_request IS NULL are considered (legacy).
//   - Tier is inferred from `max_quota` (the original deposit amount in sats,
//     frozen at creation time). This matches what the user paid for — even a
//     partially-drained token keeps its original tier.
//   - Credits granted = remaining / rate. A token with 500 of 1000 sats left,
//     migrated to tier 2 (rate 0.5), ends up with 1000 credits — the rate
//     upgrade applies to the *remaining* balance only, not to the already-
//     consumed portion.
//   - Rows whose max_quota is below the tier-1 floor (21 sats) are SKIPPED
//     — they predate the minimum deposit enforcement and can't be engraved
//     cleanly. They remain on the legacy decrement path.
//
// Idempotence : the script only writes rows where rate_sats_per_request IS
// NULL. Re-running it after success finds zero candidates.

import Database from 'better-sqlite3';
import path from 'path';
import { DepositTierService, type DepositTier } from '../services/depositTierService';

interface MigrationRow {
  payment_hash: Buffer;
  remaining: number;
  max_quota: number | null;
}

interface MigrationReport {
  scanned: number;
  migrated: number;
  skippedBelowFloor: number;
  skippedNullMaxQuota: number;
  tierDistribution: Record<number, number>;
  totalCreditsGranted: number;
  dryRun: boolean;
}

export function migrateExistingDeposits(
  db: Database.Database,
  options: { dryRun: boolean },
): MigrationReport {
  const tierService = new DepositTierService(db);

  const rows = db.prepare(`
    SELECT payment_hash, remaining, max_quota
    FROM token_balance
    WHERE rate_sats_per_request IS NULL
  `).all() as MigrationRow[];

  const report: MigrationReport = {
    scanned: rows.length,
    migrated: 0,
    skippedBelowFloor: 0,
    skippedNullMaxQuota: 0,
    tierDistribution: {},
    totalCreditsGranted: 0,
    dryRun: options.dryRun,
  };

  const stmt = db.prepare(`
    UPDATE token_balance
    SET tier_id = ?, rate_sats_per_request = ?, balance_credits = ?
    WHERE payment_hash = ? AND rate_sats_per_request IS NULL
  `);

  type Update = [number, number, number, Buffer];
  const updates: Update[] = [];

  for (const row of rows) {
    if (row.max_quota === null || row.max_quota === undefined) {
      report.skippedNullMaxQuota++;
      continue;
    }
    const tier: DepositTier | null = tierService.lookupTierForAmount(row.max_quota);
    if (!tier) {
      report.skippedBelowFloor++;
      continue;
    }
    const credits = row.remaining / tier.rate_sats_per_request;
    updates.push([tier.tier_id, tier.rate_sats_per_request, credits, row.payment_hash]);
    report.migrated++;
    report.tierDistribution[tier.tier_id] = (report.tierDistribution[tier.tier_id] ?? 0) + 1;
    report.totalCreditsGranted += credits;
  }

  if (!options.dryRun && updates.length > 0) {
    const txn = db.transaction((list: Update[]) => {
      for (const u of list) stmt.run(...u);
    });
    txn(updates);
  }

  return report;
}

// CLI entrypoint — skipped when imported by tests.
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'satrank.db');

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot open database at ${dbPath}: ${msg}`);
    process.exit(1);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    const report = migrateExistingDeposits(db, { dryRun });
    console.log(JSON.stringify(report, null, 2));
    if (dryRun) {
      console.log('\n(dry-run — no rows written. Re-run without --dry-run to apply.)');
    }
  } finally {
    db.close();
  }
}
