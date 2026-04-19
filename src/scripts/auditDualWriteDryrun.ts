#!/usr/bin/env tsx
// Phase 1 audit — consumes the NDJSON emitted by the `dry_run` dual-write
// logger (see `src/utils/dualWriteLogger.ts`) and reports on the enrichment
// pipeline's coherence. Runs against a 48-72h production capture before
// flipping the flag to `active`.
//
// Contract (docs/PHASE-1-DESIGN.md §6):
//   1. Total line volume.
//   2. Distribution by `source_module` (crawler / reportService /
//      decideService / serviceProbes) — counts + %.
//   3. Distribution by `source` (probe / observer / report / intent / null) —
//      counts + %.
//   4. Rate of `endpoint_hash IS NULL` and `operator_id IS NULL`.
//   5. `window_bucket` vs `date(timestamp)` alignment — must be 100 %.
//      Any divergence points to a bug in the writer's enrichment.
//   6. Sampling: 10 deterministic lines for visual inspection.
//   7. Rate of `legacy_inserted: false` — must stay < 0.1 %. Non-zero means
//      we would have logged a shadow line for a tx the legacy path never
//      inserted, i.e. a lost write.
//   8. Exit 0 if combined coherence > 99.9 %, else 1.
//
// Coherence definition: a line is coherent when BOTH the window_bucket
// matches UTC `date(timestamp)` AND `legacy_inserted` is true. That's the
// single number that gates the flip to `active`.
//
// Zero coupling with the runtime: this script can be run anywhere a
// captured NDJSON is available. Accepts `--input <path>` or stdin.
import * as fs from 'node:fs';
import type { DualWriteLogRow, DualWriteSourceModule } from '../utils/dualWriteLogger';
import { windowBucket } from '../utils/dualWriteLogger';

const SOURCE_MODULES: DualWriteSourceModule[] = ['crawler', 'reportService', 'decideService', 'serviceProbes'];
const SOURCE_VALUES = ['probe', 'observer', 'report', 'intent', '__null__'] as const;
type SourceLabel = (typeof SOURCE_VALUES)[number];

export interface AuditReport {
  total_lines: number;
  parse_errors: number;
  by_source_module: Record<DualWriteSourceModule, { count: number; pct: number }>;
  by_source: Record<SourceLabel, { count: number; pct: number }>;
  null_rates: {
    endpoint_hash: { count: number; pct: number };
    operator_id: { count: number; pct: number };
  };
  window_bucket_alignment: { aligned: number; misaligned: number; pct_aligned: number };
  legacy_inserted_false: { count: number; pct: number };
  coherence_pct: number;
  sample: DualWriteLogRow[];
  pass: boolean;
}

export interface AuditOptions {
  /** Sample size (default 10 per §6). */
  sampleSize?: number;
  /** Seed for deterministic sampling. Tests set this to get stable output. */
  sampleSeed?: number;
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 1000) / 10; // 1 decimal place
}

function zeroByModule(): Record<DualWriteSourceModule, { count: number; pct: number }> {
  return {
    crawler: { count: 0, pct: 0 },
    reportService: { count: 0, pct: 0 },
    decideService: { count: 0, pct: 0 },
    serviceProbes: { count: 0, pct: 0 },
    probeCrawler: { count: 0, pct: 0 },
  };
}

function zeroBySource(): Record<SourceLabel, { count: number; pct: number }> {
  return {
    probe: { count: 0, pct: 0 },
    observer: { count: 0, pct: 0 },
    report: { count: 0, pct: 0 },
    intent: { count: 0, pct: 0 },
    __null__: { count: 0, pct: 0 },
  };
}

/** Deterministic LCG used for sampling. We avoid Math.random so test output
 *  is reproducible — the seed becomes part of the audit's printable result. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Reservoir sampling (Algorithm R) — picks k uniform samples from an
 *  unbounded stream in a single pass. Deterministic when the RNG is seeded. */
function reservoirSample<T>(items: T[], k: number, rng: () => number): T[] {
  if (k >= items.length) return [...items];
  const out: T[] = items.slice(0, k);
  for (let i = k; i < items.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < k) out[j] = items[i];
  }
  return out;
}

/** Parse NDJSON content and compute the audit report. Exposed for testing —
 *  the CLI wraps this with I/O. Malformed lines are counted under
 *  `parse_errors` and don't abort the pass. */
export function auditNdjson(content: string, opts: AuditOptions = {}): AuditReport {
  const sampleSize = opts.sampleSize ?? 10;
  const seed = opts.sampleSeed ?? 1;
  const rng = seededRng(seed);

  const byModule = zeroByModule();
  const bySource = zeroBySource();
  let endpointNullCount = 0;
  let operatorNullCount = 0;
  let aligned = 0;
  let misaligned = 0;
  let legacyFalse = 0;
  let bothFail = 0; // lines failing BOTH alignment and legacy_inserted
  let parseErrors = 0;
  const validRows: DualWriteLogRow[] = [];

  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let row: DualWriteLogRow;
    try {
      row = JSON.parse(line) as DualWriteLogRow;
    } catch {
      parseErrors++;
      continue;
    }
    validRows.push(row);

    if (SOURCE_MODULES.includes(row.source_module)) {
      byModule[row.source_module].count++;
    }

    const srcKey: SourceLabel = row.would_insert.source ?? '__null__';
    if (SOURCE_VALUES.includes(srcKey)) {
      bySource[srcKey].count++;
    }

    if (row.would_insert.endpoint_hash == null) endpointNullCount++;
    if (row.would_insert.operator_id == null) operatorNullCount++;

    const derivedBucket = windowBucket(row.would_insert.timestamp);
    const rowMisaligned = row.would_insert.window_bucket !== derivedBucket;
    const rowLegacyFalse = row.legacy_inserted === false;
    if (rowMisaligned) misaligned++; else aligned++;
    if (rowLegacyFalse) legacyFalse++;
    if (rowMisaligned && rowLegacyFalse) bothFail++;
  }

  const total = validRows.length;
  for (const m of SOURCE_MODULES) byModule[m].pct = pct(byModule[m].count, total);
  for (const s of SOURCE_VALUES) bySource[s].pct = pct(bySource[s].count, total);

  const alignmentPct = pct(aligned, total);
  const legacyFalsePct = pct(legacyFalse, total);

  // Coherence = fraction of lines passing BOTH gates (alignment + legacy insert).
  // Empty input returns 100 — there's nothing to be incoherent about.
  // |failing_either| = |misaligned| + |legacyFalse| - |both_fail| (inclusion-exclusion)
  const failingEither = misaligned + legacyFalse - bothFail;
  const coherentLines = total - failingEither;
  const coherencePct = total === 0 ? 100 : pct(coherentLines, total);

  return {
    total_lines: total,
    parse_errors: parseErrors,
    by_source_module: byModule,
    by_source: bySource,
    null_rates: {
      endpoint_hash: { count: endpointNullCount, pct: pct(endpointNullCount, total) },
      operator_id: { count: operatorNullCount, pct: pct(operatorNullCount, total) },
    },
    window_bucket_alignment: { aligned, misaligned, pct_aligned: alignmentPct },
    legacy_inserted_false: { count: legacyFalse, pct: legacyFalsePct },
    coherence_pct: coherencePct,
    sample: reservoirSample(validRows, sampleSize, rng),
    pass: coherencePct > 99.9,
  };
}

// ---- CLI entry point ----
function parseArgs(argv: string[]): { input?: string; sampleSize: number; sampleSeed: number } {
  const out: { input?: string; sampleSize: number; sampleSeed: number } = { sampleSize: 10, sampleSeed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) { out.input = argv[++i]; }
    else if (a === '--sample-size' && argv[i + 1]) { out.sampleSize = Number(argv[++i]); }
    else if (a === '--sample-seed' && argv[i + 1]) { out.sampleSeed = Number(argv[++i]); }
  }
  return out;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const content = args.input ? fs.readFileSync(args.input, 'utf8') : readStdin();
  const report = auditNdjson(content, { sampleSize: args.sampleSize, sampleSeed: args.sampleSeed });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.pass ? 0 : 1);
}

// Run main() only when the script is invoked directly, not when imported.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return invoked === fs.realpathSync(__filename);
  } catch {
    return false;
  }
})();
if (isDirect) main();
