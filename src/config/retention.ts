// Retention policies for time-series tables. Applied by
// src/database/retention.ts, invoked from the crawler cron once at
// startup and then every RETENTION_INTERVAL_MS thereafter.
//
// These are compile-time constants rather than env-loaded values
// because changing a retention window affects historical data and
// should go through code review + deploy, not an env flip.

export interface RetentionPolicy {
  readonly table: string;
  readonly column: string;
  readonly maxAgeDays: number;
}

/** Canonical list of tables the retention cron sweeps. Everything else
 *  (agents, transactions, attestations) is explicitly permanent — the
 *  stale sweep handles fossil agents separately. */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  // Regularity component reads the last 7 days of probes; keep 14 for 2x margin.
  { table: 'probe_results',    column: 'probed_at',   maxAgeDays: 14 },
  // Leaderboard deltas go out to 30 days; keep 45 for margin. SnapshotRepository
  // already runs its own 3-tier purge (> 30d delete, 7-30d thin) after each
  // bulk scoring pass — this policy is a defense-in-depth backstop.
  { table: 'score_snapshots',  column: 'computed_at', maxAgeDays: 45 },
  // Channel flow signals use the last 7 days; keep 14 for 2x margin.
  { table: 'channel_snapshots', column: 'snapshot_at', maxAgeDays: 14 },
  // Fee volatility signals use the last 7 days; keep 14 for 2x margin.
  { table: 'fee_snapshots',    column: 'snapshot_at', maxAgeDays: 14 },
];

/** Max rows deleted per DELETE transaction. Keeps the WAL from ballooning
 *  the way a single multi-million-row monolithic DELETE would — we saw
 *  this fail in practice during the 2026-04-09 pre-v15 purge, where a
 *  4.9M-row single-statement DELETE grew the WAL to over 1 GB without
 *  finishing. 50k is the conservative default; the manual purge used
 *  100k successfully. */
export const RETENTION_CHUNK_SIZE = 50_000;

/** Interval between scheduled retention runs in the crawler cron.
 *  6 hours — matches the Nostr publisher cycle so retention runs at a
 *  comparable cadence.  With ~650k probe_results rows/day added, 6h keeps
 *  the table from growing unbounded between container restarts. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
