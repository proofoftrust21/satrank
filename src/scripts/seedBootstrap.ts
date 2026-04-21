#!/usr/bin/env tsx
// Phase 12B B4 — idempotent seed for a fresh Postgres bootstrap.
//
// What belongs here (purely reproducible, non-crawler, non-user-derived rows):
//   - deposit_tiers : 5 L402 rate tiers from Phase 9 v39 (21→1.0 / 1000→0.5 /
//     10000→0.2 / 100000→0.1 / 1000000→0.05). Immutable schedule — changing
//     these would break contracts on already-issued tokens.
//
// What does NOT belong here (see docs/phase-12b/SEED-NOTES.md):
//   - operators/operator_identities/operator_ownerships : crawler-derived via
//     inferOperatorsFromExistingData.ts from transactions + agents tables; the
//     crawler rebuilds them on its own.
//   - service_endpoints : crawler discovers from 402index + L402Apps (94+
//     known endpoints). Self-registered endpoints come from /api/services/register.
//   - agents : ingested by crawler/lndGraphCrawler.
//   - categories : a code constant in src/utils/categoryValidation.ts,
//     enforced at insert time; no DB row to seed.
//
// Run: `npx tsx src/scripts/seedBootstrap.ts` (or `npm run seed:bootstrap`).
// Dry-run: `npx tsx src/scripts/seedBootstrap.ts --dry-run` — logs what WOULD
// be inserted (resolved rowCounts via SELECT) without touching the DB.
// Safe to re-run — every INSERT uses ON CONFLICT DO NOTHING.

import { getPool, closePools } from '../database/connection';
import { logger } from '../logger';

interface DepositTierSeed {
  min_deposit_sats: number;
  rate_sats_per_request: number;
  discount_pct: number;
}

const DEPOSIT_TIERS: DepositTierSeed[] = [
  { min_deposit_sats: 21,      rate_sats_per_request: 1.0,  discount_pct: 0  },
  { min_deposit_sats: 1000,    rate_sats_per_request: 0.5,  discount_pct: 50 },
  { min_deposit_sats: 10000,   rate_sats_per_request: 0.2,  discount_pct: 80 },
  { min_deposit_sats: 100000,  rate_sats_per_request: 0.1,  discount_pct: 90 },
  { min_deposit_sats: 1000000, rate_sats_per_request: 0.05, discount_pct: 95 },
];

export interface SeedSummary {
  depositTiersInserted: number;
  depositTiersExisting: number;
  dryRun: boolean;
}

export async function runSeed(options: { dryRun?: boolean } = {}): Promise<SeedSummary> {
  const pool = getPool();
  const now = Date.now();
  const dryRun = options.dryRun === true;
  const summary: SeedSummary = {
    depositTiersInserted: 0,
    depositTiersExisting: 0,
    dryRun,
  };

  for (const tier of DEPOSIT_TIERS) {
    if (dryRun) {
      // Dry-run : on vérifie la présence sans modifier la DB.
      const existing = await pool.query<{ c: number }>(
        'SELECT COUNT(*)::int AS c FROM deposit_tiers WHERE min_deposit_sats = $1',
        [tier.min_deposit_sats],
      );
      if ((existing.rows[0]?.c ?? 0) === 0) {
        summary.depositTiersInserted++;
        logger.info({ tier, action: 'WOULD_INSERT' }, 'dry-run');
      } else {
        summary.depositTiersExisting++;
        logger.info({ tier, action: 'SKIP_EXISTING' }, 'dry-run');
      }
      continue;
    }

    const { rowCount } = await pool.query(
      `INSERT INTO deposit_tiers (min_deposit_sats, rate_sats_per_request, discount_pct, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (min_deposit_sats) DO NOTHING`,
      [tier.min_deposit_sats, tier.rate_sats_per_request, tier.discount_pct, now],
    );
    if (rowCount && rowCount > 0) summary.depositTiersInserted++;
    else summary.depositTiersExisting++;
  }

  logger.info(summary, dryRun ? 'seed bootstrap DRY-RUN complete' : 'seed bootstrap complete');
  return summary;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  runSeed({ dryRun })
    .then(async () => {
      await closePools();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'seed bootstrap failed');
      await closePools();
      process.exit(1);
    });
}
