// Phase 5.14 — composition multi-stage du posterior end-to-end.
//
// Compose 5 Beta posteriors (un par stage du contrat L402) en un signal unique
// p_e2e = ∏ p_i pour les stages avec n_obs effectif >= IS_MEANINGFUL_MIN_N_OBS.
//
// Rationale :
//   - Multiplicatif (chain rule) parce que les stages sont conditionnels : pour
//     que la requête réussisse end-to-end, *toutes* les étapes doivent passer.
//   - Filtrage sur n_obs : un stage sans données = grosse incertitude. L'inclure
//     avec son prior Beta(1.5, 1.5) → p=0.5 pénaliserait à tort un endpoint
//     dont stage 1 (challenge) p=0.95 mais stages 2-5 sont vides. Mieux : on
//     compose seulement les stages mesurés et on annonce explicitement combien.
//   - L'API expose les 5 stages bruts ET le composé, pour que les agents
//     puissent recomposer eux-mêmes selon leur tolérance (cf. philosophie
//     `optimize=`).
import { betaPPF } from '../utils/betaBinomial';
import type { DecayedStagePosterior, Stage } from '../repositories/endpointStagePosteriorsRepository';
import { ALL_STAGES, STAGE_NAMES } from '../repositories/endpointStagePosteriorsRepository';

/** Phase 5.6 a fixé ce seuil à 3 dans intentService pour le posterior legacy.
 *  On le réutilise ici pour la cohérence : un stage avec n_obs effectif < 3
 *  est dominé par le prior et ne porte pas de signal réel. Hardcoded ici plutôt
 *  qu'importé pour découpler ce fichier de la promotion en config partagée. */
const IS_MEANINGFUL_MIN_N_OBS = 3;

/** Bloc par stage exposé dans la réponse API. Le champ `stage` est l'union
 *  exacte de noms de stages, alignée avec StagePosteriorEntry dans
 *  src/types/intent.ts pour permettre une assignation directe. */
export type StageName = 'challenge' | 'invoice' | 'payment' | 'delivery' | 'quality';

export interface StagePosteriorBlock {
  stage: StageName;
  alpha: number;
  beta: number;
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  /** True quand n_obs effectif >= IS_MEANINGFUL_MIN_N_OBS. Indique que ce
   *  stage a contribué au produit p_e2e (vs. exclus comme prior pur). */
  is_meaningful: boolean;
}

export interface ComposedPosterior {
  /** Mapping nom → bloc, pour les 5 stages présents en DB. Stages absents
   *  ne figurent pas dans la map (l'agent voit "key absent" = stage non
   *  encore mesuré, distinct de "stage mesuré avec p=0.5 incertain"). */
  stages: Record<string, StagePosteriorBlock>;
  /** Produit des p_success des stages meaningful. null si aucun stage
   *  meaningful (= rien à composer, l'agent doit se rabattre sur le posterior
   *  legacy `bayesian.p_success`). */
  p_e2e: number | null;
  /** Bornes pessimist/optimist : produit des CI95_low / produit des CI95_high.
   *  Pas un vrai IC95 du produit (qui n'est pas analytique), mais utile
   *  comme range. null quand p_e2e est null. */
  p_e2e_pessimistic: number | null;
  p_e2e_optimistic: number | null;
  /** Liste des stages dont la valeur p_success a contribué au produit. Permet
   *  à l'agent de reconnaître p_e2e=0.96 (un seul stage mesuré) vs
   *  p_e2e=0.96 (cinq stages convergeants). */
  meaningful_stages: string[];
  /** Nombre total de stages présents en DB pour cet endpoint (1-5).
   *  meaningful_stages.length <= measured_stages.length. */
  measured_stages: number;
}

/** Compose un Map<Stage, posterior> en bloc API consommable. Pure function,
 *  testable sans DB. */
export function composeStagePosteriors(
  posteriors: Map<Stage, DecayedStagePosterior>,
): ComposedPosterior {
  const stagesOut: Record<string, StagePosteriorBlock> = {};
  const meaningful: string[] = [];
  let pProduct = 1;
  let lowProduct = 1;
  let highProduct = 1;
  let included = 0;

  for (const stage of ALL_STAGES) {
    const post = posteriors.get(stage);
    if (!post) continue;
    const ci95Low = betaPPF(post.alpha, post.beta, 0.025);
    const ci95High = betaPPF(post.alpha, post.beta, 0.975);
    const isMeaningful = post.n_obs_effective >= IS_MEANINGFUL_MIN_N_OBS;
    const name = STAGE_NAMES[stage] as StageName;
    stagesOut[name] = {
      stage: name,
      alpha: post.alpha,
      beta: post.beta,
      p_success: post.p_success,
      ci95_low: ci95Low,
      ci95_high: ci95High,
      n_obs: post.n_obs_effective,
      is_meaningful: isMeaningful,
    };
    if (isMeaningful) {
      pProduct *= post.p_success;
      lowProduct *= ci95Low;
      highProduct *= ci95High;
      meaningful.push(name);
      included += 1;
    }
  }

  return {
    stages: stagesOut,
    p_e2e: included > 0 ? pProduct : null,
    p_e2e_pessimistic: included > 0 ? lowProduct : null,
    p_e2e_optimistic: included > 0 ? highProduct : null,
    meaningful_stages: meaningful,
    measured_stages: Object.keys(stagesOut).length,
  };
}
