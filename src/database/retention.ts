// Chunked retention cleanup for time-series tables. Each policy is
// applied as a loop of RETENTION_CHUNK_SIZE DELETEs so the WAL stays
// small and other readers/writers can interleave. Yields via
// setImmediate between chunks to keep the crawler's event loop
// responsive (heartbeat, probes, api IO). Invoked from
// src/crawler/run.ts at startup and on a 6h interval.
import type Database from 'better-sqlite3';
import { logger } from '../logger';
import {
  RETENTION_POLICIES,
  RETENTION_CHUNK_SIZE,
  type RetentionPolicy,
} from '../config/retention';

export interface RetentionResult {
  readonly table: string;
  readonly deleted: number;
  readonly cutoffTimestamp: number;
  readonly durationMs: number;
}

export interface RetentionOptions {
  /** Unix seconds. Defaults to `Math.floor(Date.now() / 1000)`.
   *  Inject a fake clock in tests. */
  now?: number;
  /** Override the default policy list. Tests pass a narrow subset. */
  policies?: readonly RetentionPolicy[];
  /** Override chunk size. Tests use a small value to exercise the loop. */
  chunkSize?: number;
}

/**
 * Sweep old rows from time-series tables according to the retention
 * policies. Returns per-table delete counts for logging and tests.
 *
 * Safe to call concurrently with crawler writes: each chunk is its own
 * implicit transaction, and the WHERE clause filters strictly by
 * timestamp so in-flight inserts (which always carry a recent
 * timestamp) cannot be affected.
 */
export async function runRetentionCleanup(
  db: Database.Database,
  opts: RetentionOptions = {},
): Promise<RetentionResult[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const policies = opts.policies ?? RETENTION_POLICIES;
  const chunkSize = opts.chunkSize ?? RETENTION_CHUNK_SIZE;

  const results: RetentionResult[] = [];

  for (const policy of policies) {
    const cutoff = now - policy.maxAgeDays * 86400;
    // Table and column names come from a hard-coded policy list — never
    // user input — so string interpolation into the SQL is safe. Only
    // the cutoff and chunk size are bound as parameters.
    const stmt = db.prepare(
      `DELETE FROM ${policy.table} WHERE rowid IN (
         SELECT rowid FROM ${policy.table} WHERE ${policy.column} < ? LIMIT ?
       )`,
    );

    const t0 = Date.now();
    let deleted = 0;
    // Loop until a chunk returns 0 changes — then we know the table
    // has no more rows older than the cutoff.
    while (true) {
      const info = stmt.run(cutoff, chunkSize);
      const chunkDeleted = info.changes ?? 0;
      if (chunkDeleted === 0) break;
      deleted += chunkDeleted;
      // Yield to the event loop so the liveness heartbeat, probe
      // crawler, api requests, etc. can run between chunks. Without
      // this a multi-million-row sweep would block for minutes under
      // the 1-CPU container cap.
      await new Promise<void>((r) => setImmediate(r));
    }
    const durationMs = Date.now() - t0;

    logger.info(
      {
        table: policy.table,
        deleted,
        cutoffDays: policy.maxAgeDays,
        cutoffTimestamp: cutoff,
        durationMs,
      },
      'Retention cleanup',
    );

    results.push({
      table: policy.table,
      deleted,
      cutoffTimestamp: cutoff,
      durationMs,
    });
  }

  return results;
}
