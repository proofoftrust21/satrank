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

export interface DualWriteEnrichment {
  endpoint_hash: string | null;
  operator_id: string | null;
  source: 'probe' | 'observer' | 'report' | 'intent' | null;
  window_bucket: string | null;
}

export interface DualWriteLogRow {
  /** ms since epoch, when the shadow write was attempted */
  loggedAt: number;
  /** the tx_id that the legacy INSERT used — join key against the live table */
  txId: string;
  /** the 4 enrichment columns we would have written in `active` mode */
  enrichment: DualWriteEnrichment;
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
