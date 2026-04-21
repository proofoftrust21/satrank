// Validation du moteur bayésien — C11.
//
// Objectif Phase 3 : Kendall τ ≥ 0.90 entre le ranking bayésien et le ground
// truth de succès sur un dataset synthétique. Seuil binaire pass/fail.
//
// Pourquoi pas une comparaison directe Bayesian vs Legacy composite ?
// Parce que les deux mesurent des choses différentes (le composite mélange
// volume / seniority / diversity ; le bayésien ne regarde que les observations
// de succès/échec). Une corrélation forte entre les deux ne prouverait rien et
// le brief impose « NO cohabitation with legacy scoring ».
//
// Ce script prouve plutôt que le posterior bayésien préserve l'ordre induit
// par le vrai taux de succès dans la population — c'est-à-dire que le ranking
// qui sortira sur le terrain est bien corrélé au ground truth, malgré le prior
// et la décroissance temporelle.
//
// Phase 12B : tourne contre la base Postgres configurée par $DATABASE_URL.
// Les lignes insérées sont préfixées par `cmp-<runId>-` et supprimées à la fin.
//
// Usage :
//   npx tsx src/scripts/compareLegacyVsBayesian.ts
//   KENDALL_SAMPLE_SIZE=100 npx tsx src/scripts/compareLegacyVsBayesian.ts
//
// Exit codes :
//   0 → τ ≥ seuil (pass)
//   1 → τ <  seuil (fail)
//   2 → erreur de setup / interne

import type { Pool, PoolClient } from 'pg';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
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
import { kendallTau } from '../utils/rankCorrelation';

export interface CompareOptions {
  sampleSize: number;
  txPerAgent: number;
  threshold: number;
  seed?: number;
}

export interface CompareResult {
  tau: number;
  threshold: number;
  pass: boolean;
  sampleSize: number;
  txPerAgent: number;
  details: {
    agentId: string;
    truePSuccess: number;
    observedSuccesses: number;
    bayesianPSuccess: number;
    bayesianVerdict: string;
  }[];
}

/** RNG déterministe (mulberry32) — indispensable pour rejouer les comparaisons. */
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Monotone counter for tx_id uniqueness — `Math.random()` collisions at
 *  ~5000 inserts caused intermittent UNIQUE failures on repeat runs. A
 *  process-scoped counter is deterministic and collision-free. */
let txIdCounter = 0;

/** Insère une transaction vérifiée / failed dans la table `transactions`. */
async function insertTx(
  db: Pool | PoolClient,
  opts: { endpointHash: string; success: boolean; ts: number; source?: string },
): Promise<void> {
  const id = 'tx-' + opts.endpointHash.slice(0, 12) + '-' + (txIdCounter++).toString(36);
  await db.query(
    `INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
                              payment_hash, preimage, status, protocol,
                              endpoint_hash, operator_id, source, window_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      'a'.repeat(64),
      'b'.repeat(64),
      'medium',
      opts.ts,
      'p'.repeat(64),
      null,
      opts.success ? 'verified' : 'failed',
      'l402',
      opts.endpointHash,
      null,
      opts.source ?? 'probe',
      '2026-04-18',
    ],
  );
}

async function cleanupCompareRows(pool: Pool, runId: string): Promise<void> {
  const like = `cmp-${runId}-%`;
  await pool.query('DELETE FROM transactions WHERE endpoint_hash LIKE $1', [like]);
  const aggregateTables = [
    'streaming_posteriors_endpoint',
    'daily_buckets_endpoint',
  ];
  for (const table of aggregateTables) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE endpoint_hash LIKE $1`, [like]);
    } catch {
      // best-effort
    }
  }
}

/** Exécute la comparaison et retourne les métriques. Utilisable aussi en test. */
export async function runComparison(options: CompareOptions): Promise<CompareResult> {
  const rng = makeRng(options.seed ?? 42);
  const pool = getPool();
  await runMigrations(pool);

  const runId = Date.now().toString(36);

  const endpointStreaming = new EndpointStreamingPosteriorRepository(pool);
  const endpointBuckets = new EndpointDailyBucketsRepository(pool);
  const bayesian = new BayesianScoringService(
    endpointStreaming,
    new ServiceStreamingPosteriorRepository(pool),
    new OperatorStreamingPosteriorRepository(pool),
    new NodeStreamingPosteriorRepository(pool),
    new RouteStreamingPosteriorRepository(pool),
    endpointBuckets,
    new ServiceDailyBucketsRepository(pool),
    new OperatorDailyBucketsRepository(pool),
    new NodeDailyBucketsRepository(pool),
    new RouteDailyBucketsRepository(pool),
  );
  const verdictSvc = new BayesianVerdictService(
    bayesian, endpointStreaming, endpointBuckets,
  );

  const now = Math.floor(Date.now() / 1000);
  const details: CompareResult['details'] = [];

  // Phase 12B: FK on transactions(sender_hash,receiver_hash)→agents requires
  // the placeholder sender/receiver rows to exist first.
  await pool.query(
    `INSERT INTO agents (public_key_hash, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score)
     VALUES ($1, 'cmp-sender', $3, $3, 'manual', 0, 0, 0),
            ($2, 'cmp-receiver', $3, $3, 'manual', 0, 0, 0)
     ON CONFLICT (public_key_hash) DO NOTHING`,
    ['a'.repeat(64), 'b'.repeat(64), now],
  );

  try {
    const MIN_P = 0.10;
    const MAX_P = 0.95;
    for (let i = 0; i < options.sampleSize; i++) {
      const agentId = `cmp-${runId}-agent-${i.toString().padStart(4, '0')}`;
      const trueP = options.sampleSize === 1
        ? (MIN_P + MAX_P) / 2
        : MIN_P + (MAX_P - MIN_P) * (i / (options.sampleSize - 1));

      let observedSuccesses = 0;
      const FRESH_WINDOW_SEC = 3 * 3600;
      for (let t = 0; t < options.txPerAgent; t++) {
        const success = rng() < trueP;
        if (success) observedSuccesses++;
        const ageSec = Math.floor(rng() * FRESH_WINDOW_SEC);
        const ts = now - ageSec;
        await insertTx(pool, {
          endpointHash: agentId,
          success,
          ts,
          source: 'probe',
        });
        await bayesian.ingestStreaming({
          success, timestamp: ts, source: 'probe', endpointHash: agentId,
        });
      }

      const verdict = await verdictSvc.buildVerdict({ targetHash: agentId });
      details.push({
        agentId,
        truePSuccess: trueP,
        observedSuccesses,
        bayesianPSuccess: verdict.p_success,
        bayesianVerdict: verdict.verdict,
      });
    }

    const trueValues = details.map((d) => d.truePSuccess);
    const bayesianValues = details.map((d) => d.bayesianPSuccess);
    const { tau } = kendallTau(trueValues, bayesianValues);

    return {
      tau,
      threshold: options.threshold,
      pass: tau >= options.threshold,
      sampleSize: options.sampleSize,
      txPerAgent: options.txPerAgent,
      details,
    };
  } finally {
    await cleanupCompareRows(pool, runId);
  }
}

// --- CLI entry point ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

async function main(): Promise<void> {
  const sampleSize = Number(process.env.KENDALL_SAMPLE_SIZE ?? '60');
  const txPerAgent = Number(process.env.KENDALL_TX_PER_AGENT ?? '80');
  const threshold = Number(process.env.KENDALL_THRESHOLD ?? '0.90');
  const seed = process.env.KENDALL_SEED ? Number(process.env.KENDALL_SEED) : 42;

  try {
    const result = await runComparison({ sampleSize, txPerAgent, threshold, seed });
    const line = `Kendall τ = ${result.tau.toFixed(4)}  (threshold=${threshold}, n=${sampleSize}, txPerAgent=${txPerAgent})`;
    if (result.pass) {
      process.stdout.write(`[PASS] ${line}\n`);
      await closePools();
      process.exit(0);
    } else {
      process.stdout.write(`[FAIL] ${line}\n`);
      await closePools();
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ERROR] ${msg}\n`);
    await closePools();
    process.exit(2);
  }
}

if (isMain) {
  main().catch(async (err) => {
    process.stderr.write(`[ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
    await closePools();
    process.exit(2);
  });
}
