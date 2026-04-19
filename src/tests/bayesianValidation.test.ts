// Tests de validation du moteur bayésien — C11.
// Exécute les scripts de comparaison et de benchmark, et vérifie que les deux
// seuils critiques sont tenus :
//   - Kendall τ ≥ 0.90 (accuracy du ranking)
//   - 1000 ingestStreaming < 5000 ms (chemin chaud)

import { describe, it, expect } from 'vitest';
import { runComparison } from '../scripts/compareLegacyVsBayesian';
import { runBenchmark } from '../scripts/benchmarkBayesian';

describe('Bayesian validation — Kendall τ', () => {
  it('atteint τ ≥ 0.90 sur 60 agents × 80 probes (seuil Phase 3)', () => {
    const result = runComparison({
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

  it('reproductibilité : même seed → même τ à la 4e décimale', () => {
    const r1 = runComparison({ sampleSize: 30, txPerAgent: 25, threshold: 0.8, seed: 7 });
    const r2 = runComparison({ sampleSize: 30, txPerAgent: 25, threshold: 0.8, seed: 7 });
    expect(r1.tau).toBeCloseTo(r2.tau, 4);
  });
});

describe('Bayesian benchmark — ingestion throughput', () => {
  it('1000 updates < 5000 ms (seuil Phase 3)', () => {
    const result = runBenchmark({ updateCount: 1000, budgetMs: 5000 });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.pass).toBe(true);
    expect(result.updatesPerSec).toBeGreaterThan(200); // > 200 updates/s en baseline
  });

  it('respecte le budget même sur échantillon réduit (100 updates / 1s)', () => {
    const result = runBenchmark({ updateCount: 100, budgetMs: 1000 });
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.pass).toBe(true);
  });
});
