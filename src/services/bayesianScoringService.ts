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
  RouteAggregateRepository,
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
  SAFE_P_THRESHOLD,
  SAFE_CI95_LOW_MIN,
  SAFE_MIN_N_OBS,
  RISKY_P_THRESHOLD,
  RISKY_CI95_HIGH_MAX,
  UNKNOWN_CI95_INTERVAL_MAX,
  UNKNOWN_MIN_N_OBS,
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

/** Verdict dérivé de (posterior combiné, convergence).
 *  - SAFE : fort signal positif + convergence multi-sources
 *  - RISKY : signal négatif clair (p bas OU borne haute de l'IC basse)
 *  - UNKNOWN : IC trop large, verdict indéterminé
 *  - INSUFFICIENT : pas assez d'observations pour conclure */
export type Verdict = 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';

export interface VerdictResult {
  verdict: Verdict;
  /** Raison lisible du verdict — utile pour debug / explainability dans l'UI. */
  reason: string;
}

/** Agrégat combiné (toutes sources) + convergence — entrée de computeVerdict. */
export interface AggregatePosterior {
  pSuccess: number;
  ci95Low: number;
  ci95High: number;
  nObs: number;
}

/** Outcome d'une transaction prêt à être ingéré dans les aggregates.
 *  Tous les champs sauf `success`, `timestamp` sont optionnels — on met à
 *  jour uniquement les niveaux hiérarchiques pour lesquels on a une clé. */
export interface TransactionOutcome {
  success: boolean;
  /** Unix seconds — sert à dater updated_at */
  timestamp: number;
  endpointHash?: string | null;
  serviceHash?: string | null;
  operatorId?: string | null;
  /** Pour route_aggregates : caller qui a lancé la transaction. */
  callerHash?: string | null;
  /** Pour route_aggregates : target reçu. */
  targetHash?: string | null;
}

/** Résumé de l'ingestion — combien d'agrégats ont été touchés. Utile en test. */
export interface IngestionResult {
  endpointUpdates: number;
  serviceUpdates: number;
  operatorUpdates: number;
  routeUpdates: number;
}

export class BayesianScoringService {
  constructor(
    private endpointRepo: EndpointAggregateRepository,
    private serviceRepo: ServiceAggregateRepository,
    private operatorRepo: OperatorAggregateRepository,
    private nodeRepo: NodeAggregateRepository,
    private routeRepo?: RouteAggregateRepository,
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

  /** Mapping déterministe (posterior combiné, convergence) → verdict.
   *
   *  Ordre d'évaluation strict (first-match) :
   *    1. INSUFFICIENT : n_obs < UNKNOWN_MIN_N_OBS (trop peu pour trancher).
   *    2. RISKY        : p_success < RISKY_P_THRESHOLD (0.50)
   *                      OU ci95_high < RISKY_CI95_HIGH_MAX (0.65).
   *                      Priorité haute — un signal négatif fort ne doit
   *                      jamais être écrasé par "UNKNOWN".
   *    3. UNKNOWN      : (ci95_high - ci95_low) > UNKNOWN_CI95_INTERVAL_MAX (0.40).
   *                      IC trop large = incertitude fondamentale.
   *    4. SAFE         : p ≥ 0.80 ET ci95_low ≥ 0.65 ET n_obs ≥ 10 ET convergence.
   *                      Tous les garde-fous alignés.
   *    5. UNKNOWN      : tout le reste — zone grise "pas assez clair pour SAFE". */
  computeVerdict(
    combined: AggregatePosterior,
    convergence: ConvergenceResult,
  ): VerdictResult {
    const { pSuccess, ci95Low, ci95High, nObs } = combined;
    const interval = ci95High - ci95Low;

    // 1. INSUFFICIENT (prioritaire — ne pas masquer l'incertitude par un verdict)
    if (nObs < UNKNOWN_MIN_N_OBS) {
      return { verdict: 'INSUFFICIENT', reason: `n_obs=${nObs} < ${UNKNOWN_MIN_N_OBS}` };
    }

    // 2. RISKY (prioritaire sur UNKNOWN — signal négatif ne s'efface pas)
    if (pSuccess < RISKY_P_THRESHOLD) {
      return { verdict: 'RISKY', reason: `p_success=${pSuccess.toFixed(3)} < ${RISKY_P_THRESHOLD}` };
    }
    if (ci95High < RISKY_CI95_HIGH_MAX) {
      return { verdict: 'RISKY', reason: `ci95_high=${ci95High.toFixed(3)} < ${RISKY_CI95_HIGH_MAX}` };
    }

    // 3. UNKNOWN par incertitude (IC trop large)
    if (interval > UNKNOWN_CI95_INTERVAL_MAX) {
      return { verdict: 'UNKNOWN', reason: `ci95_width=${interval.toFixed(3)} > ${UNKNOWN_CI95_INTERVAL_MAX}` };
    }

    // 4. SAFE — toutes les conditions alignées
    if (
      pSuccess >= SAFE_P_THRESHOLD &&
      ci95Low >= SAFE_CI95_LOW_MIN &&
      nObs >= SAFE_MIN_N_OBS &&
      convergence.converged
    ) {
      return { verdict: 'SAFE', reason: `p=${pSuccess.toFixed(3)} ≥ ${SAFE_P_THRESHOLD}, ci95_low=${ci95Low.toFixed(3)} ≥ ${SAFE_CI95_LOW_MIN}, converged (${convergence.sourcesAboveThreshold.length} sources)` };
    }

    // 5. UNKNOWN (fallback — zone grise : ni franchement positif, ni négatif)
    if (!convergence.converged) {
      return { verdict: 'UNKNOWN', reason: `no convergence (${convergence.sourcesAboveThreshold.length}/${CONVERGENCE_MIN_SOURCES} sources ≥ ${CONVERGENCE_P_THRESHOLD})` };
    }
    return { verdict: 'UNKNOWN', reason: `p=${pSuccess.toFixed(3)}, ci95=[${ci95Low.toFixed(3)}, ${ci95High.toFixed(3)}] — zone grise` };
  }

  /** Ingestion incrémentale : met à jour TOUS les niveaux hiérarchiques
   *  (endpoint, service, operator, route) sur les 3 fenêtres (24h/7d/30d)
   *  pour refléter une nouvelle transaction.
   *
   *  **Stratégie Option A (gravée dans le design)** :
   *  Les compteurs raw (n_success, n_failure) dans les aggregates sont
   *  NON-DÉCROISSANTS. Chaque observation compte pour son poids plein
   *  dans chacune des 3 fenêtres, quelle que soit l'ancienneté. La
   *  décroissance exponentielle est appliquée UNIQUEMENT à la LECTURE
   *  par computePerSourcePosteriors/computeDecayedPosterior, en relisant
   *  la table transactions et en pondérant par exp(-age/τ).
   *
   *  Rationale : INSERT O(nb_niveaux × 3_fenêtres) = ~12-15 UPDATE au pire.
   *  Si on voulait appliquer la décroissance à l'INSERT, il faudrait
   *  recalculer depuis 0 toute la fenêtre à chaque observation (O(n)
   *  par update) — impensable en prod. Au pire le posterior raw surestime
   *  légèrement la confiance d'une entité ancienne ; le read-path corrige.
   *
   *  Pour les 3 fenêtres on applique exactement le même delta — elles
   *  divergent naturellement par pruneStale() (exécuté par un job de purge). */
  ingestTransactionOutcome(outcome: TransactionOutcome): IngestionResult {
    const delta = {
      successDelta: outcome.success ? 1 : 0,
      failureDelta: outcome.success ? 0 : 1,
      updatedAt: outcome.timestamp,
    };
    const result: IngestionResult = {
      endpointUpdates: 0, serviceUpdates: 0, operatorUpdates: 0, routeUpdates: 0,
    };

    for (const window of BAYESIAN_WINDOWS) {
      if (outcome.endpointHash) {
        this.endpointRepo.upsert(outcome.endpointHash, window, delta);
        result.endpointUpdates++;
      }
      if (outcome.serviceHash) {
        this.serviceRepo.upsert(outcome.serviceHash, window, delta);
        result.serviceUpdates++;
      }
      if (outcome.operatorId) {
        this.operatorRepo.upsert(outcome.operatorId, window, delta);
        result.operatorUpdates++;
      }
      if (this.routeRepo && outcome.callerHash && outcome.targetHash) {
        const routeKey = `${outcome.callerHash}:${outcome.targetHash}`;
        this.routeRepo.upsertRoute(routeKey, outcome.callerHash, outcome.targetHash, window, delta);
        result.routeUpdates++;
      }
    }

    return result;
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
