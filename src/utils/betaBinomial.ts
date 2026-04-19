// Beta-Binomial posterior utilities — cœur mathématique du scoring bayésien.
// Pas de dépendance externe : on implémente les fonctions nécessaires (betaPPF
// via normale pour n≥30, bisection sinon) en évitant toute lib stats lourde.

import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
} from '../config/bayesianConfig';

export interface Posterior {
  /** α du posterior Beta — prior α₀ + somme des poids de succès */
  alpha: number;
  /** β du posterior Beta — prior β₀ + somme des poids d'échec */
  beta: number;
  /** p_success = α / (α + β) — espérance du posterior */
  pSuccess: number;
  /** Borne basse de l'intervalle de crédibilité à 95% */
  ci95Low: number;
  /** Borne haute de l'intervalle de crédibilité à 95% */
  ci95High: number;
  /** Nombre d'observations effectives (successes + failures, pondérées ou non) */
  nObs: number;
}

/** Calcule le posterior Beta(α, β) = Beta(α₀ + successes, β₀ + failures) et l'IC95%.
 *  `priorA` / `priorB` permettent d'injecter un prior hiérarchique (operator → service →
 *  category → flat). Les successes/failures peuvent être pondérés (réels, pas entiers). */
export function computePosterior(
  priorA: number,
  priorB: number,
  weightedSuccesses: number,
  weightedFailures: number,
): Posterior {
  const alpha = priorA + weightedSuccesses;
  const beta = priorB + weightedFailures;
  const nObs = weightedSuccesses + weightedFailures;
  const pSuccess = alpha / (alpha + beta);
  const ci95Low = betaPPF(alpha, beta, 0.025);
  const ci95High = betaPPF(alpha, beta, 0.975);
  return { alpha, beta, pSuccess, ci95Low, ci95High, nObs };
}

/** Posterior avec prior par défaut flat(1.5, 1.5). Pratique pour les tests
 *  et les cas sans chaîne hiérarchique disponible. */
export function computeFlatPosterior(
  weightedSuccesses: number,
  weightedFailures: number,
): Posterior {
  return computePosterior(DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, weightedSuccesses, weightedFailures);
}

/** Inverse CDF (quantile function) de la distribution Beta(α, β) évaluée en p ∈ (0, 1).
 *  Deux régimes :
 *    - n = α + β ≥ 30 : approximation normale via la moyenne μ = α/(α+β) et la
 *      variance σ² = αβ / [(α+β)²(α+β+1)]. Rapide et suffisamment précise pour
 *      le domaine d'usage (ci95).
 *    - n < 30 : bisection numérique sur incompleteBeta(x; α, β), tolérance 1e-6,
 *      plafond 100 itérations (toujours atteint en < 40 en pratique).
 *  Retourne une valeur dans [0, 1]. */
export function betaPPF(alpha: number, beta: number, p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p <= 0) return 0;
    return 1;
  }
  if (alpha <= 0 || beta <= 0) {
    throw new Error(`betaPPF: alpha and beta must be positive, got (${alpha}, ${beta})`);
  }

  const n = alpha + beta;

  // Régime 1 : approximation normale (n ≥ 30).
  if (n >= 30) {
    const mean = alpha / n;
    const variance = (alpha * beta) / (n * n * (n + 1));
    const sd = Math.sqrt(variance);
    const z = normalPPF(p);
    const raw = mean + z * sd;
    return Math.max(0, Math.min(1, raw));
  }

  // Régime 2 : bisection sur la CDF Beta (regularized incomplete beta).
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    const cdf = betaCDF(mid, alpha, beta);
    if (Math.abs(cdf - p) < 1e-6 || hi - lo < 1e-8) return mid;
    if (cdf < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** CDF Beta régularisée I_x(α, β) via fraction continue de Lentz — algorithme classique
 *  (Numerical Recipes §6.4). Stable pour α, β positifs. */
export function betaCDF(x: number, alpha: number, beta: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Facteur préliminaire : B(α, β) × x^α × (1-x)^β / (α·B(α, β))
  const logBeta = logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
  const front = Math.exp(Math.log(x) * alpha + Math.log(1 - x) * beta - logBeta) / alpha;

  const cf = betaContinuedFraction(x, alpha, beta);

  // Symétrie : si x > (α+1)/(α+β+2), utiliser 1 − I_{1-x}(β, α) pour la stabilité.
  if (x < (alpha + 1) / (alpha + beta + 2)) {
    return front * cf;
  }
  const logBetaSwap = logGamma(beta) + logGamma(alpha) - logGamma(alpha + beta);
  const frontSwap = Math.exp(Math.log(1 - x) * beta + Math.log(x) * alpha - logBetaSwap) / beta;
  return 1 - frontSwap * betaContinuedFraction(1 - x, beta, alpha);
}

/** Fraction continue pour I_x(α, β) — converge en < 100 itérations pour les paramètres
 *  du domaine (α, β typiquement 1-1000). */
function betaContinuedFraction(x: number, alpha: number, beta: number): number {
  const MAX_ITER = 200;
  const EPS = 1e-12;
  const qab = alpha + beta;
  const qap = alpha + 1;
  const qam = alpha - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < EPS) d = EPS;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (beta - m) * x) / ((qam + m2) * (alpha + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < EPS) d = EPS;
    c = 1 + aa / c;
    if (Math.abs(c) < EPS) c = EPS;
    d = 1 / d;
    h *= d * c;
    aa = (-(alpha + m) * (qab + m) * x) / ((alpha + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < EPS) d = EPS;
    c = 1 + aa / c;
    if (Math.abs(c) < EPS) c = EPS;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** log Γ(z) via l'approximation de Stirling-Lanczos (coefficients g=7). */
export function logGamma(z: number): number {
  const g = 7;
  const coeffs = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = coeffs[0];
  const t = x + g + 0.5;
  for (let i = 1; i < coeffs.length; i++) a += coeffs[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Inverse CDF de la loi normale standard — approximation Beasley-Springer-Moro.
 *  Précision < 1e-7 sur (0, 1). */
export function normalPPF(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new Error(`normalPPF: p must be in (0, 1), got ${p}`);
  }
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2, 1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2, 6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Décroissance exponentielle : weight = exp(-ageSec / tauSec).
 *  À t = 0 → 1. À t = τ → e⁻¹ ≈ 0.368. À t = 3τ → ≈ 0.050. */
export function exponentialDecay(ageSec: number, tauSec: number): number {
  if (ageSec < 0) return 1; // futur théorique = poids plein
  if (tauSec <= 0) return ageSec === 0 ? 1 : 0;
  return Math.exp(-ageSec / tauSec);
}
