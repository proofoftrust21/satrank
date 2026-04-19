#!/usr/bin/env tsx
// Phase 3 C2 — backfill historique : probe_results → transactions + aggregates.
//
// Pourquoi : entre v10 (table probe_results) et v34 (branch bayesienne), toutes
// les probes historiques ont été écrites dans probe_results mais jamais dans
// transactions. C1.1 câble le flux LIVE (chaque nouvelle probe → tx + ingest),
// mais sans rejouer l'historique, les agrégats bayesiens restent vides sur les
// nœuds qui n'ont pas re-probé depuis le déploiement.
//
// Contract (par parité avec C1.1) :
//   - Une tx par (target_hash, UTC-day, 1000 sats). Probes plus grosses
//     (10k/100k/1M) = tiers capacity-discovery, skip (même logique que
//     ProbeCrawler.ingestProbeToBayesian).
//   - Idempotence via tx_id = sha256('lnprobe:<target>:<bucket>:1000').
//     Un rerun ne duplique rien, ni côté transactions ni côté aggregates.
//   - Aggregates peuplés : endpoint + operator dans les 3 fenêtres (24h/7d/30d).
//     Route aggregates ignorés (pas de caller_hash dans probe_results).
//
// INSERT-only. Zero coupling avec TRANSACTIONS_DUAL_WRITE_MODE : le backfill
// force mode='active' — on VEUT les 4 colonnes v31 remplies sur les rows
// historiques, sinon loadObservations les ignore.
//
// --dry-run : compte ce qui serait inséré sans écrire. Aucune écriture
// transactions ni aggregates ; retourne le shape standard.
//
// --chunk-size=N : default 1000. Le script insère en batches de N dans une
// transaction SQLite pour la throughput. À 38k rows, ~20s en mode actif.
//
// --limit=N : stop après N probes traitées. Utile pour smoke-test sur un
// petit échantillon avant full run.
//
// Checkpoint-able via fichier JSON (opt-in). Un run interrompu reprend depuis
// probe_results.id > last_scanned_id sans rescanner.
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../utils/crypto';
import { windowBucket } from '../utils/dualWriteLogger';
import {
  EndpointAggregateRepository,
  OperatorAggregateRepository,
  ServiceAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../repositories/aggregatesRepository';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { TransactionRepository } from '../repositories/transactionRepository';
import type { DualWriteEnrichment } from '../utils/dualWriteLogger';

const BASE_AMOUNT_SATS = 1000;
const DEFAULT_CHUNK = 1000;

export interface BackfillProbeCheckpoint {
  probe_results_last_id: number;
}

export interface BackfillProbeOptions {
  db: Database.Database;
  dryRun?: boolean;
  chunkSize?: number;
  limit?: number;
  checkpointPath?: string;
  checkpoint?: BackfillProbeCheckpoint;
}

export interface BackfillProbeResult {
  scanned: number;
  /** New tx rows inserted (or would-insert in dry-run). Probe days already
   *  covered by a prior run collide on tx_id and aren't counted here. */
  inserted: number;
  /** Rows skipped because they weren't base-amount probes (higher tiers). */
  skippedNonBase: number;
  /** Rows skipped because the target agent is missing (FK would fail). */
  skippedOrphanTarget: number;
  /** Rows skipped because tx_id already existed from a prior run / same-day
   *  duplicate in probe_results (the daily bucket collision — by design). */
  skippedDuplicate: number;
  /** Rows that caused an unrecoverable error (e.g. schema mismatch). */
  errors: number;
  checkpoint: BackfillProbeCheckpoint;
}

function emptyCheckpoint(): BackfillProbeCheckpoint {
  return { probe_results_last_id: 0 };
}

export function loadCheckpoint(p: string): BackfillProbeCheckpoint {
  if (!fs.existsSync(p)) return emptyCheckpoint();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { probe_results_last_id: Number(parsed.probe_results_last_id) || 0 };
  } catch { return emptyCheckpoint(); }
}

export function saveCheckpoint(p: string, cp: BackfillProbeCheckpoint): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cp, null, 2));
}

export function runBackfillChunk(opts: BackfillProbeOptions): BackfillProbeResult {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const dryRun = opts.dryRun ?? false;
  const cp: BackfillProbeCheckpoint = opts.checkpoint
    ? { ...opts.checkpoint }
    : opts.checkpointPath
      ? loadCheckpoint(opts.checkpointPath)
      : emptyCheckpoint();

  const result: BackfillProbeResult = {
    scanned: 0, inserted: 0,
    skippedNonBase: 0, skippedOrphanTarget: 0, skippedDuplicate: 0,
    errors: 0,
    checkpoint: cp,
  };

  // Filtre base-amount + resume depuis le checkpoint. probe_amount_sats a été
  // ajouté en v20 avec un DEFAULT 1000, donc les rows antérieures sont aussi
  // considérées base-amount (cohérent avec leur usage original).
  const rows = opts.db.prepare(`
    SELECT id AS rid, target_hash, probed_at, reachable, probe_amount_sats
    FROM probe_results
    WHERE id > ?
    ORDER BY id
    LIMIT ?
  `).all(cp.probe_results_last_id, chunkSize) as Array<{
    rid: number;
    target_hash: string;
    probed_at: number;
    reachable: number;
    probe_amount_sats: number | null;
  }>;

  const txRepo = new TransactionRepository(opts.db);
  const bayesian = new BayesianScoringService(
    new EndpointAggregateRepository(opts.db),
    new ServiceAggregateRepository(opts.db),
    new OperatorAggregateRepository(opts.db),
    new NodeAggregateRepository(opts.db),
    new RouteAggregateRepository(opts.db),
    new EndpointStreamingPosteriorRepository(opts.db),
    new ServiceStreamingPosteriorRepository(opts.db),
    new OperatorStreamingPosteriorRepository(opts.db),
    new NodeStreamingPosteriorRepository(opts.db),
    new RouteStreamingPosteriorRepository(opts.db),
    new EndpointDailyBucketsRepository(opts.db),
    new ServiceDailyBucketsRepository(opts.db),
    new OperatorDailyBucketsRepository(opts.db),
    new NodeDailyBucketsRepository(opts.db),
    new RouteDailyBucketsRepository(opts.db),
  );

  // FK guard : vérifier d'abord que chaque target existe dans agents. Orphan
  // rows (target supprimé entre-temps) seraient rejetés par la contrainte FK.
  const agentExists = opts.db.prepare('SELECT 1 FROM agents WHERE public_key_hash = ?');

  for (const row of rows) {
    result.scanned++;
    cp.probe_results_last_id = row.rid;

    const amount = row.probe_amount_sats ?? BASE_AMOUNT_SATS;
    if (amount !== BASE_AMOUNT_SATS) {
      result.skippedNonBase++;
      continue;
    }

    if (!agentExists.get(row.target_hash)) {
      result.skippedOrphanTarget++;
      continue;
    }

    const bucket = windowBucket(row.probed_at);
    const txId = sha256(`lnprobe:${row.target_hash}:${bucket}:${BASE_AMOUNT_SATS}`);

    // Same-day collision (déjà backfillé ou probe LIVE depuis C1.1 a déjà
    // ingéré cette journée) → skip. C'est la garantie d'idempotence.
    if (txRepo.findById(txId)) {
      result.skippedDuplicate++;
      continue;
    }

    if (dryRun) {
      result.inserted++;
      continue;
    }

    try {
      opts.db.transaction(() => {
        const tx = {
          tx_id: txId,
          sender_hash: row.target_hash,
          receiver_hash: row.target_hash,
          amount_bucket: 'micro' as const,
          timestamp: row.probed_at,
          payment_hash: sha256(`${txId}:ph`),
          preimage: null,
          status: (row.reachable === 1 ? 'verified' : 'failed') as 'verified' | 'failed',
          protocol: 'keysend' as const,
        };
        const enrichment: DualWriteEnrichment = {
          endpoint_hash: row.target_hash,
          operator_id: row.target_hash,
          source: 'probe',
          window_bucket: bucket,
        };
        // Force mode='active' : le backfill DOIT remplir les 4 colonnes v31
        // sinon les rows insérées sont invisibles à buildVerdict.
        txRepo.insertWithDualWrite(tx, enrichment, 'active', 'probeCrawler');
        bayesian.ingestTransactionOutcome({
          endpointHash: row.target_hash,
          operatorId: row.target_hash,
          success: row.reachable === 1,
          timestamp: row.probed_at,
        });
        // Phase 3 C10 : le verdict lit dans streaming_posteriors (C9), donc
        // le backfill doit aussi alimenter le streaming — sinon un replay de
        // probe_results produit des aggregates pleins mais un verdict vide.
        bayesian.ingestStreaming({
          success: row.reachable === 1,
          timestamp: row.probed_at,
          source: 'probe',
          endpointHash: row.target_hash,
          operatorId: row.target_hash,
          nodePubkey: row.target_hash,
        });
      })();
      result.inserted++;
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[backfill-probe] id=${row.rid} target=${row.target_hash.slice(0, 12)} skipped: ${msg}\n`);
    }
  }

  if (!dryRun && opts.checkpointPath) saveCheckpoint(opts.checkpointPath, cp);
  result.checkpoint = cp;
  return result;
}

/** Drive runBackfillChunk until no more rows or limit reached. */
export function runBackfill(opts: BackfillProbeOptions): BackfillProbeResult {
  const starting = opts.checkpoint
    ? { ...opts.checkpoint }
    : opts.checkpointPath
      ? loadCheckpoint(opts.checkpointPath)
      : emptyCheckpoint();
  const aggregate: BackfillProbeResult = {
    scanned: 0, inserted: 0,
    skippedNonBase: 0, skippedOrphanTarget: 0, skippedDuplicate: 0,
    errors: 0,
    checkpoint: starting,
  };
  let working = { ...starting };
  const limit = opts.limit ?? Infinity;

  const maxIterations = 1_000_000;
  for (let i = 0; i < maxIterations; i++) {
    if (aggregate.scanned >= limit) break;
    const remaining = limit - aggregate.scanned;
    const chunkSize = Math.min(opts.chunkSize ?? DEFAULT_CHUNK, remaining);
    const chunk = runBackfillChunk({ ...opts, checkpoint: working, chunkSize });
    aggregate.scanned += chunk.scanned;
    aggregate.inserted += chunk.inserted;
    aggregate.skippedNonBase += chunk.skippedNonBase;
    aggregate.skippedOrphanTarget += chunk.skippedOrphanTarget;
    aggregate.skippedDuplicate += chunk.skippedDuplicate;
    aggregate.errors += chunk.errors;
    working = { ...chunk.checkpoint };
    aggregate.checkpoint = working;
    if (chunk.scanned === 0) break;
  }
  return aggregate;
}

// ---- CLI entry point ----
function parseArgs(argv: string[]): {
  dbPath: string;
  dryRun: boolean;
  chunkSize: number;
  limit?: number;
  checkpointPath?: string;
} {
  const out = {
    dbPath: process.env.DB_PATH ?? './data/satrank.db',
    dryRun: false,
    chunkSize: DEFAULT_CHUNK as number,
    limit: undefined as number | undefined,
    checkpointPath: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--db' && argv[i + 1]) out.dbPath = argv[++i];
    else if (a === '--chunk-size' && argv[i + 1]) out.chunkSize = Number(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) out.limit = Number(argv[++i]);
    else if (a === '--checkpoint' && argv[i + 1]) out.checkpointPath = argv[++i];
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dbPath)) {
    process.stderr.write(`[backfill-probe] DB not found: ${args.dbPath}\n`);
    process.exit(1);
  }
  const db = new Database(args.dbPath);
  db.pragma('foreign_keys = ON');

  const t0 = Date.now();
  const result = runBackfill({
    db,
    dryRun: args.dryRun,
    chunkSize: args.chunkSize,
    limit: args.limit,
    checkpointPath: args.checkpointPath,
  });
  const durationMs = Date.now() - t0;

  process.stdout.write(JSON.stringify({
    ...result,
    mode: args.dryRun ? 'dry_run' : 'active',
    durationMs,
  }, null, 2) + '\n');

  db.close();
  process.exit(result.errors > 0 ? 2 : 0);
}

const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return invoked === fs.realpathSync(__filename);
  } catch { return false; }
})();
if (isDirect) main();
