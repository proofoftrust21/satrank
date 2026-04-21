// Calibration empirique des seuils RiskService sur deltas de p_success (Phase 3 C8).
//
// Pourquoi ce script existe
// -------------------------
// L'ancien RiskService déclenchait `suspicious_rapid_rise` / `declining_node` /
// `growing_node` sur des deltas 7j de score composite 0-100 (seuils +20, -10, +10).
// Phase 3 remplace le composite par p_success 0-1. Diviser les seuils par 100
// est faux : la distribution du posterior bayésien n'est pas linéairement
// isomorphe au composite. Beaucoup d'endpoints vivent dans la zone étroite
// [0.75, 0.95] où un move de +0.02 est déjà significatif — là où en composite
// un +2 était du bruit. Un seuil naïf de +0.20 ne toucherait personne ;
// un seuil de +0.10 toucherait 80% de la population.
//
// Méthode
// -------
// 1. Charger les deltas 7j depuis le DB prod (path via $DB_PATH) OU un dataset
//    synthétique mixture-model (réaliste mais déterministe, pour la CI).
// 2. Calculer percentiles (p50/p75/p90/p95/p97/p99) des deltas positifs et
//    négatifs séparément.
// 3. Déduire les seuils pour que chaque profil déclenche sur une fraction
//    similaire à l'ancien composite (cf. POPULATION_TARGETS).
// 4. Vérifier que les seuils proposés ne sont ni trop stricts (0 match) ni
//    trop laxistes (>20% match).
//
// Usage
// -----
//   npx tsx src/scripts/analyzeDeltaDistribution.ts                      # dataset synthétique
//   USE_DB=1 npx tsx src/scripts/analyzeDeltaDistribution.ts             # charge depuis $DATABASE_URL
//
// Exit codes :
//   0 → seuils dans les plages cibles
//   1 → distribution trop plate pour calibrer (documenter profil à retirer)
//   2 → erreur setup / DB absent

import { Pool } from 'pg';
import { getPool, closePools } from '../database/connection';

interface DeltaObservation {
  currentP: number;
  pastP: number;
  delta7d: number;
  ageDaysAtCurrent: number;
}

interface Percentiles {
  p50: number;
  p75: number;
  p85: number;
  p90: number;
  p93: number;
  p95: number;
  p97: number;
  p99: number;
}

/** Cibles de population (% d'agents qui doivent déclencher chaque profil).
 *  Calibrées sur les seuils composite v30 observés en prod :
 *    - suspicious_rapid_rise : +20 composite sur 7j + ageDays<60 → ~2-3%
 *    - declining_node        : -10 composite sur 7j + trend=falling → ~4-6%
 *    - growing_node          : +10 composite sur 7j + ageDays<180 → ~5-8%
 *  Les cibles ci-dessous sont inclusives des filtres d'âge — le script ne
 *  modélise pas l'âge donc on rapporte juste la fraction delta-qualified. */
const POPULATION_TARGETS = {
  suspicious_rapid_rise: { minPct: 1.0, maxPct: 5.0, targetPct: 2.5 },
  declining_node:        { minPct: 2.0, maxPct: 8.0, targetPct: 5.0 },
  growing_node:          { minPct: 3.0, maxPct: 12.0, targetPct: 7.0 },
};

/** RNG déterministe (mulberry32) pour reproductibilité CI. */
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

/** Génère un dataset synthétique représentatif des distributions observées en prod.
 *  Mélange de 5 régimes :
 *    - 60% stables          : p=0.75±0.10, delta=N(0, 0.015)  (walk brownien lent)
 *    - 15% déclinants       : p=0.60±0.15, drift -0.05 à -0.15 sur 7j
 *    - 15% croissance       : p=0.70±0.10, drift +0.03 à +0.10 sur 7j
 *    - 5%  rapid_rise       : jeune, saut brutal +0.15 à +0.30
 *    - 5%  hubs établis     : p≥0.90, delta ~0 */
function generateSyntheticDeltas(rng: () => number, n: number): DeltaObservation[] {
  const observations: DeltaObservation[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    let pastP: number, currentP: number, ageDays: number;

    if (r < 0.60) {
      // Stables
      pastP = clamp01(0.65 + rng() * 0.20);
      const delta = gaussian(rng) * 0.015;
      currentP = clamp01(pastP + delta);
      ageDays = 100 + rng() * 900;
    } else if (r < 0.75) {
      // Déclinants
      pastP = clamp01(0.50 + rng() * 0.30);
      const delta = -(0.05 + rng() * 0.10);
      currentP = clamp01(pastP + delta);
      ageDays = 200 + rng() * 800;
    } else if (r < 0.90) {
      // Croissance régulière
      pastP = clamp01(0.55 + rng() * 0.25);
      const delta = 0.03 + rng() * 0.07;
      currentP = clamp01(pastP + delta);
      ageDays = 30 + rng() * 150;
    } else if (r < 0.95) {
      // Rapid rise (jeune + saut brutal)
      pastP = clamp01(0.40 + rng() * 0.30);
      const delta = 0.15 + rng() * 0.15;
      currentP = clamp01(pastP + delta);
      ageDays = 10 + rng() * 50;
    } else {
      // Hubs établis stables
      pastP = clamp01(0.88 + rng() * 0.08);
      const delta = gaussian(rng) * 0.005;
      currentP = clamp01(pastP + delta);
      ageDays = 1000 + rng() * 2000;
    }

    observations.push({
      currentP,
      pastP,
      delta7d: currentP - pastP,
      ageDaysAtCurrent: ageDays,
    });
  }
  return observations;
}

function gaussian(rng: () => number): number {
  // Box-Muller
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Charge les deltas 7j depuis le DB prod — une ligne par agent_hash, current p_success
 *  et snapshot le plus proche de (now - 7d). Retourne seulement les paires valides. */
async function loadDeltasFromDb(pool: Pool): Promise<DeltaObservation[]> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;
  const { rows } = await pool.query<{
    agent_hash: string;
    current_p: number;
    past_p: number;
    first_seen: number;
  }>(
    `SELECT
      cur.agent_hash,
      cur.p_success AS current_p,
      prev.p_success AS past_p,
      a.first_seen
    FROM (
      SELECT s.agent_hash, s.p_success, s.computed_at,
        ROW_NUMBER() OVER (PARTITION BY s.agent_hash ORDER BY s.computed_at DESC) AS rn
      FROM score_snapshots s
      WHERE s.p_success IS NOT NULL
    ) cur
    LEFT JOIN (
      SELECT s.agent_hash, s.p_success, s.computed_at,
        ROW_NUMBER() OVER (PARTITION BY s.agent_hash ORDER BY s.computed_at DESC) AS rn
      FROM score_snapshots s
      WHERE s.p_success IS NOT NULL AND s.computed_at <= $1
    ) prev ON prev.agent_hash = cur.agent_hash AND prev.rn = 1
    LEFT JOIN agents a ON a.public_key_hash = cur.agent_hash
    WHERE cur.rn = 1 AND prev.p_success IS NOT NULL`,
    [sevenDaysAgo],
  );

  return rows.map((r) => ({
    currentP: r.current_p,
    pastP: r.past_p,
    delta7d: r.current_p - r.past_p,
    ageDaysAtCurrent: (now - r.first_seen) / 86400,
  }));
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) {
    return { p50: 0, p75: 0, p85: 0, p90: 0, p93: 0, p95: 0, p97: 0, p99: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };
  return {
    p50: pct(50),
    p75: pct(75),
    p85: pct(85),
    p90: pct(90),
    p93: pct(93),
    p95: pct(95),
    p97: pct(97),
    p99: pct(99),
  };
}

interface CalibrationResult {
  thresholds: {
    rapid_rise_delta: number;
    declining_delta: number;
    growing_delta: number;
  };
  populationPct: {
    rapid_rise: number;
    declining: number;
    growing: number;
  };
  positivePercentiles: Percentiles;
  negativePercentiles: Percentiles;
  totalObservations: number;
}

function calibrate(observations: DeltaObservation[]): CalibrationResult {
  const positives = observations.filter(o => o.delta7d > 0).map(o => o.delta7d);
  const negatives = observations.filter(o => o.delta7d < 0).map(o => Math.abs(o.delta7d));

  const posPct = percentiles(positives);
  const negPct = percentiles(negatives);

  // Seuils proposés :
  //   - rapid_rise  = p97 des deltas positifs → top 3% = ~cible 2.5%
  //   - declining   = -(p93 des |deltas négatifs|) → top 7% = ~cible 5%
  //   - growing     = p85 des deltas positifs → top 15%, moins strict
  // Arrondis à 2 décimales pour lisibilité dans le code.
  const rapidRise = round2(posPct.p97);
  const declining = -round2(negPct.p93);
  const growing = round2(posPct.p85);

  // Validation : compter combien d'agents dans le dataset déclenchent chaque seuil.
  const n = observations.length;
  const rrCount = observations.filter(o => o.delta7d > rapidRise).length;
  const dnCount = observations.filter(o => o.delta7d < declining).length;
  const gnCount = observations.filter(o => o.delta7d > growing).length;

  return {
    thresholds: {
      rapid_rise_delta: rapidRise,
      declining_delta: declining,
      growing_delta: growing,
    },
    populationPct: {
      rapid_rise: (rrCount / n) * 100,
      declining: (dnCount / n) * 100,
      growing: (gnCount / n) * 100,
    },
    positivePercentiles: posPct,
    negativePercentiles: negPct,
    totalObservations: n,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function formatTable(title: string, pct: Percentiles): string {
  return [
    `${title}:`,
    `  p50 = ${pct.p50.toFixed(4)}`,
    `  p75 = ${pct.p75.toFixed(4)}`,
    `  p85 = ${pct.p85.toFixed(4)}`,
    `  p90 = ${pct.p90.toFixed(4)}`,
    `  p93 = ${pct.p93.toFixed(4)}`,
    `  p95 = ${pct.p95.toFixed(4)}`,
    `  p97 = ${pct.p97.toFixed(4)}`,
    `  p99 = ${pct.p99.toFixed(4)}`,
  ].join('\n');
}

// --- CLI ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

async function main(): Promise<void> {
  const useDb = Boolean(process.env.USE_DB);
  const sampleSize = Number(process.env.SAMPLE_SIZE ?? '2000');
  const seed = Number(process.env.SEED ?? '42');

  let observations: DeltaObservation[];
  let source: string;
  try {
    if (useDb) {
      const pool = getPool();
      try {
        observations = await loadDeltasFromDb(pool);
      } finally {
        await closePools();
      }
      source = 'prod DB ($DATABASE_URL)';
    } else {
      const rng = makeRng(seed);
      observations = generateSyntheticDeltas(rng, sampleSize);
      source = `synthetic n=${sampleSize} seed=${seed}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ERROR] Load failed: ${msg}\n`);
    process.exit(2);
  }

  if (observations.length < 50) {
    process.stderr.write(`[FAIL] Insufficient data: ${observations.length} obs (need ≥ 50)\n`);
    process.exit(1);
  }

  const result = calibrate(observations);
  const out: string[] = [];
  out.push('=== Phase 3 C8 — Delta Distribution Analysis ===');
  out.push(`Source      : ${source}`);
  out.push(`Observations: ${result.totalObservations}`);
  out.push('');
  out.push(formatTable('Positive deltas (Δ > 0)', result.positivePercentiles));
  out.push('');
  out.push(formatTable('Negative deltas |Δ| (Δ < 0, abs)', result.negativePercentiles));
  out.push('');
  out.push('Calibrated thresholds (p_success scale 0-1):');
  out.push(`  suspicious_rapid_rise : Δ7d > +${result.thresholds.rapid_rise_delta.toFixed(2)}`);
  out.push(`  declining_node        : Δ7d < ${result.thresholds.declining_delta.toFixed(2)}`);
  out.push(`  growing_node          : Δ7d > +${result.thresholds.growing_delta.toFixed(2)}`);
  out.push('');
  out.push('Population triggered (% of total):');
  out.push(`  suspicious_rapid_rise : ${result.populationPct.rapid_rise.toFixed(2)}% (target ${POPULATION_TARGETS.suspicious_rapid_rise.minPct}-${POPULATION_TARGETS.suspicious_rapid_rise.maxPct}%)`);
  out.push(`  declining_node        : ${result.populationPct.declining.toFixed(2)}% (target ${POPULATION_TARGETS.declining_node.minPct}-${POPULATION_TARGETS.declining_node.maxPct}%)`);
  out.push(`  growing_node          : ${result.populationPct.growing.toFixed(2)}% (target ${POPULATION_TARGETS.growing_node.minPct}-${POPULATION_TARGETS.growing_node.maxPct}%)`);
  process.stdout.write(out.join('\n') + '\n');

  const checks: Array<[string, number, { minPct: number; maxPct: number }]> = [
    ['rapid_rise', result.populationPct.rapid_rise, POPULATION_TARGETS.suspicious_rapid_rise],
    ['declining',  result.populationPct.declining,  POPULATION_TARGETS.declining_node],
    ['growing',    result.populationPct.growing,    POPULATION_TARGETS.growing_node],
  ];
  const failures = checks.filter(([, pct, t]) => pct < t.minPct || pct > t.maxPct);
  if (failures.length > 0) {
    process.stdout.write('\n[FAIL] Thresholds out of target range — profiles too flat/strict on this dataset.\n');
    for (const [name, pct, t] of failures) {
      process.stdout.write(`  ${name}: ${pct.toFixed(2)}% not in [${t.minPct}, ${t.maxPct}]\n`);
    }
    process.exit(1);
  }
  process.stdout.write('\n[PASS] All thresholds in target population range.\n');
  process.exit(0);
}

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}

export { calibrate, generateSyntheticDeltas, loadDeltasFromDb, makeRng, percentiles };
export type { DeltaObservation, CalibrationResult, Percentiles };
