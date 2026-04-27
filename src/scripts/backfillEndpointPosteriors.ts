#!/usr/bin/env tsx
// Phase 5 — backfillEndpointPosteriors.
//
// Seeds the per-endpoint streaming posterior table with synthesized values
// from each row's existing `check_count` / `success_count` columns. Runs
// once after Phase 5 deploy so /api/intent immediately surfaces
// discriminating per-URL posteriors instead of waiting for the cron tier
// rotation to rebuild them via serviceHealthCrawler's new write hook.
//
// Method per row:
//   alpha = success_count + ALPHA_PRIOR (= 1.5)
//   beta  = (check_count - success_count) + BETA_PRIOR (= 1.5)
//   total_ingestions = check_count
//   last_update_ts = last_checked_at ?? now()
//
// Idempotent — uses ON CONFLICT (url_hash, source) DO NOTHING. Re-running
// the script will not overwrite posteriors that have already accumulated
// real per-endpoint observations from the forward write hook.
//
// Run via:
//   docker exec satrank-api npx tsx src/scripts/backfillEndpointPosteriors.ts
//   (or `npm run backfill:endpoint-posteriors` if a script alias is added)

import { getPool, closePools } from '../database/connection';
import { endpointHash } from '../utils/urlCanonical';
import { logger } from '../logger';

const ALPHA_PRIOR = 1.5;
const BETA_PRIOR = 1.5;

interface BackfillSummary {
  scanned: number;
  inserted: number;
  skippedNoChecks: number;
  skippedAlreadyPresent: number;
  skippedMalformed: number;
}

async function backfill(pool: import('pg').Pool): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    scanned: 0,
    inserted: 0,
    skippedNoChecks: 0,
    skippedAlreadyPresent: 0,
    skippedMalformed: 0,
  };

  const { rows } = await pool.query<{
    url: string;
    check_count: string;
    success_count: string;
    last_checked_at: number | null;
  }>(
    `SELECT url, check_count::text, success_count::text, last_checked_at
       FROM service_endpoints
      WHERE deprecated = FALSE
      ORDER BY url`,
  );

  for (const row of rows) {
    summary.scanned++;
    const checkCount = Number(row.check_count);
    const successCount = Number(row.success_count);
    if (checkCount < 1) {
      summary.skippedNoChecks++;
      continue;
    }
    let urlHash: string;
    try {
      urlHash = endpointHash(row.url);
    } catch {
      summary.skippedMalformed++;
      continue;
    }
    const failureCount = Math.max(0, checkCount - successCount);
    const alpha = successCount + ALPHA_PRIOR;
    const beta = failureCount + BETA_PRIOR;
    const ts = row.last_checked_at ?? Math.floor(Date.now() / 1000);
    const result = await pool.query(
      `INSERT INTO endpoint_streaming_posteriors
         (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
       VALUES ($1, 'probe', $2, $3, $4, $5)
       ON CONFLICT (url_hash, source) DO NOTHING`,
      [urlHash, alpha, beta, ts, checkCount],
    );
    if (result.rowCount && result.rowCount > 0) summary.inserted++;
    else summary.skippedAlreadyPresent++;
  }

  return summary;
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    logger.info('Phase 5 backfillEndpointPosteriors — starting');
    const summary = await backfill(pool);
    logger.info(summary, 'Phase 5 backfillEndpointPosteriors — complete');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closePools();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'backfillEndpointPosteriors failed');
    process.exit(1);
  });
}

export { backfill, ALPHA_PRIOR, BETA_PRIOR };
export type { BackfillSummary };
