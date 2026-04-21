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
//
// Phase 12B : porté vers pg async. payment_hash reste BYTEA côté Postgres ;
// on passe les Buffer directement en paramètre de la requête paramétrée.

import type { Pool, PoolClient } from 'pg';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { withTransaction } from '../database/transaction';
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

type Queryable = Pool | PoolClient;

async function collectUpdates(
  db: Queryable,
  tierService: DepositTierService,
): Promise<{ updates: Array<[number, number, number, Buffer]>; report: MigrationReport }> {
  const { rows } = await db.query<MigrationRow>(`
    SELECT payment_hash, remaining, max_quota
    FROM token_balance
    WHERE rate_sats_per_request IS NULL
  `);

  const report: MigrationReport = {
    scanned: rows.length,
    migrated: 0,
    skippedBelowFloor: 0,
    skippedNullMaxQuota: 0,
    tierDistribution: {},
    totalCreditsGranted: 0,
    dryRun: false, // caller sets
  };

  const updates: Array<[number, number, number, Buffer]> = [];

  for (const row of rows) {
    if (row.max_quota === null || row.max_quota === undefined) {
      report.skippedNullMaxQuota++;
      continue;
    }
    const tier: DepositTier | null = await tierService.lookupTierForAmount(row.max_quota);
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

  return { updates, report };
}

export async function migrateExistingDeposits(
  pool: Pool,
  options: { dryRun: boolean },
): Promise<MigrationReport> {
  // Scan + planning = read-only, on peut le faire hors tx.
  const planTierService = new DepositTierService(pool);
  const { updates, report } = await collectUpdates(pool, planTierService);
  report.dryRun = options.dryRun;

  if (options.dryRun || updates.length === 0) {
    return report;
  }

  // Écriture atomique : soit toutes les rows migrent, soit aucune.
  await withTransaction(pool, async (client) => {
    for (const u of updates) {
      await client.query(
        `UPDATE token_balance
            SET tier_id = $1, rate_sats_per_request = $2, balance_credits = $3
          WHERE payment_hash = $4 AND rate_sats_per_request IS NULL`,
        u,
      );
    }
  });

  return report;
}

// CLI entrypoint — skipped when imported by tests.
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const pool = getPool();
  await runMigrations(pool);

  try {
    const report = await migrateExistingDeposits(pool, { dryRun });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (dryRun) {
      process.stdout.write('\n(dry-run — no rows written. Re-run without --dry-run to apply.)\n');
    }
  } finally {
    await closePools();
  }
}

const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[migrate-deposits] FATAL: ${msg}\n`);
    await closePools();
    process.exit(1);
  });
}
