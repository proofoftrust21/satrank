// Composition publique du moteur bayésien — Phase 3 C9 (streaming shape).
//
// Lit directement dans les streaming_posteriors (Option A gravée en C5+) au
// lieu de rejouer la table `transactions`. Les posteriors sont pré-décayés
// jusqu'à `now` côté repo (τ=7j exponentielle, voir StreamingPosteriorRepository).
//
// Shape publique :
//   - posterior combiné (toutes sources) → p_success, ci95_low, ci95_high, n_obs
//   - per-source breakdown → sources.{probe,report,paid}
//   - convergence multi-sources → convergence.{converged, ..., threshold}
//   - verdict déterministe → SAFE / RISKY / UNKNOWN / INSUFFICIENT
//   - recent_activity → n_obs cumulé 24h/7d/30d (daily_buckets, observer inclus)
//   - risk_profile → trend delta success_rate 7j récents vs 23j antérieurs
//   - time_constant_days → τ=7 (constant, diagnostic pour clients)
//   - last_update → timestamp unix max des 3 sources (ou 0 si vierge)
//   - prior_source → operator/service/flat (hiérarchie du prior)

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import {
  BayesianScoringService,
  type VerdictResult,
  type RiskProfile,
} from './bayesianScoringService';
import { CONVERGENCE_P_THRESHOLD, CONVERGENCE_MIN_SOURCES } from '../config/bayesianConfig';
import type {
  EndpointStreamingPosteriorRepository,
  DecayedPosterior,
} from '../repositories/streamingPosteriorRepository';
import type { EndpointDailyBucketsRepository, RecentActivity } from '../repositories/dailyBucketsRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_DAYS,
  type BayesianSource,
} from '../config/bayesianConfig';
import { computePosterior } from '../utils/betaBinomial';

/** Min p_success delta to trigger a new snapshot row (Phase 3 C8). */
const SNAPSHOT_CHANGE_THRESHOLD = 0.005;
/** Heartbeat — force ≥ 1 snapshot/agent/day even if p_success is static. */
const SNAPSHOT_HEARTBEAT_SEC = 86_400;

/** Contexte d'une requête verdict — clés d'identification de la cible. */
export interface BayesianVerdictQuery {
  /** Clé principale — endpoint_hash (URL L402) OU pubkey de l'agent. */
  targetHash: string;
  /** service_hash parent (si connu — permet l'héritage du prior hiérarchique). */
  serviceHash?: string | null;
  /** operator_id (pubkey node hash) — couche hiérarchique la plus fine. */
  operatorId?: string | null;
}

/** Shape par source exposé dans l'API. */
export interface BayesianSourceBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  weight_total: number;
}

/** Réponse complète — streaming shape (C9). */
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
  /** n_obs cumulé par fenêtre d'affichage — daily_buckets, observer inclus. */
  recent_activity: RecentActivity;
  /** Trend delta success_rate (low/medium/high/unknown) — Option B. */
  risk_profile: RiskProfile;
  /** Constante τ exposée pour explainability client (décroissance). */
  time_constant_days: number;
  /** Unix seconds de la dernière ingestion connue — max(probe,report,paid). 0 si vierge. */
  last_update: number;
  /** Timestamp unix seconds de la réponse. */
  computed_at: number;
}

export class BayesianVerdictService {
  constructor(
    private db: Database,
    private bayesian: BayesianScoringService,
    private endpointStreamingRepo: EndpointStreamingPosteriorRepository,
    private endpointBucketsRepo: EndpointDailyBucketsRepository,
    private snapshotRepo?: SnapshotRepository,
  ) {}

  /** Compute the Bayesian verdict for an agent and persist a snapshot row
   *  into score_snapshots when the posterior has moved (|Δp_success| ≥ 0.005)
   *  or the previous snapshot is older than SNAPSHOT_HEARTBEAT_SEC.
   *
   *  Le champ `window` en DB reste présent (v33 column) mais n'a plus de sens
   *  en streaming : on écrit '7d' comme constante sentinel (τ=7 correspond).
   *  Le nettoyage de colonne se fait en C14. */
  snapshotAndPersist(agentHash: string): BayesianVerdictResponse {
    const response = this.buildVerdict({ targetHash: agentHash });
    if (!this.snapshotRepo) return response;

    const now = Math.floor(Date.now() / 1000);
    const latest = this.snapshotRepo.findLatestByAgent(agentHash);
    const changed = !latest
      || Math.abs(latest.p_success - response.p_success) >= SNAPSHOT_CHANGE_THRESHOLD;
    const stale = !latest
      || (now - latest.computed_at) >= SNAPSHOT_HEARTBEAT_SEC;

    if (changed || stale) {
      const posteriorAlpha = DEFAULT_PRIOR_ALPHA + response.n_obs * response.p_success;
      const posteriorBeta = DEFAULT_PRIOR_BETA + response.n_obs * (1 - response.p_success);
      this.snapshotRepo.insert({
        snapshot_id: randomUUID(),
        agent_hash: agentHash,
        p_success: response.p_success,
        ci95_low: response.ci95_low,
        ci95_high: response.ci95_high,
        n_obs: response.n_obs,
        posterior_alpha: posteriorAlpha,
        posterior_beta: posteriorBeta,
        window: '7d',
        computed_at: now,
        updated_at: now,
      });
    }
    return response;
  }

  /** Point d'entrée public — retourne la réponse complète pour une cible. */
  buildVerdict(query: BayesianVerdictQuery): BayesianVerdictResponse {
    const now = Math.floor(Date.now() / 1000);

    // 1. Lecture directe des posteriors décayés pour les 3 sources.
    //    Les repos appliquent la décroissance exponentielle τ=7j au moment
    //    de la lecture (pas de relecture des transactions).
    const decayed = this.endpointStreamingRepo.readAllSourcesDecayed(query.targetHash, now);

    // 2. Per-source blocks — null quand totalIngestions == 0.
    const sources = {
      probe:  toSourceBlock(decayed.probe),
      report: toSourceBlock(decayed.report),
      paid:   toSourceBlock(decayed.paid),
    };

    // 3. Posterior combiné : partir du prior flat + additionner les (α,β) excédentaires
    //    de chaque source. Chaque source contribue (α - α₀) en succès pondérés et
    //    (β - β₀) en échecs pondérés — cohérent avec la sémantique "excess evidence"
    //    de nObsEffective. On ne double-compte donc pas le prior.
    const combined = this.combineDecayedSources(decayed);

    // 4. Convergence — une source "converge" si son p_success ≥ CONVERGENCE_P_THRESHOLD.
    //    Calcul local pour éviter d'exposer les types internes du scoringService.
    const aboveThreshold: BayesianSource[] = [];
    for (const src of ['probe', 'report', 'paid'] as const) {
      const block = sources[src];
      if (block && block.p_success >= CONVERGENCE_P_THRESHOLD) aboveThreshold.push(src);
    }
    const convergence = {
      converged: aboveThreshold.length >= CONVERGENCE_MIN_SOURCES,
      sourcesAboveThreshold: aboveThreshold,
      threshold: CONVERGENCE_P_THRESHOLD,
    };

    // 5. Verdict déterministe.
    const verdict = this.bayesian.computeVerdict(
      {
        pSuccess: combined.pSuccess,
        ci95Low: combined.ci95Low,
        ci95High: combined.ci95High,
        nObs: combined.nObs,
      },
      convergence,
    );

    // 6. Overlays display : prior_source, recent_activity (buckets), risk_profile.
    const prior = this.bayesian.resolveHierarchicalPrior(
      { operatorId: query.operatorId, serviceHash: query.serviceHash },
      '7d', // fenêtre héritée conservée le temps de migrer les aggregates tables.
    );
    const recent_activity = this.endpointBucketsRepo.recentActivity(query.targetHash, now);
    const riskProfileResult = this.bayesian.computeRiskProfile(
      this.endpointBucketsRepo,
      query.targetHash,
      now,
    );

    // last_update = max des lastUpdateTs des 3 sources. 0 quand rien n'a été ingéré.
    const last_update = Math.max(
      decayed.probe.lastUpdateTs,
      decayed.report.lastUpdateTs,
      decayed.paid.lastUpdateTs,
    );

    return {
      target: query.targetHash,
      p_success: round3(combined.pSuccess),
      ci95_low: round3(combined.ci95Low),
      ci95_high: round3(combined.ci95High),
      n_obs: round3(combined.nObs),
      verdict: verdict.verdict,
      verdict_reason: verdict.reason,
      sources,
      convergence: {
        converged: convergence.converged,
        sources_above_threshold: convergence.sourcesAboveThreshold,
        threshold: convergence.threshold,
      },
      prior_source: prior.source,
      recent_activity,
      risk_profile: riskProfileResult.profile,
      time_constant_days: TAU_DAYS,
      last_update,
      computed_at: now,
    };
  }

  /** Combine les (α,β) décayés des 3 sources en un unique posterior Beta.
   *  On part du prior flat et on additionne les deltas "excess evidence"
   *  (α_source - α₀, β_source - β₀) — évite le double-compte du prior
   *  quand plusieurs sources ont des données.
   *
   *  nObs rapporté = somme des nObsEffective (== total excess) — correspond
   *  au "nombre d'observations effectives" après décroissance, cohérent avec
   *  les seuils UNKNOWN_MIN_N_OBS / SAFE_MIN_N_OBS. */
  private combineDecayedSources(decayed: Record<BayesianSource, DecayedPosterior>) {
    let wSuccess = 0;
    let wFailure = 0;
    for (const src of ['probe', 'report', 'paid'] as const) {
      const d = decayed[src];
      if (d.totalIngestions === 0) continue;
      // α_source - α₀ représente les succès pondérés accumulés (post-décroissance).
      wSuccess += Math.max(0, d.posteriorAlpha - DEFAULT_PRIOR_ALPHA);
      wFailure += Math.max(0, d.posteriorBeta - DEFAULT_PRIOR_BETA);
    }
    return computePosterior(DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, wSuccess, wFailure);
  }
}

/** Convertit une row décayée → block API. Retourne null quand aucune observation. */
function toSourceBlock(d: DecayedPosterior): BayesianSourceBlock | null {
  if (d.totalIngestions === 0) return null;
  const alpha = d.posteriorAlpha;
  const beta = d.posteriorBeta;
  const post = computePosterior(
    DEFAULT_PRIOR_ALPHA,
    DEFAULT_PRIOR_BETA,
    Math.max(0, alpha - DEFAULT_PRIOR_ALPHA),
    Math.max(0, beta - DEFAULT_PRIOR_BETA),
  );
  return {
    p_success: round3(post.pSuccess),
    ci95_low:  round3(post.ci95Low),
    ci95_high: round3(post.ci95High),
    n_obs: round3(d.nObsEffective),
    weight_total: round3(d.nObsEffective),
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Export pour les tests — permet d'injecter un prior flat sans passer par le repo. */
export const BAYESIAN_FLAT_PRIOR = { alpha: DEFAULT_PRIOR_ALPHA, beta: DEFAULT_PRIOR_BETA };
