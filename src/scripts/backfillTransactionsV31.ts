#!/usr/bin/env tsx
// Phase 1 backfill — populate the v31 enrichment columns on historical
// `transactions` rows that pre-date the dual-write wiring.
//
// Scope (per docs/PHASE-1-DESIGN.md §5): UPDATE-only. The script never
// creates new tx rows — pre-v31 probe_results / service_probes historical
// data stays in those tables as it has been since v10 / v23 respectively.
// Where an existing tx row already carries payment_hash / tx_id pointers
// that correlate with those auxiliary tables, we derive the enrichment
// values and fill in the 4 new columns.
//
// Sources scanned (order matters — service_probes is most URL-rich):
//   1. service_probes.payment_hash ↔ transactions.payment_hash
//      → endpoint_hash = sha256(canonicalize(url))
//        operator_id   = service_probes.agent_hash
//        source        = 'probe'
//        window_bucket = UTC date of service_probes.probed_at
//   2. attestations.tx_id ↔ transactions.tx_id
//      → endpoint_hash = NULL (attestations carry no URL)
//        operator_id   = attestations.subject_hash
//        source        = 'report'
//        window_bucket = UTC date of transactions.timestamp
//
// Idempotence is enforced by the `WHERE endpoint_hash IS NULL` guard on
// every UPDATE: a re-run after a partial failure never overwrites a row
// that's already enriched. The checkpoint file carries the last scanned
// rowid per source so a long run can resume without rescanning billions
// of rows on restart.
//
// --dry-run: the script counts how many rows *would* be updated per source
// without issuing any write. Emits the same counters under the `wouldUpdate`
// label. No checkpoint is saved in dry-run mode.
//
// Zero coupling with TRANSACTIONS_DUAL_WRITE_MODE — this is a standalone
// migration helper, not a runtime path. Run it with mode=off or mode=dry_run
// in the config (doesn't matter).
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { windowBucket } from '../utils/dualWriteLogger';

export interface BackfillCheckpoint {
  service_probes_last_id: number;
  attestations_last_id: number;
}

export interface BackfillOptions {
  db: Database.Database;
  dryRun?: boolean;
  checkpointPath?: string;
  chunkSize?: number;
  /** In-memory checkpoint override. When set, the chunk ignores any on-disk
   *  state and uses this as its starting position. `runBackfill` uses this to
   *  thread state across iterations without hitting the filesystem between
   *  chunks — essential in dry-run mode where the disk file isn't updated. */
  checkpoint?: BackfillCheckpoint;
}

export interface BackfillResult {
  service_probes: { scanned: number; updated: number };
  attestations: { scanned: number; updated: number };
  checkpoint: BackfillCheckpoint;
}

const DEFAULT_CHUNK = 1000;

function emptyCheckpoint(): BackfillCheckpoint {
  return { service_probes_last_id: 0, attestations_last_id: 0 };
}

export function loadCheckpoint(checkpointPath: string): BackfillCheckpoint {
  if (!fs.existsSync(checkpointPath)) return emptyCheckpoint();
  try {
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Defensive: a partial file (e.g. from a v0 → v1 schema bump) should
    // degrade to a fresh-scan rather than crash. Missing fields default to 0.
    return {
      service_probes_last_id: Number(parsed.service_probes_last_id) || 0,
      attestations_last_id: Number(parsed.attestations_last_id) || 0,
    };
  } catch {
    return emptyCheckpoint();
  }
}

export function saveCheckpoint(checkpointPath: string, cp: BackfillCheckpoint): void {
  fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
}

/** One pass over all sources. Returns counters and the resulting checkpoint.
 *  Designed to be called in a loop by main() until no more rows are scanned. */
export function runBackfillChunk(opts: BackfillOptions): BackfillResult {
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const dryRun = opts.dryRun ?? false;
  const checkpointPath = opts.checkpointPath;
  // opts.checkpoint takes precedence over disk — set by runBackfill when
  // threading state across chunks. Falls back to disk, then to zeroed.
  const cp: BackfillCheckpoint = opts.checkpoint
    ? { ...opts.checkpoint }
    : checkpointPath
      ? loadCheckpoint(checkpointPath)
      : emptyCheckpoint();

  const result: BackfillResult = {
    service_probes: { scanned: 0, updated: 0 },
    attestations: { scanned: 0, updated: 0 },
    checkpoint: cp,
  };

  // ---- Phase 1: service_probes → transactions ----
  // service_probes without a payment_hash cannot be joined back to any tx
  // row, so they're skipped at the SELECT level (no wasted scans).
  const probesStmt = opts.db.prepare(`
    SELECT id, url, agent_hash, probed_at, payment_hash
    FROM service_probes
    WHERE id > ? AND payment_hash IS NOT NULL
    ORDER BY id
    LIMIT ?
  `);
  const updateByPaymentHashStmt = opts.db.prepare(`
    UPDATE transactions
    SET endpoint_hash = ?, operator_id = ?, source = ?, window_bucket = ?
    WHERE payment_hash = ? AND endpoint_hash IS NULL
  `);

  const probeRows = probesStmt.all(cp.service_probes_last_id, chunk) as Array<{
    id: number;
    url: string;
    agent_hash: string | null;
    probed_at: number;
    payment_hash: string;
  }>;

  for (const row of probeRows) {
    result.service_probes.scanned++;
    let ep: string | null = null;
    try {
      // canonicalizeUrl is called only to surface malformed input early;
      // endpointHash wraps the same call and returns sha256(canonical).
      canonicalizeUrl(row.url);
      ep = endpointHash(row.url);
    } catch {
      // Malformed URL in history — leave endpoint_hash NULL rather than
      // crash the whole pass. The row is still scanned (counter bumped)
      // and we advance the checkpoint to skip it next run.
      ep = null;
    }
    const bucket = windowBucket(row.probed_at);

    if (!dryRun) {
      const info = updateByPaymentHashStmt.run(
        ep, row.agent_hash, 'probe', bucket, row.payment_hash,
      );
      result.service_probes.updated += info.changes;
    } else {
      // Dry-run: count rows that WOULD update. A SELECT COUNT with the
      // same predicate matches reality without mutating.
      const countRow = opts.db.prepare(
        'SELECT COUNT(*) as c FROM transactions WHERE payment_hash = ? AND endpoint_hash IS NULL',
      ).get(row.payment_hash) as { c: number };
      result.service_probes.updated += countRow.c;
    }
    cp.service_probes_last_id = row.id;
  }

  // ---- Phase 2: attestations → transactions ----
  const attestationsStmt = opts.db.prepare(`
    SELECT a.rowid as rid, a.tx_id, a.subject_hash, t.timestamp
    FROM attestations a
    JOIN transactions t ON t.tx_id = a.tx_id
    WHERE a.rowid > ? AND t.endpoint_hash IS NULL
    ORDER BY a.rowid
    LIMIT ?
  `);
  const updateByTxIdStmt = opts.db.prepare(`
    UPDATE transactions
    SET operator_id = ?, source = ?, window_bucket = ?
    WHERE tx_id = ? AND endpoint_hash IS NULL
  `);

  const attRows = attestationsStmt.all(cp.attestations_last_id, chunk) as Array<{
    rid: number;
    tx_id: string;
    subject_hash: string;
    timestamp: number;
  }>;

  for (const row of attRows) {
    result.attestations.scanned++;
    const bucket = windowBucket(row.timestamp);

    if (!dryRun) {
      const info = updateByTxIdStmt.run(row.subject_hash, 'report', bucket, row.tx_id);
      result.attestations.updated += info.changes;
    } else {
      const countRow = opts.db.prepare(
        'SELECT COUNT(*) as c FROM transactions WHERE tx_id = ? AND endpoint_hash IS NULL',
      ).get(row.tx_id) as { c: number };
      result.attestations.updated += countRow.c;
    }
    cp.attestations_last_id = row.rid;
  }

  if (!dryRun && checkpointPath) {
    saveCheckpoint(checkpointPath, cp);
  }
  result.checkpoint = cp;
  return result;
}

/** Drive runBackfillChunk in a loop until no source advances its rowid. */
export function runBackfill(opts: BackfillOptions): BackfillResult {
  const starting = opts.checkpoint
    ? { ...opts.checkpoint }
    : opts.checkpointPath
      ? loadCheckpoint(opts.checkpointPath)
      : emptyCheckpoint();
  const aggregate: BackfillResult = {
    service_probes: { scanned: 0, updated: 0 },
    attestations: { scanned: 0, updated: 0 },
    checkpoint: starting,
  };
  let working: BackfillCheckpoint = { ...starting };

  // Cap iterations to guard against pathological infinite loops (shouldn't
  // happen given checkpoint advances monotonically, but cheap insurance).
  const maxIterations = 1_000_000;
  for (let i = 0; i < maxIterations; i++) {
    const chunk = runBackfillChunk({ ...opts, checkpoint: working });
    aggregate.service_probes.scanned += chunk.service_probes.scanned;
    aggregate.service_probes.updated += chunk.service_probes.updated;
    aggregate.attestations.scanned += chunk.attestations.scanned;
    aggregate.attestations.updated += chunk.attestations.updated;
    working = { ...chunk.checkpoint };
    aggregate.checkpoint = working;
    if (chunk.service_probes.scanned === 0 && chunk.attestations.scanned === 0) break;
  }
  return aggregate;
}

// ---- CLI entry point ----
function parseArgs(argv: string[]): {
  db: string;
  dryRun: boolean;
  checkpoint: string;
  chunkSize: number;
} {
  const args = { db: '', dryRun: false, checkpoint: '.backfill-transactions-v31.checkpoint.json', chunkSize: DEFAULT_CHUNK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--db' && argv[i + 1]) { args.db = argv[++i]; }
    else if (a === '--checkpoint' && argv[i + 1]) { args.checkpoint = argv[++i]; }
    else if (a === '--chunk-size' && argv[i + 1]) { args.chunkSize = Number(argv[++i]); }
  }
  if (!args.db) {
    process.stderr.write('usage: tsx src/scripts/backfillTransactionsV31.ts --db <path> [--dry-run] [--checkpoint <path>] [--chunk-size <n>]\n');
    process.exit(2);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const absCheckpoint = path.isAbsolute(args.checkpoint) ? args.checkpoint : path.resolve(process.cwd(), args.checkpoint);
  const db = new Database(args.db, { readonly: false });
  try {
    const res = runBackfill({
      db, dryRun: args.dryRun, checkpointPath: absCheckpoint, chunkSize: args.chunkSize,
    });
    process.stdout.write(JSON.stringify({
      mode: args.dryRun ? 'dry-run' : 'live',
      service_probes: res.service_probes,
      attestations: res.attestations,
      checkpoint: res.checkpoint,
    }, null, 2) + '\n');
  } finally {
    db.close();
  }
}

// `require.main === module`-equivalent for tsx: only run main() when this
// file is the entry point, not when imported by the test harness.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return invoked === path.resolve(__filename);
  } catch {
    return false;
  }
})();
if (isDirect) main();
