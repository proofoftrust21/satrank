#!/usr/bin/env tsx
// One-shot backfill — populate endpoint_stage_posteriors stage=1 (challenge)
// from the aggregate counts already on service_endpoints.
//
// Why: Sim 7 (2026-04-29) showed stage_posteriors absent on every candidate
// served by /api/intent because v49 endpoint_stage_posteriors was created at
// PR-7 deploy with no historical seed. This script compresses the existing
// `service_endpoints.check_count / success_count` aggregate into a stage 1
// Beta posterior per endpoint, so /api/intent surfaces meaningful stages
// immediately. Live writes from `ServiceHealthCrawler.observeChallenge`
// continue accumulating on top with the standard decay-at-read mechanism.
//
// Usage:
//   DATABASE_URL=postgres://... node dist/scripts/backfillStagePosteriors.js
//
// Idempotent: re-running replaces the backfilled posteriors with the latest
// aggregates from service_endpoints. Live observations between runs are
// preserved by the application-level decay path on subsequent writes (each
// run resets `last_updated` to now and re-bases α/β on the aggregate, so
// repeated runs do not double-count).
import { Pool } from 'pg';
import {
  EndpointStagePosteriorsRepository,
  STAGE_CHALLENGE,
} from '../repositories/endpointStagePosteriorsRepository';
import { endpointHash } from '../utils/urlCanonical';

interface EndpointRow {
  url: string;
  check_count: number;
  success_count: number;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbUrl });
  const repo = new EndpointStagePosteriorsRepository(pool);

  const start = Date.now();
  const { rows } = await pool.query<EndpointRow>(
    `SELECT url,
            check_count::int AS check_count,
            success_count::int AS success_count
       FROM service_endpoints
      WHERE check_count > 0
      ORDER BY check_count DESC`,
  );

  console.log(`Backfilling stage 1 (challenge) for ${rows.length} endpoints...`);

  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const success = Math.max(0, row.success_count);
    const fail = Math.max(0, row.check_count - row.success_count);
    if (success === 0 && fail === 0) {
      skipped++;
      continue;
    }
    const urlHash = endpointHash(row.url);
    if (success > 0) {
      await repo.observeByUrlHash(urlHash, STAGE_CHALLENGE, true, success, 'backfill_aggregate');
    }
    if (fail > 0) {
      await repo.observeByUrlHash(urlHash, STAGE_CHALLENGE, false, fail, 'backfill_aggregate');
    }
    written++;
    if (written % 50 === 0) {
      console.log(`  ${written}/${rows.length} endpoints backfilled`);
    }
  }

  const { rows: summary } = await pool.query<{
    n: string;
    total_obs: string;
  }>(
    `SELECT count(*)::text AS n, sum(n_obs)::text AS total_obs
       FROM endpoint_stage_posteriors
      WHERE stage = 1`,
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s: written=${written} skipped=${skipped} stage1_rows=${summary[0].n} total_n_obs=${summary[0].total_obs}`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
