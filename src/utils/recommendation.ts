// Calibrateur de recommandation — Phase 4 P4 extrait en util partagée pour
// permettre à /api/intent (Phase 5) de réutiliser exactement la même logique
// que /api/decide. Fonction pure, pas de side-effect.
//
// Ranks {proceed, proceed_with_caution, consider_alternative, avoid} à partir
// de la combinaison (verdict bayésien, advisory_level, critical flags, service
// health, ci95_low).
//
// Ordre de décision (premier match gagne) :
//   1. Hard veto (RISKY / red / critical flag / service down) → avoid
//   2. Orange overlay                                          → consider_alternative
//   3. SAFE + green + ci95_low ≥ 0.70                          → proceed
//   4. Sinon                                                   → proceed_with_caution
//
// Pourquoi ci95_low ≥ 0.70 pour `proceed` : la borne inférieure du CI95 est le
// pire cas p_success pour l'agent. Si même le pessimiste est ≥ 0.70, le
// posterior est assez central et resserré pour un feu vert inconditionnel.

import type { AdvisoryLevel, Recommendation, Verdict } from '../types';

export const PROCEED_CI95_LOW_THRESHOLD = 0.70;

export interface RecommendationInput {
  verdict: Verdict;
  advisoryLevel: AdvisoryLevel;
  /** `true` si l'un des flags critiques (fraud_reported, negative_reputation,
   *  dispute_reported, unreachable) est actif. */
  hasCritical: boolean;
  /** `true` si la santé HTTP du service est `down` — neutre/absent → `false`. */
  serviceDown: boolean;
  /** Borne basse du CI95 du posterior combiné. */
  ci95Low: number;
}

export function deriveRecommendation(input: RecommendationInput): Recommendation {
  if (
    input.verdict === 'RISKY'
    || input.advisoryLevel === 'red'
    || input.hasCritical
    || input.serviceDown
  ) {
    return 'avoid';
  }
  if (input.advisoryLevel === 'orange') return 'consider_alternative';
  if (
    input.verdict === 'SAFE'
    && input.advisoryLevel === 'green'
    && input.ci95Low >= PROCEED_CI95_LOW_THRESHOLD
  ) {
    return 'proceed';
  }
  return 'proceed_with_caution';
}
