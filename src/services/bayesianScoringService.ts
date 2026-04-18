// Bayesian scoring service — cœur du pipeline Phase 3.
//
// Structure des calculs :
//   1. resolveHierarchicalPrior(target) → (α₀, β₀)
//      Cascade : operator → service → flat(1.5, 1.5). Category non implémentée
//      en C5 (future extension — nécessiterait une table category_aggregates
//      ou un agrégat virtuel group by service.category).
//   2. selectWindow(nObsByWindow) → BayesianWindow
//      Plus courte fenêtre avec n_obs ≥ MIN_N_OBS_FOR_WINDOW (20). Fallback 30d.
//   3. applyTemporalDecay(ageSec, windowSec) → poids ∈ [0, 1]
//      τ = windowSec × DECAY_TAU_FRACTION (1/3). Wrapping de l'util exponentialDecay.
//
// Les étapes 4-6 (source-aware weighting, convergence, verdict mapping)
// viennent en C6 et C7. Ce commit expose le squelette minimal et les
// dépendances d'injection.

import type {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  SimpleAggregate,
} from '../repositories/aggregatesRepository';
import {
  BAYESIAN_WINDOWS,
  MIN_N_OBS_FOR_WINDOW,
  WINDOW_SECONDS,
  MIN_N_OBS_FOR_PRIOR_INHERITANCE,
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  DECAY_TAU_FRACTION,
  type BayesianWindow,
} from '../config/bayesianConfig';
import { exponentialDecay } from '../utils/betaBinomial';

export interface PriorContext {
  /** operator_id (hash pubkey opérateur) si connu — couche la plus fine non-locale. */
  operatorId?: string | null;
  /** service_hash (hash URL service parent) si connu. */
  serviceHash?: string | null;
}

export interface ResolvedPrior {
  alpha: number;
  beta: number;
  /** Nom de la couche d'où le prior a été hérité : 'operator' | 'service' | 'flat'. Pratique pour diagnostic/logs. */
  source: 'operator' | 'service' | 'flat';
}

export class BayesianScoringService {
  constructor(
    private endpointRepo: EndpointAggregateRepository,
    private serviceRepo: ServiceAggregateRepository,
    private operatorRepo: OperatorAggregateRepository,
    private nodeRepo: NodeAggregateRepository,
  ) {}

  /** Résout le prior hiérarchique pour une cible donnée.
   *
   *  Cascade : operator (n≥30) → service (n≥30) → flat(1.5, 1.5).
   *  Le posterior du parent devient le prior de l'enfant. MIN_N_OBS_FOR_PRIOR_INHERITANCE
   *  évite d'hériter d'un parent trop peu observé. */
  resolveHierarchicalPrior(ctx: PriorContext, window: BayesianWindow): ResolvedPrior {
    // Niveau 1 : operator (le plus fin, si disponible)
    if (ctx.operatorId) {
      const operator = this.operatorRepo.findOne(ctx.operatorId, window);
      if (operator && operator.nObs >= MIN_N_OBS_FOR_PRIOR_INHERITANCE) {
        return { alpha: operator.posteriorAlpha, beta: operator.posteriorBeta, source: 'operator' };
      }
    }

    // Niveau 2 : service
    if (ctx.serviceHash) {
      const service = this.serviceRepo.findOne(ctx.serviceHash, window);
      if (service && service.nObs >= MIN_N_OBS_FOR_PRIOR_INHERITANCE) {
        return { alpha: service.posteriorAlpha, beta: service.posteriorBeta, source: 'service' };
      }
    }

    // Niveau 3 : flat (fallback final).
    return { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA, source: 'flat' };
  }

  /** Sélectionne la plus courte fenêtre avec n_obs ≥ seuil (20 par défaut).
   *
   *  Principe : réagir vite si on a des données fraîches, se rabattre sur
   *  plus long sinon. Si aucune fenêtre n'atteint le seuil, retourne la
   *  plus large (30d) pour maximiser les données disponibles même si
   *  l'IC est large. */
  selectWindow(nObsByWindow: Record<BayesianWindow, number>): BayesianWindow {
    for (const w of BAYESIAN_WINDOWS) {
      if ((nObsByWindow[w] ?? 0) >= MIN_N_OBS_FOR_WINDOW) return w;
    }
    return '30d';
  }

  /** Variant qui interroge les aggregates pour un endpoint donné et retourne la fenêtre sélectionnée. */
  selectEndpointWindow(urlHash: string): BayesianWindow {
    const counts: Record<BayesianWindow, number> = { '24h': 0, '7d': 0, '30d': 0 };
    for (const w of BAYESIAN_WINDOWS) {
      counts[w] = this.endpointRepo.findOne(urlHash, w)?.nObs ?? 0;
    }
    return this.selectWindow(counts);
  }

  /** Décroissance exponentielle appliquée à une observation.
   *
   *  τ = windowSec × DECAY_TAU_FRACTION (1/3). Une observation à t=τ pèse
   *  e⁻¹ ≈ 0.368 ; à t=windowSec pèse ≈ 0.050. Garantit que la fin de
   *  fenêtre ne contribue quasi plus rien — cohérent avec l'horizon.
   *
   *  Les compteurs raw dans les aggregates ne sont PAS décroissants (Option A) :
   *  la décroissance est appliquée à la lecture en rejouant les observations
   *  depuis `transactions`. Voir computeDecayedPosterior() ci-dessous. */
  applyTemporalDecay(ageSec: number, window: BayesianWindow): number {
    const windowSec = WINDOW_SECONDS[window];
    const tauSec = windowSec * DECAY_TAU_FRACTION;
    return exponentialDecay(ageSec, tauSec);
  }

  /** Durée de la fenêtre en secondes. */
  windowSeconds(window: BayesianWindow): number {
    return WINDOW_SECONDS[window];
  }

  /** Utilitaire : tau pour une fenêtre (fraction DECAY_TAU_FRACTION). */
  windowTau(window: BayesianWindow): number {
    return WINDOW_SECONDS[window] * DECAY_TAU_FRACTION;
  }

  /** Expose simpleAggregate → posterior (en réutilisant l'α/β stocké).
   *  Utilisé par C6 pour composer les posteriors par source. */
  aggregateToPosterior(agg: SimpleAggregate | undefined): { alpha: number; beta: number; nObs: number } {
    if (!agg) return { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA, nObs: 0 };
    return { alpha: agg.posteriorAlpha, beta: agg.posteriorBeta, nObs: agg.nObs };
  }
}
