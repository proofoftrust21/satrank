// Phase 5.15 — calibration service. LE MOAT : compute predicted-vs-observed
// par endpoint+stage sur une fenêtre temporelle, agrège global, retourne le
// résultat. Pas d'I/O Nostr ici — calibrationPublisher s'en charge.
//
// Calibration : pour chaque (endpoint, stage) avec >= minObs outcomes dans
// la fenêtre [windowStart, windowEnd) :
//   p_observed = sum(success * weight) / sum(weight) sur les outcomes fenêtre
//   p_predicted = posterior reconstruit à windowStart via les outcomes
//                 antérieurs (history) + prior Beta(1.5, 1.5), avec décroissance
//                 τ=7d appliquée vers windowStart.
//   delta = |p_predicted - p_observed|
//
// Aggregation cross-endpoint : delta_mean / delta_median / delta_p95.
//
// Cas spéciaux :
//   - Premier run (pas d'history) : p_predicted = prior 0.5, delta = |0.5 - p_observed|
//   - Endpoint avec history vide : skipped (pas comparable)
//   - Aucun endpoint qualifié dans la fenêtre : retour avec n_endpoints=0
//     (la cron publie quand même le kind 30783 pour démarrer l'historique).
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_SECONDS,
} from '../config/bayesianConfig';
import type { CalibrationRepository } from '../repositories/calibrationRepository';

export const DEFAULT_CALIBRATION_WINDOW_DAYS = 7;
export const DEFAULT_CALIBRATION_MIN_OBS = 10;

export interface PerEndpointCalibration {
  endpoint_url_hash: string;
  stage: number;
  n_obs: number;
  p_predicted: number;
  p_observed: number;
  delta: number;
}

export interface CalibrationResult {
  window_start: number;
  window_end: number;
  delta_mean: number | null;
  delta_median: number | null;
  delta_p95: number | null;
  n_endpoints: number;
  n_outcomes: number;
  /** Détail per-endpoint, exposé pour debug/audit. Pas re-publié sur Nostr
   *  par défaut (le content du kind 30783 contient la version aggregée
   *  uniquement, pour rester sous la limite de taille des relais). */
  per_endpoint: PerEndpointCalibration[];
}

export interface CalibrationServiceOptions {
  windowDays?: number;
  minObs?: number;
}

export class CalibrationService {
  constructor(private readonly repo: CalibrationRepository) {}

  /** Compute la calibration pour la fenêtre [now - windowDays, now). */
  async computeCalibration(
    nowSec: number,
    options: CalibrationServiceOptions = {},
  ): Promise<CalibrationResult> {
    const windowDays = options.windowDays ?? DEFAULT_CALIBRATION_WINDOW_DAYS;
    const minObs = options.minObs ?? DEFAULT_CALIBRATION_MIN_OBS;
    const windowStart = nowSec - windowDays * 86400;
    const windowEnd = nowSec;

    // Step 1 — outcomes observés dans la fenêtre, par endpoint+stage.
    const observedAggregates = await this.repo.findOutcomesInWindow(
      windowStart,
      windowEnd,
      minObs,
    );

    if (observedAggregates.length === 0) {
      return {
        window_start: windowStart,
        window_end: windowEnd,
        delta_mean: null,
        delta_median: null,
        delta_p95: null,
        n_endpoints: 0,
        n_outcomes: 0,
        per_endpoint: [],
      };
    }

    // Step 2 — history des mêmes (endpoint, stage) avant la fenêtre, pour
    // reconstruire p_predicted à windowStart.
    const historyAggregates = await this.repo.findHistoryBeforeWindow(
      observedAggregates.map((a) => ({
        endpoint_url_hash: a.endpoint_url_hash,
        stage: a.stage,
      })),
      windowStart,
    );

    // Index history par (hash, stage) pour lookup en O(1).
    const historyMap = new Map<string, (typeof historyAggregates)[number]>();
    for (const h of historyAggregates) {
      historyMap.set(`${h.endpoint_url_hash}:${h.stage}`, h);
    }

    // Step 3 — calcul par endpoint+stage.
    const perEndpoint: PerEndpointCalibration[] = [];
    for (const obs of observedAggregates) {
      const key = `${obs.endpoint_url_hash}:${obs.stage}`;
      const history = historyMap.get(key) ?? null;

      const pObserved =
        obs.weighted_total > 0
          ? obs.weighted_successes / obs.weighted_total
          : 0;

      // Reconstruction posterior à windowStart : prior + history décroissé.
      const pPredicted = predictPosteriorAt(history, windowStart);

      const delta = Math.abs(pPredicted - pObserved);

      perEndpoint.push({
        endpoint_url_hash: obs.endpoint_url_hash,
        stage: obs.stage,
        n_obs: obs.n_obs,
        p_predicted: pPredicted,
        p_observed: pObserved,
        delta,
      });
    }

    // Step 4 — aggregation cross-endpoint.
    const deltas = perEndpoint.map((e) => e.delta).sort((a, b) => a - b);
    const totalOutcomes = perEndpoint.reduce((s, e) => s + e.n_obs, 0);
    return {
      window_start: windowStart,
      window_end: windowEnd,
      delta_mean: mean(deltas),
      delta_median: percentile(deltas, 0.5),
      delta_p95: percentile(deltas, 0.95),
      n_endpoints: perEndpoint.length,
      n_outcomes: totalOutcomes,
      per_endpoint: perEndpoint,
    };
  }
}

/** Posterior at `targetTime` reconstructed from history outcomes + flat prior.
 *  Décroissance exponentielle vers le prior avec τ = TAU_SECONDS. Si
 *  history est null/0 outcomes, retourne 0.5 (prior pur). */
function predictPosteriorAt(
  history: { weighted_successes: number; weighted_total: number; mean_observed_at: number | null } | null,
  targetTime: number,
): number {
  if (!history || history.weighted_total === 0 || history.mean_observed_at == null) {
    return 0.5; // prior Beta(1.5, 1.5) ⇒ mean = 0.5
  }
  // Décroissance pondérée par âge moyen des observations.
  const dt = Math.max(0, targetTime - history.mean_observed_at);
  const decay = Math.exp(-dt / TAU_SECONDS);
  const weightedSuccesses = history.weighted_successes * decay;
  const weightedFailures = (history.weighted_total - history.weighted_successes) * decay;
  const alpha = DEFAULT_PRIOR_ALPHA + weightedSuccesses;
  const beta = DEFAULT_PRIOR_BETA + weightedFailures;
  return alpha / (alpha + beta);
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function percentile(sortedXs: number[], p: number): number | null {
  if (sortedXs.length === 0) return null;
  const idx = Math.min(sortedXs.length - 1, Math.floor(sortedXs.length * p));
  return sortedXs[idx];
}
