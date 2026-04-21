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
// transaction Postgres pour la throughput. À 38k rows, ~20s en mode actif.
//
// --limit=N : stop après N probes traitées. Utile pour smoke-test sur un
// petit échantillon avant full run.
//
// Checkpoint-able via fichier JSON (opt-in). Un run interrompu reprend depuis
// probe_results.id > last_scanned_id sans rescanner.
//
// Phase 12B : porté de better-sqlite3 vers pg async. probe_results garde son
// `id BIGINT IDENTITY` — on continue de paginer `WHERE id > $1 ORDER BY id`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { withTransaction } from '../database/transaction';
import { sha256 } from '../utils/crypto';
import { windowBucket } from '../utils/dualWriteLogger';
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
  pool: Pool;
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
   *  duplicate in probe_results (the 6h bucket collision — by design). */
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

interface ProbeRow {
  rid: number;
  target_hash: string;
  probed_at: number;
  reachable: number;
  probe_amount_sats: number | null;
}

export async function runBackfillChunk(opts: BackfillProbeOptions): Promise<BackfillProbeResult> {
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
  const { rows } = await opts.pool.query<ProbeRow>(
    `SELECT id AS rid, target_hash, probed_at, reachable, probe_amount_sats
       FROM probe_results
      WHERE id > $1
      ORDER BY id
      LIMIT $2`,
    [cp.probe_results_last_id, chunkSize],
  );

  // Les reads (findById, agents-exists) passent par le pool principal pour
  // les quick checks (snapshot consistency est acceptable ici). L'écriture
  // de chaque row est atomique via withTransaction.
  const txRepo = new TransactionRepository(opts.pool);

  for (const row of rows) {
    result.scanned++;
    cp.probe_results_last_id = row.rid;

    const amount = row.probe_amount_sats ?? BASE_AMOUNT_SATS;
    if (amount !== BASE_AMOUNT_SATS) {
      result.skippedNonBase++;
      continue;
    }

    // FK guard : verifier que le target existe dans agents. Orphan rows
    // (target supprime entre-temps) seraient rejetes par la contrainte FK.
    const agentCheck = await opts.pool.query<{ exists: number }>(
      'SELECT 1 AS exists FROM agents WHERE public_key_hash = $1 LIMIT 1',
      [row.target_hash],
    );
    if (agentCheck.rows.length === 0) {
      result.skippedOrphanTarget++;
      continue;
    }

    const bucket = windowBucket(row.probed_at);
    const txId = sha256(`lnprobe:${row.target_hash}:${bucket}:${BASE_AMOUNT_SATS}`);

    // Same-day collision (déjà backfillé ou probe LIVE depuis C1.1 a déjà
    // ingéré cette journée) → skip. C'est la garantie d'idempotence.
    const existing = await txRepo.findById(txId);
    if (existing) {
      result.skippedDuplicate++;
      continue;
    }

    if (dryRun) {
      result.inserted++;
      continue;
    }

    try {
      await withTransaction(opts.pool, async (client) => {
        const clientTxRepo = new TransactionRepository(client);
        const bayesian = new BayesianScoringService(
          new EndpointStreamingPosteriorRepository(client),
          new ServiceStreamingPosteriorRepository(client),
          new OperatorStreamingPosteriorRepository(client),
          new NodeStreamingPosteriorRepository(client),
          new RouteStreamingPosteriorRepository(client),
          new EndpointDailyBucketsRepository(client),
          new ServiceDailyBucketsRepository(client),
          new OperatorDailyBucketsRepository(client),
          new NodeDailyBucketsRepository(client),
          new RouteDailyBucketsRepository(client),
        );

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
        await clientTxRepo.insertWithDualWrite(tx, enrichment, 'active', 'probeCrawler');
        // Phase 3 : le verdict lit dans streaming_posteriors — le backfill
        // doit alimenter le streaming sinon un replay produit un verdict vide.
        await bayesian.ingestStreaming({
          success: row.reachable === 1,
          timestamp: row.probed_at,
          source: 'probe',
          endpointHash: row.target_hash,
          operatorId: row.target_hash,
          nodePubkey: row.target_hash,
        });
      });
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
export async function runBackfill(opts: BackfillProbeOptions): Promise<BackfillProbeResult> {
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
    const chunk = await runBackfillChunk({ ...opts, checkpoint: working, chunkSize });
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
  dryRun: boolean;
  chunkSize: number;
  limit?: number;
  checkpointPath?: string;
} {
  const out = {
    dryRun: false,
    chunkSize: DEFAULT_CHUNK as number,
    limit: undefined as number | undefined,
    checkpointPath: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--chunk-size' && argv[i + 1]) out.chunkSize = Number(argv[++i]);
    else if (a === '--limit' && argv[i + 1]) out.limit = Number(argv[++i]);
    else if (a === '--checkpoint' && argv[i + 1]) out.checkpointPath = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getCrawlerPool();
  await runMigrations(pool);

  const t0 = Date.now();
  const result = await runBackfill({
    pool,
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

  await closePools();
  process.exit(result.errors > 0 ? 2 : 0);
}

const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[backfill-probe] FATAL: ${msg}\n`);
    await closePools();
    process.exit(1);
  });
}
