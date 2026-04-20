// Phase 8 — C4 : décision "faut-il republier ?" pour les kinds 30382/30383/
// 30384.
//
// Les events remplaçables NIP-33 coûtent aux relais : un event par entité,
// écrasé à chaque republish. Publier à chaque micro-variation de p_success
// (routing probes, décroissance exponentielle τ=7j) génère du trafic stérile.
//
// Seuils de significativité validés dans le brief Phase 8 — republish ssi
// AU MOINS UN est vrai :
//   1. verdict change (SAFE / RISKY / UNKNOWN / INSUFFICIENT)
//   2. advisory_level change de palier (green / yellow / orange / red)
//   3. |Δ p_success| ≥ 0.05 (absolu)
//   4. n_obs_effective a cru d'au moins 20 % par rapport au précédent
//
// Si previous == null (pas encore publié) → true, reason='first_publish'.
import type { Verdict, AdvisoryLevel } from '../types/index';

/** Snapshot minimal nécessaire à la décision. Les 4 champs couvrent chacun
 *  un critère de significativité distinct — ajouter un critère demande
 *  d'ajouter un champ. */
export interface EndorsementSnapshot {
  verdict: Verdict;
  advisory_level: AdvisoryLevel;
  p_success: number;
  n_obs_effective: number;
}

export interface RepublishDecision {
  shouldRepublish: boolean;
  reason: RepublishReason;
  details: {
    verdict_changed: boolean;
    advisory_changed: boolean;
    p_success_delta: number;
    n_obs_growth_pct: number | null;
  };
}

export type RepublishReason =
  | 'first_publish'
  | 'verdict_change'
  | 'advisory_change'
  | 'p_success_shift'
  | 'n_obs_growth'
  | 'no_significant_change';

export const P_SUCCESS_DELTA_THRESHOLD = 0.05;
export const N_OBS_GROWTH_THRESHOLD = 0.20; // 20 %

export function shouldRepublish(
  previous: EndorsementSnapshot | null,
  current: EndorsementSnapshot,
): RepublishDecision {
  if (previous == null) {
    return {
      shouldRepublish: true,
      reason: 'first_publish',
      details: {
        verdict_changed: true,
        advisory_changed: true,
        p_success_delta: current.p_success,
        n_obs_growth_pct: null,
      },
    };
  }

  const verdictChanged = previous.verdict !== current.verdict;
  const advisoryChanged = previous.advisory_level !== current.advisory_level;
  const pDelta = Math.abs(current.p_success - previous.p_success);
  const pDeltaSignificant = pDelta >= P_SUCCESS_DELTA_THRESHOLD;

  // Croissance relative : si previous.n_obs = 0 et current > 0, on traite
  // comme une croissance "infinie" → republish. On renvoie Infinity comme
  // growth_pct pour que le log soit lisible ; côté consommateur la seule
  // décision utile est le bool "au-dessus du seuil".
  let nObsGrowth: number | null = null;
  let nObsGrowthSignificant = false;
  if (previous.n_obs_effective <= 0) {
    if (current.n_obs_effective > 0) {
      nObsGrowth = Number.POSITIVE_INFINITY;
      nObsGrowthSignificant = true;
    } else {
      nObsGrowth = 0;
    }
  } else {
    nObsGrowth = (current.n_obs_effective - previous.n_obs_effective) / previous.n_obs_effective;
    nObsGrowthSignificant = nObsGrowth >= N_OBS_GROWTH_THRESHOLD;
  }

  // Ordre des raisons : verdict > advisory > p_success > n_obs. Plus la raison
  // est "qualitative" (verdict / advisory), plus elle est importante pour le
  // consommateur — donc remonte en premier dans les logs.
  let reason: RepublishReason = 'no_significant_change';
  let should = false;
  if (verdictChanged) { reason = 'verdict_change'; should = true; }
  else if (advisoryChanged) { reason = 'advisory_change'; should = true; }
  else if (pDeltaSignificant) { reason = 'p_success_shift'; should = true; }
  else if (nObsGrowthSignificant) { reason = 'n_obs_growth'; should = true; }

  return {
    shouldRepublish: should,
    reason,
    details: {
      verdict_changed: verdictChanged,
      advisory_changed: advisoryChanged,
      p_success_delta: pDelta,
      n_obs_growth_pct: nObsGrowth,
    },
  };
}
