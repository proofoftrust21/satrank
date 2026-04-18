// Benchmark ingestTransactionOutcome — C11.
//
// Exigence Phase 3 : BENCHMARK_UPDATE_COUNT=1000 updates doivent terminer en
// moins de 5 s (budget moyen 5 ms/update). Seuil binaire pass/fail.
//
// Ce benchmark simule le chemin chaud d'ingestion transactionnelle : chaque
// outcome déclenche une update des 4 niveaux d'agrégats × 3 fenêtres
// temporelles (= 12 lignes touchées par transaction en théorie).
//
// Usage :
//   npx tsx src/scripts/benchmarkBayesian.ts
//   BENCHMARK_UPDATE_COUNT=10000 BENCHMARK_BUDGET_MS=50000 npx tsx src/scripts/benchmarkBayesian.ts
//
// Exit codes :
//   0 → durée < budget (pass)
//   1 → durée ≥ budget (fail)
//   2 → erreur de setup / interne

import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../repositories/aggregatesRepository';
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

export function runBenchmark(options: BenchmarkOptions): BenchmarkResult {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = OFF');
    runMigrations(db);

    const bayesian = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      new RouteAggregateRepository(db),
    );

    // Warm up — 10 outcomes pour précharger les prepared statements et
    // la table schema (sinon la 1ère mesure inclut ~5ms de compilation SQL).
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      bayesian.ingestTransactionOutcome({
        success: true,
        timestamp: now,
        endpointHash: 'warmup',
        serviceHash: 'warmup-svc',
        operatorId: 'warmup-op',
        callerHash: 'warmup-caller',
        targetHash: 'warmup',
      });
    }

    // Mesure — N outcomes avec variance sur les clés pour ne pas toucher
    // toujours la même ligne (simule la charge réelle multi-endpoints).
    const startNs = process.hrtime.bigint();
    for (let i = 0; i < options.updateCount; i++) {
      const bucket = i % 100; // 100 endpoints distincts
      bayesian.ingestTransactionOutcome({
        success: i % 7 !== 0, // ~85% success
        timestamp: now - (i % 604800), // dispersion sur 7j
        endpointHash: `endpoint-${bucket}`,
        serviceHash: `service-${bucket % 10}`,
        operatorId: `operator-${bucket % 20}`,
        callerHash: `caller-${i % 50}`,
        targetHash: `endpoint-${bucket}`,
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
    db.close();
  }
}

// --- CLI entry point ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  const updateCount = Number(process.env.BENCHMARK_UPDATE_COUNT ?? '1000');
  const budgetMs = Number(process.env.BENCHMARK_BUDGET_MS ?? '5000');

  try {
    const result = runBenchmark({ updateCount, budgetMs });
    const perUpdateMs = (result.elapsedMs / result.updateCount).toFixed(3);
    const line =
      `${result.updateCount} updates in ${result.elapsedMs.toFixed(1)}ms ` +
      `(${perUpdateMs}ms/update, ${Math.round(result.updatesPerSec)}/s, budget=${result.budgetMs}ms)`;
    if (result.pass) {
      process.stdout.write(`[PASS] ${line}\n`);
      process.exit(0);
    } else {
      process.stdout.write(`[FAIL] ${line}\n`);
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ERROR] ${msg}\n`);
    process.exit(2);
  }
}
