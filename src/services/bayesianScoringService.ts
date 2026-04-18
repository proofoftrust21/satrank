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
//   4. weightForSource(source, tier) → poids multiplicatif par observation
//      probe=1.0, paid=2.0, report selon tier (low/medium/high/NIP-98=0.3/0.5/0.7/1.0)
//   5. computePerSourcePosteriors(prior, observations) → { probe, report, paid }
//      Posteriors Beta séparés par source — indispensable pour la convergence
//   6. checkConvergence(posteriors) → { converged, sources_above_threshold }
//      SAFE exige ≥ CONVERGENCE_MIN_SOURCES sources avec p ≥ CONVERGENCE_P_THRESHOLD

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
  WEIGHT_SOVEREIGN_PROBE,
  WEIGHT_PAID_PROBE,
  WEIGHT_REPORT_LOW,
  WEIGHT_REPORT_MEDIUM,
  WEIGHT_REPORT_HIGH,
  WEIGHT_REPORT_NIP98,
  CONVERGENCE_MIN_SOURCES,
  CONVERGENCE_P_THRESHOLD,
  type BayesianWindow,
  type BayesianSource,
} from '../config/bayesianConfig';
import { exponentialDecay, computePosterior, type Posterior } from '../utils/betaBinomial';

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

/** Tier de confiance du reporter pour un agent_report — pondère l'observation.
 *  Mappé depuis le reporter_badge calculé en controller (novice→low, etc.) ou
 *  forcé à 'nip98' si la requête était signée NIP-98. */
export type ReportTier = 'low' | 'medium' | 'high' | 'nip98';

/** Observation brute pondérable — unité d'entrée pour computePerSourcePosteriors. */
export interface SourceObservation {
  /** true = succès, false = échec */
  success: boolean;
  /** source du signal */
  source: BayesianSource;
  /** tier du reporter (uniquement si source='report'). Ignoré sinon. */
  tier?: ReportTier;
  /** age en secondes pour la décroissance exponentielle (0 = maintenant). */
  ageSec?: number;
  /** window pour calculer tau = windowSec / 3. Si absent, pas de décroissance. */
  window?: BayesianWindow;
}

/** Résultat par source. `null` quand aucune observation n'a été reçue. */
export interface PerSourceResult {
  probe: (Posterior & { weightTotal: number }) | null;
  report: (Posterior & { weightTotal: number }) | null;
  paid: (Posterior & { weightTotal: number }) | null;
}

/** État de convergence multi-sources — SAFE exige ≥ N sources au-dessus du seuil. */
export interface ConvergenceResult {
  converged: boolean;
  sourcesAboveThreshold: BayesianSource[];
  threshold: number;
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

  /** Poids multiplicatif d'une observation selon sa source.
   *
   *  Philosophie : un sovereign probe (preuve on-LN exécutée par SatRank)
   *  vaut 1.0 ; un paid probe (double-check économiquement coûteux) vaut
   *  2.0 ; un agent_report est pondéré par le tier du reporter (0.3 → 1.0)
   *  pour limiter le gaming par comptes novices. NIP-98 = signature Nostr
   *  authentifiée → poids plein, équivalent à un probe.
   *
   *  Le tier est requis pour source='report' ; ignoré sinon. */
  weightForSource(source: BayesianSource, tier?: ReportTier): number {
    switch (source) {
      case 'probe': return WEIGHT_SOVEREIGN_PROBE;
      case 'paid':  return WEIGHT_PAID_PROBE;
      case 'report': {
        switch (tier ?? 'low') {
          case 'nip98':  return WEIGHT_REPORT_NIP98;
          case 'high':   return WEIGHT_REPORT_HIGH;
          case 'medium': return WEIGHT_REPORT_MEDIUM;
          case 'low':    return WEIGHT_REPORT_LOW;
        }
      }
    }
  }

  /** Composition par source : partitionne les observations en 3 flux (probe,
   *  report, paid), applique le poids de source × la décroissance temporelle,
   *  puis calcule un posterior Beta par flux en partant du même prior hérité.
   *
   *  Pourquoi 3 posteriors séparés plutôt qu'un posterior global pondéré :
   *  la convergence multi-sources (SAFE exige ≥ 2 sources au-dessus du seuil)
   *  ne peut se vérifier QUE sur des posteriors distincts. Un pooling global
   *  perdrait cette information.
   *
   *  Renvoie `null` pour une source sans aucune observation — le client le
   *  traitera comme "source absente" (pas comme "source avec prior pur"). */
  computePerSourcePosteriors(
    prior: { alpha: number; beta: number },
    observations: readonly SourceObservation[],
  ): PerSourceResult {
    const accumulators: Record<BayesianSource, { wSuccess: number; wFailure: number; wTotal: number; count: number }> = {
      probe:  { wSuccess: 0, wFailure: 0, wTotal: 0, count: 0 },
      report: { wSuccess: 0, wFailure: 0, wTotal: 0, count: 0 },
      paid:   { wSuccess: 0, wFailure: 0, wTotal: 0, count: 0 },
    };

    for (const obs of observations) {
      const sourceWeight = this.weightForSource(obs.source, obs.tier);
      const decayWeight = (obs.ageSec !== undefined && obs.window !== undefined)
        ? this.applyTemporalDecay(obs.ageSec, obs.window)
        : 1;
      const effectiveWeight = sourceWeight * decayWeight;

      const acc = accumulators[obs.source];
      if (obs.success) acc.wSuccess += effectiveWeight;
      else acc.wFailure += effectiveWeight;
      acc.wTotal += effectiveWeight;
      acc.count += 1;
    }

    const build = (acc: { wSuccess: number; wFailure: number; wTotal: number; count: number }) => {
      if (acc.count === 0) return null;
      const post = computePosterior(prior.alpha, prior.beta, acc.wSuccess, acc.wFailure);
      return { ...post, weightTotal: acc.wTotal };
    };

    return {
      probe:  build(accumulators.probe),
      report: build(accumulators.report),
      paid:   build(accumulators.paid),
    };
  }

  /** Vérifie la convergence multi-sources.
   *
   *  Définition : une source "converge" si son posterior a p_success ≥
   *  CONVERGENCE_P_THRESHOLD. SAFE n'est autorisé que si ≥ CONVERGENCE_MIN_SOURCES
   *  sources convergent indépendamment — garde-fou contre le gaming mono-source
   *  (un opérateur qui ne fait que des self-reports positifs n'atteindra jamais
   *  la convergence car aucun probe ne sera d'accord). */
  checkConvergence(perSource: PerSourceResult): ConvergenceResult {
    const aboveThreshold: BayesianSource[] = [];
    for (const source of ['probe', 'report', 'paid'] as const) {
      const post = perSource[source];
      if (post && post.pSuccess >= CONVERGENCE_P_THRESHOLD) aboveThreshold.push(source);
    }
    return {
      converged: aboveThreshold.length >= CONVERGENCE_MIN_SOURCES,
      sourcesAboveThreshold: aboveThreshold,
      threshold: CONVERGENCE_P_THRESHOLD,
    };
  }
}
