// Composition publique du moteur bayésien — C9.
//
// Assemble en une seule passe le shape que l'API doit retourner pour une cible :
//   - posterior combiné (tous sources) → p_success, ci95_low, ci95_high, n_obs
//   - per-source breakdown → sources.{probe,report,paid}
//   - convergence multi-sources → convergence.{converged, ..., threshold}
//   - verdict déterministe → SAFE / RISKY / UNKNOWN / INSUFFICIENT
//   - métadonnées de diagnostic → window choisie, priorSource (operator/service/flat)
//
// Source des observations : la table `transactions` (colonnes v31 endpoint_hash,
// operator_id, source). On applique la décroissance exponentielle à la lecture
// (Option A gravée en C8).

import type { Database } from 'better-sqlite3';
import {
  BayesianScoringService,
  type PerSourceResult,
  type ConvergenceResult,
  type VerdictResult,
  type SourceObservation,
  type ReportTier,
} from './bayesianScoringService';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  type BayesianWindow,
  type BayesianSource,
} from '../config/bayesianConfig';
import { computePosterior } from '../utils/betaBinomial';

/** Contexte d'une requête verdict — clés d'identification de la cible. */
export interface BayesianVerdictQuery {
  /** Clé principale — endpoint_hash (URL L402) OU pubkey de l'agent. */
  targetHash: string;
  /** service_hash parent (si connu — permet l'héritage du prior hiérarchique). */
  serviceHash?: string | null;
  /** operator_id (pubkey node hash) — couche hiérarchique la plus fine. */
  operatorId?: string | null;
  /** Tier reporter si l'appel vient d'un agent authentifié. Défaut 'low'. */
  reporterTier?: ReportTier;
}

/** Shape par source exposé dans l'API. Aligné sur le brief utilisateur. */
export interface BayesianSourceBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  weight_total: number;
}

/** Réponse complète — correspond strictement au shape demandé en C9. */
export interface BayesianVerdictResponse {
  target: string;
  /** Posterior combiné toutes sources. */
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  /** Verdict déterministe. */
  verdict: VerdictResult['verdict'];
  /** Raison explainable du verdict. */
  verdict_reason: string;
  /** Fenêtre temporelle auto-sélectionnée. */
  window: BayesianWindow;
  /** Breakdown par source — null quand aucune observation de cette source. */
  sources: {
    probe:  BayesianSourceBlock | null;
    report: BayesianSourceBlock | null;
    paid:   BayesianSourceBlock | null;
  };
  /** Convergence multi-sources. */
  convergence: {
    converged: boolean;
    sources_above_threshold: BayesianSource[];
    threshold: number;
  };
  /** Source du prior (diagnostic : operator / service / flat). */
  prior_source: 'operator' | 'service' | 'flat';
  /** Timestamp unix seconds de la réponse. */
  computed_at: number;
}

export class BayesianVerdictService {
  constructor(
    private db: Database,
    private bayesian: BayesianScoringService,
  ) {}

  /** Point d'entrée public — retourne la réponse complète pour une cible. */
  buildVerdict(query: BayesianVerdictQuery): BayesianVerdictResponse {
    const now = Math.floor(Date.now() / 1000);

    // 1. Auto-sélection de la fenêtre (plus courte avec ≥ 20 obs, fallback 30d)
    const window = this.bayesian.selectEndpointWindow(query.targetHash);

    // 2. Prior hiérarchique (operator → service → flat)
    const prior = this.bayesian.resolveHierarchicalPrior(
      { operatorId: query.operatorId, serviceHash: query.serviceHash },
      window,
    );

    // 3. Lecture des observations depuis `transactions` pour cette cible + fenêtre
    const observations = this.loadObservations(query.targetHash, window, query.reporterTier, now);

    // 4. Calcul des posteriors par source (avec pondération poids × décroissance)
    const perSource = this.bayesian.computePerSourcePosteriors(
      { alpha: prior.alpha, beta: prior.beta },
      observations,
    );

    // 5. Posterior combiné — somme des poids toutes sources sur le même prior
    const combined = this.combineAllSources(prior, observations);

    // 6. Convergence
    const convergence = this.bayesian.checkConvergence(perSource);

    // 7. Verdict
    const verdict = this.bayesian.computeVerdict(
      {
        pSuccess: combined.pSuccess,
        ci95Low: combined.ci95Low,
        ci95High: combined.ci95High,
        nObs: combined.nObs,
      },
      convergence,
    );

    return {
      target: query.targetHash,
      p_success: round3(combined.pSuccess),
      ci95_low: round3(combined.ci95Low),
      ci95_high: round3(combined.ci95High),
      n_obs: combined.nObs,
      verdict: verdict.verdict,
      verdict_reason: verdict.reason,
      window,
      sources: {
        probe:  toSourceBlock(perSource.probe),
        report: toSourceBlock(perSource.report),
        paid:   toSourceBlock(perSource.paid),
      },
      convergence: {
        converged: convergence.converged,
        sources_above_threshold: convergence.sourcesAboveThreshold,
        threshold: convergence.threshold,
      },
      prior_source: prior.source,
      computed_at: now,
    };
  }

  /** Charge les transactions pertinentes depuis la table `transactions`.
   *
   *  Filtre par endpoint_hash (ou autre clé passée en targetHash) + par fenêtre
   *  temporelle. La décroissance est calculée à partir du timestamp individuel
   *  de chaque transaction vs maintenant. */
  private loadObservations(
    targetHash: string,
    window: BayesianWindow,
    reporterTier: ReportTier | undefined,
    now: number,
  ): SourceObservation[] {
    const windowSec = this.bayesian.windowSeconds(window);
    const cutoff = now - windowSec;

    // Requête : on sélectionne les transactions correspondant à la cible
    // (endpoint_hash = targetHash) dans la fenêtre. `source` est l'enum
    // v31 ('probe' | 'observer' | 'report' | 'intent') qu'on mappe vers
    // les sources bayésiennes.
    const rows = this.db.prepare(`
      SELECT timestamp, status, source
      FROM transactions
      WHERE endpoint_hash = ?
        AND timestamp >= ?
    `).all(targetHash, cutoff) as { timestamp: number; status: string; source: string | null }[];

    const observations: SourceObservation[] = [];
    for (const row of rows) {
      const bayesianSource = mapTransactionSourceToBayesian(row.source);
      if (!bayesianSource) continue; // intent-only / non-classifié — pas d'observation scorable
      observations.push({
        success: row.status === 'verified',
        source: bayesianSource,
        tier: bayesianSource === 'report' ? (reporterTier ?? 'low') : undefined,
        ageSec: Math.max(0, now - row.timestamp),
        window,
      });
    }
    return observations;
  }

  /** Posterior combiné = partir du même prior et additionner toutes les observations
   *  pondérées (toutes sources confondues). Différent de la somme des posteriors par source
   *  car la somme-des-posteriors double-compte le prior. */
  private combineAllSources(
    prior: { alpha: number; beta: number },
    observations: readonly SourceObservation[],
  ) {
    let wSuccess = 0;
    let wFailure = 0;
    for (const obs of observations) {
      const sourceW = this.bayesian.weightForSource(obs.source, obs.tier);
      const decayW = obs.ageSec !== undefined && obs.window !== undefined
        ? this.bayesian.applyTemporalDecay(obs.ageSec, obs.window)
        : 1;
      const w = sourceW * decayW;
      if (obs.success) wSuccess += w;
      else wFailure += w;
    }
    return computePosterior(prior.alpha, prior.beta, wSuccess, wFailure);
  }
}

/** Mapping transaction.source (v31) → BayesianSource.
 *  - probe     → probe  (sovereign probe que SatRank a exécuté)
 *  - observer  → probe  (tx observée sur-LN, preuve équivalente)
 *  - report    → report (rapport d'agent, pondéré par tier)
 *  - intent    → null   (decide_log, pas une observation de succès/échec)
 *  - null/autre → null */
function mapTransactionSourceToBayesian(source: string | null): BayesianSource | null {
  if (source === 'probe' || source === 'observer') return 'probe';
  if (source === 'report') return 'report';
  return null; // intent ou rows legacy
}

function toSourceBlock(p: PerSourceResult['probe']): BayesianSourceBlock | null {
  if (!p) return null;
  return {
    p_success: round3(p.pSuccess),
    ci95_low:  round3(p.ci95Low),
    ci95_high: round3(p.ci95High),
    n_obs: Math.round(p.nObs * 1000) / 1000,
    weight_total: Math.round(p.weightTotal * 1000) / 1000,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Export pour les tests — permet d'injecter un prior flat sans passer par le repo. */
export const BAYESIAN_FLAT_PRIOR = { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA };
