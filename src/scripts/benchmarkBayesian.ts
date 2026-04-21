// Benchmark ingestStreaming — Phase 3 C13.
//
// Exigence : BENCHMARK_UPDATE_COUNT=1000 updates doivent terminer en moins
// de 5 s (budget moyen 5 ms/update). Seuil binaire pass/fail.
//
// Ce benchmark mesure le chemin chaud Bayesian Phase 3 : `ingestStreaming`
// touche 5 tables streaming_posteriors + 5 tables daily_buckets par level
// (endpoint/service/operator/node/route). Concrètement, une observation
// avec endpoint + service + operator + node + caller+target = 10 tables
// touchées (5 streaming + 5 buckets) — mais la plupart des ingestions n'ont
// qu'un subset de clés (probe : endpoint + operator + node).
//
// Phase 12B : tourne contre la base Postgres configurée par $DATABASE_URL.
// Le benchmark ne reset pas la base — les clés générées sont préfixées par
// `bench-<runId>` pour ne pas collisionner avec des données réelles, et
// sont nettoyées à la fin.
//
// Usage :
//   npx tsx src/scripts/benchmarkBayesian.ts
//   BENCHMARK_UPDATE_COUNT=10000 BENCHMARK_BUDGET_MS=50000 npx tsx src/scripts/benchmarkBayesian.ts
//
// Exit codes :
//   0 → durée < budget (pass)
//   1 → durée ≥ budget (fail)
//   2 → erreur de setup / interne

import type { Pool } from 'pg';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
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

export interface BenchmarkOptions {
  updateCount: number;
  budgetMs: number;
}

export interface BenchmarkResult {
  updateCount: number;
  budgetMs: number;
  elapsedMs: number;
  pass: boolean;
  updatesPerSec: number;
}

async function cleanupBenchmarkRows(pool: Pool, runId: string): Promise<void> {
  const prefix = `bench-${runId}-%`;
  const tables = [
    'streaming_posteriors_endpoint',
    'streaming_posteriors_service',
    'streaming_posteriors_operator',
    'streaming_posteriors_node',
    'streaming_posteriors_route',
    'daily_buckets_endpoint',
    'daily_buckets_service',
    'daily_buckets_operator',
    'daily_buckets_node',
    'daily_buckets_route',
  ];
  for (const table of tables) {
    try {
      // The leading identifier column name varies by table; use TRUNCATE
      // semantics via a cheap existence check. Instead of attempting a
      // per-table key-name introspection, cover the common cases by
      // deleting on any string column that begins with the prefix.
      await pool.query(
        `DELETE FROM ${table} WHERE
           EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = $2 AND column_name = 'endpoint_hash')
           AND endpoint_hash LIKE $1`,
        [prefix, table],
      );
    } catch {
      // best-effort cleanup — if the column doesn't exist we just skip
    }
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const pool = getPool();
  await runMigrations(pool);

  const bayesian = new BayesianScoringService(
    new EndpointStreamingPosteriorRepository(pool),
    new ServiceStreamingPosteriorRepository(pool),
    new OperatorStreamingPosteriorRepository(pool),
    new NodeStreamingPosteriorRepository(pool),
    new RouteStreamingPosteriorRepository(pool),
    new EndpointDailyBucketsRepository(pool),
    new ServiceDailyBucketsRepository(pool),
    new OperatorDailyBucketsRepository(pool),
    new NodeDailyBucketsRepository(pool),
    new RouteDailyBucketsRepository(pool),
  );

  const runId = Date.now().toString(36);
  const now = Math.floor(Date.now() / 1000);

  try {
    // Warm up — 10 ingests pour précharger le plan cache pg et les
    // tables (sinon la 1ère mesure inclut ~5ms de compilation SQL).
    for (let i = 0; i < 10; i++) {
      await bayesian.ingestStreaming({
        success: true,
        timestamp: now,
        source: 'probe',
        endpointHash: `bench-${runId}-warmup`,
        serviceHash: `bench-${runId}-warmup-svc`,
        operatorId: `bench-${runId}-warmup-op`,
        nodePubkey: `bench-${runId}-warmup-op`,
        callerHash: `bench-${runId}-warmup-caller`,
        targetHash: `bench-${runId}-warmup`,
      });
    }

    // Mesure — N ingests avec variance sur les clés pour ne pas toucher
    // toujours la même ligne (simule la charge réelle multi-endpoints).
    // 3 sources en rotation (probe/report/paid) pour exercer le 3-way
    // per-source read path qu'utilise le verdict.
    const sources = ['probe', 'report', 'paid'] as const;
    const startNs = process.hrtime.bigint();
    for (let i = 0; i < options.updateCount; i++) {
      const bucket = i % 100; // 100 endpoints distincts
      await bayesian.ingestStreaming({
        success: i % 7 !== 0, // ~85% success
        timestamp: now - (i % 604800), // dispersion sur 7j
        source: sources[i % 3],
        tier: 'medium',
        endpointHash: `bench-${runId}-endpoint-${bucket}`,
        serviceHash: `bench-${runId}-service-${bucket % 10}`,
        operatorId: `bench-${runId}-operator-${bucket % 20}`,
        nodePubkey: `bench-${runId}-operator-${bucket % 20}`,
        callerHash: `bench-${runId}-caller-${i % 50}`,
        targetHash: `bench-${runId}-endpoint-${bucket}`,
      });
    }
    const endNs = process.hrtime.bigint();
    const elapsedMs = Number(endNs - startNs) / 1_000_000;

    return {
      updateCount: options.updateCount,
      budgetMs: options.budgetMs,
      elapsedMs,
      pass: elapsedMs < options.budgetMs,
      updatesPerSec: options.updateCount / (elapsedMs / 1000),
    };
  } finally {
    await cleanupBenchmarkRows(pool, runId);
  }
}

// --- CLI entry point ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

async function main(): Promise<void> {
  const updateCount = Number(process.env.BENCHMARK_UPDATE_COUNT ?? '1000');
  const budgetMs = Number(process.env.BENCHMARK_BUDGET_MS ?? '5000');

  try {
    const result = await runBenchmark({ updateCount, budgetMs });
    const perUpdateMs = (result.elapsedMs / result.updateCount).toFixed(3);
    const line =
      `${result.updateCount} updates in ${result.elapsedMs.toFixed(1)}ms ` +
      `(${perUpdateMs}ms/update, ${Math.round(result.updatesPerSec)}/s, budget=${result.budgetMs}ms)`;
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
