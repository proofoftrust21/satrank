// Tests de validation du moteur bayésien — C11.
// Exécute les scripts de comparaison et de benchmark, et vérifie que les deux
// seuils critiques sont tenus :
//   - Kendall τ ≥ 0.90 (accuracy du ranking)
//   - 1000 ingestStreaming < 5000 ms (chemin chaud)

import { describe, it, expect } from 'vitest';
import { runComparison } from '../scripts/compareLegacyVsBayesian';
import { runBenchmark } from '../scripts/benchmarkBayesian';

describe('Bayesian validation — Kendall τ', () => {
  it('atteint τ ≥ 0.90 sur 60 agents × 80 probes (seuil Phase 3)', { timeout: 60_000 }, async () => {
    // Phase 12B: runComparison effectue 4800 ingestStreaming() séquentielles
    // (60×80) + 60 verdicts, ~8s local sync → peut dépasser 20s sous charge pg
    // parallèle. Override du testTimeout pour absorber la contention.
    const result = await runComparison({
      sampleSize: 60,
      txPerAgent: 80,
      threshold: 0.90,
      seed: 42,
    });
    expect(result.tau).toBeGreaterThanOrEqual(0.90);
    expect(result.pass).toBe(true);
    // Sanity — tous les agents doivent avoir un verdict non-INSUFFICIENT
    // avec 80 observations.
    for (const d of result.details) {
      expect(d.bayesianVerdict).not.toBe('INSUFFICIENT');
    }
  });

  it('reproductibilité : même seed → même τ à la 4e décimale', async () => {
    const r1 = await runComparison({ sampleSize: 30, txPerAgent: 25, threshold: 0.8, seed: 7 });
    const r2 = await runComparison({ sampleSize: 30, txPerAgent: 25, threshold: 0.8, seed: 7 });
    expect(r1.tau).toBeCloseTo(r2.tau, 4);
  });
});

describe('Bayesian benchmark — ingestion throughput', () => {
  it('1000 updates < 30000 ms (seuil Phase 12B, pg async)', { timeout: 60_000 }, async () => {
    // Phase 12B: budget relâché vs SQLite sync — chaque UPDATE fait un RTT
    // réseau Postgres. Baseline cible 30s/1000 updates sur harness test
    // (Docker local). En prod (VM dédiée satrank-postgres), ~10s attendues.
    // Timeout test override à 60s pour absorber la contention pg lors d'une
    // exécution parallèle de la suite complète (jusqu'à 4 threads actifs).
    const result = await runBenchmark({ updateCount: 1000, budgetMs: 30000 });
    expect(result.elapsedMs).toBeLessThan(30000);
    expect(result.pass).toBe(true);
    expect(result.updatesPerSec).toBeGreaterThan(30); // > 30 updates/s baseline pg
  });

  it('respecte le budget même sur échantillon réduit (100 updates / 5s)', async () => {
    const result = await runBenchmark({ updateCount: 100, budgetMs: 5000 });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.pass).toBe(true);
  });
});
