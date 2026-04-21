// NDJSON shadow logger for Phase 1 `dry_run` dual-write mode.
//
// Purpose: while the flag is `dry_run`, every transaction INSERT leaves the
// legacy 9-column row untouched but also serializes the enriched row we
// WOULD have written in `active` mode. An operator can diff the log against
// the live `transactions` table to validate the crawler's enrichment logic
// before flipping the flag to `active` (see docs/PHASE-1-DESIGN.md §5).
//
// Path resolution at construction:
//   1. Try the configured primary path (production: /var/log/satrank, mounted).
//   2. If the dir can't be created or the file can't be opened for append,
//      fall back to `${cwd}/logs/dual-write-dryrun.ndjson` and WARN so the
//      operator knows the Docker volume is missing.
//   3. If both fail, disable logging (ERROR). Callers (e.g. dry_run mode)
//      degrade gracefully — we never crash the API over a logging issue.
//
// Write failures AFTER init are also swallowed with a single ERROR log; the
// next emit() is another best-effort attempt. Synchronous appendFile is used
// because dual-write volume is bounded by tx throughput (tens per minute in
// production), well below any I/O ceiling that would justify a stream.
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import type { Transaction } from '../types';

export interface DualWriteEnrichment {
  endpoint_hash: string | null;
  operator_id: string | null;
  source: 'probe' | 'report' | 'intent' | 'paid' | null;
  window_bucket: string | null;
}

/** Logical origin of the shadow emit — used by the audit script (§6) to
 *  distribute observed traffic by code-path. Distinct from the DB-level
 *  `source` column inside `would_insert` which tags the tx provenance. */
export type DualWriteSourceModule = 'crawler' | 'reportService' | 'decideService' | 'serviceProbes' | 'probeCrawler' | 'probeController';

/** NDJSON line format defined by docs/PHASE-1-DESIGN.md §3. Each line is a
 *  self-contained JSON object so a batch can be streamed / grepped / fed to
 *  `jq` without any framing state. */
export interface DualWriteLogRow {
  /** unix seconds of the emit itself (not the tx's own `timestamp`). */
  emitted_at: number;
  source_module: DualWriteSourceModule;
  /** Full enriched payload the `active` mode would have written — legacy 9
   *  columns + 4 enrichment columns. Lets the audit script verify column
   *  values match the live row once backfill runs. */
  would_insert: Transaction & DualWriteEnrichment;
  /** True when the legacy INSERT succeeded on this call. Diverging from
   *  true signals a bug (we would have shadow-logged a row we never wrote). */
  legacy_inserted: boolean;
  /** Optional correlation id — lets the audit script group multi-module events. */
  trace_id?: string;
}

export class DualWriteLogger {
  readonly effectivePath: string | null;
  readonly enabled: boolean;
  readonly fallbackActive: boolean;

  constructor(primaryPath: string, cwd: string = process.cwd()) {
    const fallbackPath = path.join(cwd, 'logs', 'dual-write-dryrun.ndjson');

    const tryInit = (p: string): boolean => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // Append an empty string — creates the file if missing, otherwise
        // no-op. Proves write permission without adding bytes.
        fs.appendFileSync(p, '');
        return true;
      } catch {
        return false;
      }
    };

    if (tryInit(primaryPath)) {
      this.effectivePath = primaryPath;
      this.enabled = true;
      this.fallbackActive = false;
      logger.info({ path: primaryPath }, 'Dual-write shadow logger initialized (primary path)');
    } else if (tryInit(fallbackPath)) {
      this.effectivePath = fallbackPath;
      this.enabled = true;
      this.fallbackActive = true;
      logger.warn(
        { primaryPath, fallbackPath },
        'Dual-write shadow logger: primary path not writable — using fallback',
      );
    } else {
      this.effectivePath = null;
      this.enabled = false;
      this.fallbackActive = false;
      logger.error(
        { primaryPath, fallbackPath },
        'Dual-write shadow logger: primary and fallback paths both unwritable — shadow logging DISABLED',
      );
    }
  }

  emit(row: DualWriteLogRow): void {
    if (!this.enabled || !this.effectivePath) return;
    try {
      fs.appendFileSync(this.effectivePath, `${JSON.stringify(row)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log once at ERROR; a prolonged outage would flood logs, so callers
      // should treat this as best-effort. In practice, disk full or volume
      // unmounted are the only realistic triggers.
      logger.error({ path: this.effectivePath, error: msg }, 'Dual-write shadow logger: append failed');
    }
  }
}

/** UTC YYYY-MM-DD-HH 6-hour bucket used as the `window_bucket` enrichment
 *  column. Hour is rounded down to 00/06/12/18 so each target produces at
 *  most 4 observations per day — fine-grained enough that peer/routing state
 *  has time to change between buckets (~6h is an independence horizon for LN
 *  liquidity), coarse enough to stay anti-gaming (no ingestion floods from
 *  bursty probing). UTC for cross-timezone rollup consistency. */
export function windowBucket(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const hourBucket = Math.floor(d.getUTCHours() / 6) * 6;
  return `${d.toISOString().slice(0, 10)}-${String(hourBucket).padStart(2, '0')}`;
}
