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
// Sources scanned (order matters — service_probes is most URL-rich; observer
// fallback runs last so probe/report wins when available):
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
//   3. observer fallback: transactions rows with source IS NULL after #1/#2
//      → endpoint_hash = NULL (no URL derivable from a bare tx row)
//        operator_id   = transactions.receiver_hash
//        source        = 'observer'
//        window_bucket = UTC date of transactions.timestamp
//
// Phase 12B — pagination cursors:
//   - service_probes uses its BIGINT IDENTITY `id` column.
//   - attestations and transactions lack a rowid column in Postgres; we
//     paginate with the tuple (timestamp, primary_key) for a stable,
//     monotone cursor. The checkpoint file stores both parts per source.
//
// Idempotence is enforced by source-specific guards on every UPDATE:
//   - voies #1 & #2: `WHERE endpoint_hash IS NULL` — safe because only #1 sets
//     endpoint_hash, so #2/#3 never touch a probe-enriched row.
//   - voie #3: `WHERE source IS NULL` — required because #2 also leaves
//     endpoint_hash NULL; guarding on endpoint_hash would cause #3 to
//     re-overwrite report rows as observer on every run.
import type { Pool } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { windowBucket } from '../utils/dualWriteLogger';

export interface TimestampedCursor {
  timestamp: number;
  /** Primary-key stringifier used as tie-breaker when multiple rows share a
   *  timestamp. `''` as the initial value sorts before any real id. */
  id: string;
}

export interface BackfillCheckpoint {
  service_probes_last_id: number;
  attestations_last_cursor: TimestampedCursor;
  transactions_last_cursor: TimestampedCursor;
}

export interface BackfillOptions {
  pool: Pool;
  dryRun?: boolean;
  checkpointPath?: string;
  chunkSize?: number;
  /** In-memory checkpoint override. When set, the chunk ignores any on-disk
   *  state and uses this as its starting position. */
  checkpoint?: BackfillCheckpoint;
}

export interface BackfillResult {
  service_probes: { scanned: number; updated: number };
  attestations: { scanned: number; updated: number };
  observer: { scanned: number; updated: number };
  checkpoint: BackfillCheckpoint;
}

const DEFAULT_CHUNK = 1000;

function emptyCursor(): TimestampedCursor {
  return { timestamp: 0, id: '' };
}

function emptyCheckpoint(): BackfillCheckpoint {
  return {
    service_probes_last_id: 0,
    attestations_last_cursor: emptyCursor(),
    transactions_last_cursor: emptyCursor(),
  };
}

export function loadCheckpoint(checkpointPath: string): BackfillCheckpoint {
  if (!fs.existsSync(checkpointPath)) return emptyCheckpoint();
  try {
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      service_probes_last_id: Number(parsed.service_probes_last_id) || 0,
      attestations_last_cursor: {
        timestamp: Number(parsed?.attestations_last_cursor?.timestamp) || 0,
        id: String(parsed?.attestations_last_cursor?.id ?? ''),
      },
      transactions_last_cursor: {
        timestamp: Number(parsed?.transactions_last_cursor?.timestamp) || 0,
        id: String(parsed?.transactions_last_cursor?.id ?? ''),
      },
    };
  } catch {
    return emptyCheckpoint();
  }
}

export function saveCheckpoint(checkpointPath: string, cp: BackfillCheckpoint): void {
  fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
}

/** One pass over all sources. Returns counters and the resulting checkpoint. */
export async function runBackfillChunk(opts: BackfillOptions): Promise<BackfillResult> {
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const dryRun = opts.dryRun ?? false;
  const checkpointPath = opts.checkpointPath;
  const cp: BackfillCheckpoint = opts.checkpoint
    ? {
      service_probes_last_id: opts.checkpoint.service_probes_last_id,
      attestations_last_cursor: { ...opts.checkpoint.attestations_last_cursor },
      transactions_last_cursor: { ...opts.checkpoint.transactions_last_cursor },
    }
    : checkpointPath
      ? loadCheckpoint(checkpointPath)
      : emptyCheckpoint();

  const result: BackfillResult = {
    service_probes: { scanned: 0, updated: 0 },
    attestations: { scanned: 0, updated: 0 },
    observer: { scanned: 0, updated: 0 },
    checkpoint: cp,
  };

  // Dry-run fidelity: voie #3 scans the SAME set of rows that voies #1 and #2
  // would update, because in dry-run no UPDATE fires first. Without tracking,
  // dry-run would over-count observer rows by the #1+#2 hit count.
  const claimedInDryRun = new Set<string>();

  // ---- Phase 1: service_probes → transactions ----
  const probeRowsResult = await opts.pool.query<{
    id: string; // bigint serializes as string in node-pg by default
    url: string;
    agent_hash: string | null;
    probed_at: number;
    payment_hash: string;
  }>(
    `SELECT id, url, agent_hash, probed_at, payment_hash
       FROM service_probes
      WHERE id > $1 AND payment_hash IS NOT NULL
      ORDER BY id
      LIMIT $2`,
    [cp.service_probes_last_id, chunk],
  );
  const probeRows = probeRowsResult.rows;

  for (const row of probeRows) {
    result.service_probes.scanned++;
    let ep: string | null = null;
    try {
      canonicalizeUrl(row.url);
      ep = endpointHash(row.url);
    } catch {
      ep = null;
    }
    const bucket = windowBucket(row.probed_at);

    if (!dryRun) {
      const info = await opts.pool.query(
        `UPDATE transactions
            SET endpoint_hash = $1, operator_id = $2, source = $3, window_bucket = $4
          WHERE payment_hash = $5 AND endpoint_hash IS NULL`,
        [ep, row.agent_hash, 'probe', bucket, row.payment_hash],
      );
      result.service_probes.updated += info.rowCount ?? 0;
    } else {
      const { rows: matches } = await opts.pool.query<{ tx_id: string }>(
        'SELECT tx_id FROM transactions WHERE payment_hash = $1 AND endpoint_hash IS NULL',
        [row.payment_hash],
      );
      result.service_probes.updated += matches.length;
      for (const m of matches) claimedInDryRun.add(m.tx_id);
    }
    cp.service_probes_last_id = Number(row.id);
  }

  // ---- Phase 2: attestations → transactions ----
  // Paginate with (timestamp, attestation_id). The inner SELECT reads from
  // attestations joined to transactions so the guard `endpoint_hash IS NULL`
  // is evaluated in-db.
  const attRowsResult = await opts.pool.query<{
    attestation_id: string;
    tx_id: string;
    subject_hash: string;
    timestamp: number;
  }>(
    `SELECT a.attestation_id, a.tx_id, a.subject_hash, t.timestamp
       FROM attestations a
       JOIN transactions t ON t.tx_id = a.tx_id
      WHERE t.endpoint_hash IS NULL
        AND (t.timestamp > $1 OR (t.timestamp = $2 AND a.attestation_id > $3))
      ORDER BY t.timestamp ASC, a.attestation_id ASC
      LIMIT $4`,
    [
      cp.attestations_last_cursor.timestamp,
      cp.attestations_last_cursor.timestamp,
      cp.attestations_last_cursor.id,
      chunk,
    ],
  );
  const attRows = attRowsResult.rows;

  for (const row of attRows) {
    result.attestations.scanned++;
    const bucket = windowBucket(row.timestamp);

    if (!dryRun) {
      const info = await opts.pool.query(
        `UPDATE transactions
            SET operator_id = $1, source = $2, window_bucket = $3
          WHERE tx_id = $4 AND endpoint_hash IS NULL`,
        [row.subject_hash, 'report', bucket, row.tx_id],
      );
      result.attestations.updated += info.rowCount ?? 0;
    } else {
      const { rows: countRows } = await opts.pool.query<{ c: string }>(
        'SELECT COUNT(*)::text AS c FROM transactions WHERE tx_id = $1 AND endpoint_hash IS NULL',
        [row.tx_id],
      );
      const c = Number(countRows[0]?.c ?? '0');
      if (c > 0) claimedInDryRun.add(row.tx_id);
      result.attestations.updated += c;
    }
    cp.attestations_last_cursor = { timestamp: row.timestamp, id: row.attestation_id };
  }

  // ---- Phase 3: observer fallback on orphan transactions ----
  const orphansResult = await opts.pool.query<{
    tx_id: string;
    receiver_hash: string;
    timestamp: number;
  }>(
    `SELECT tx_id, receiver_hash, timestamp
       FROM transactions
      WHERE source IS NULL
        AND (timestamp > $1 OR (timestamp = $2 AND tx_id > $3))
      ORDER BY timestamp ASC, tx_id ASC
      LIMIT $4`,
    [
      cp.transactions_last_cursor.timestamp,
      cp.transactions_last_cursor.timestamp,
      cp.transactions_last_cursor.id,
      chunk,
    ],
  );
  const orphanRows = orphansResult.rows;

  for (const row of orphanRows) {
    if (dryRun && claimedInDryRun.has(row.tx_id)) {
      cp.transactions_last_cursor = { timestamp: row.timestamp, id: row.tx_id };
      continue;
    }

    result.observer.scanned++;
    const bucket = windowBucket(row.timestamp);

    if (!dryRun) {
      const info = await opts.pool.query(
        `UPDATE transactions
            SET operator_id = $1, source = $2, window_bucket = $3
          WHERE tx_id = $4 AND source IS NULL`,
        [row.receiver_hash, 'observer', bucket, row.tx_id],
      );
      result.observer.updated += info.rowCount ?? 0;
    } else {
      const { rows: countRows } = await opts.pool.query<{ c: string }>(
        'SELECT COUNT(*)::text AS c FROM transactions WHERE tx_id = $1 AND source IS NULL',
        [row.tx_id],
      );
      result.observer.updated += Number(countRows[0]?.c ?? '0');
    }
    cp.transactions_last_cursor = { timestamp: row.timestamp, id: row.tx_id };
  }

  if (!dryRun && checkpointPath) {
    saveCheckpoint(checkpointPath, cp);
  }
  result.checkpoint = cp;
  return result;
}

/** Drive runBackfillChunk in a loop until no source advances its cursor. */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const starting = opts.checkpoint
    ? {
      service_probes_last_id: opts.checkpoint.service_probes_last_id,
      attestations_last_cursor: { ...opts.checkpoint.attestations_last_cursor },
      transactions_last_cursor: { ...opts.checkpoint.transactions_last_cursor },
    }
    : opts.checkpointPath
      ? loadCheckpoint(opts.checkpointPath)
      : emptyCheckpoint();
  const aggregate: BackfillResult = {
    service_probes: { scanned: 0, updated: 0 },
    attestations: { scanned: 0, updated: 0 },
    observer: { scanned: 0, updated: 0 },
    checkpoint: starting,
  };
  let working: BackfillCheckpoint = {
    service_probes_last_id: starting.service_probes_last_id,
    attestations_last_cursor: { ...starting.attestations_last_cursor },
    transactions_last_cursor: { ...starting.transactions_last_cursor },
  };

  const maxIterations = 1_000_000;
  for (let i = 0; i < maxIterations; i++) {
    const chunk = await runBackfillChunk({ ...opts, checkpoint: working });
    aggregate.service_probes.scanned += chunk.service_probes.scanned;
    aggregate.service_probes.updated += chunk.service_probes.updated;
    aggregate.attestations.scanned += chunk.attestations.scanned;
    aggregate.attestations.updated += chunk.attestations.updated;
    aggregate.observer.scanned += chunk.observer.scanned;
    aggregate.observer.updated += chunk.observer.updated;
    working = {
      service_probes_last_id: chunk.checkpoint.service_probes_last_id,
      attestations_last_cursor: { ...chunk.checkpoint.attestations_last_cursor },
      transactions_last_cursor: { ...chunk.checkpoint.transactions_last_cursor },
    };
    aggregate.checkpoint = working;
    if (
      chunk.service_probes.scanned === 0
      && chunk.attestations.scanned === 0
      && chunk.observer.scanned === 0
    ) break;
  }
  return aggregate;
}

// ---- CLI entry point ----

function defaultCheckpointPath(): string {
  const base = process.env.XDG_STATE_HOME ?? '/tmp';
  return path.join(base, 'backfill-transactions-v31.checkpoint.json');
}

function parseArgs(argv: string[]): {
  dryRun: boolean;
  checkpoint: string;
  chunkSize: number;
} {
  const args = { dryRun: false, checkpoint: defaultCheckpointPath(), chunkSize: DEFAULT_CHUNK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--checkpoint' && argv[i + 1]) { args.checkpoint = argv[++i]; }
    else if (a === '--chunk-size' && argv[i + 1]) { args.chunkSize = Number(argv[++i]); }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const absCheckpoint = path.isAbsolute(args.checkpoint)
    ? args.checkpoint
    : path.resolve(process.cwd(), args.checkpoint);
  const pool = getPool();
  await runMigrations(pool);
  try {
    const res = await runBackfill({
      pool, dryRun: args.dryRun, checkpointPath: absCheckpoint, chunkSize: args.chunkSize,
    });
    process.stdout.write(JSON.stringify({
      mode: args.dryRun ? 'dry-run' : 'live',
      service_probes: res.service_probes,
      attestations: res.attestations,
      observer: res.observer,
      checkpoint: res.checkpoint,
    }, null, 2) + '\n');
  } finally {
    await closePools();
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
if (isDirect) {
  main().catch(async (err) => {
    process.stderr.write(`[backfill-v31] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    await closePools();
    process.exit(1);
  });
}
