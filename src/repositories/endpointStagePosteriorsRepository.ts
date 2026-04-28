// Phase 5.14 — repository pour endpoint_stage_posteriors.
//
// Cinq Beta(α, β) par endpoint, un par stage du contrat L402 (challenge,
// invoice, payment, delivery, quality). Mêmes mécaniques que
// endpoint_streaming_posteriors (decay-at-read avec τ=7d) mais discriminé
// par stage pour la composition end-to-end.
import type { Pool, PoolClient } from 'pg';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_SECONDS,
} from '../config/bayesianConfig';
import { endpointHash } from '../utils/urlCanonical';

type Queryable = Pool | PoolClient;

/** Stages du contrat L402, ordonnés. Le code utilise les nombres pour le
 *  PRIMARY KEY composite ; le mapping nom ↔ numéro vit ici pour rester
 *  cohérent entre la migration, le repo et le service. */
export const STAGE_CHALLENGE = 1 as const;
export const STAGE_INVOICE = 2 as const;
export const STAGE_PAYMENT = 3 as const;
export const STAGE_DELIVERY = 4 as const;
export const STAGE_QUALITY = 5 as const;

export type Stage =
  | typeof STAGE_CHALLENGE
  | typeof STAGE_INVOICE
  | typeof STAGE_PAYMENT
  | typeof STAGE_DELIVERY
  | typeof STAGE_QUALITY;

export const ALL_STAGES: readonly Stage[] = [
  STAGE_CHALLENGE,
  STAGE_INVOICE,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
  STAGE_QUALITY,
] as const;

export const STAGE_NAMES: Record<Stage, string> = {
  [STAGE_CHALLENGE]: 'challenge',
  [STAGE_INVOICE]: 'invoice',
  [STAGE_PAYMENT]: 'payment',
  [STAGE_DELIVERY]: 'delivery',
  [STAGE_QUALITY]: 'quality',
};

/** Posterior brut tel que stocké en base, sans décroissance appliquée. */
export interface RawStagePosterior {
  endpoint_url_hash: string;
  stage: Stage;
  alpha: number;
  beta: number;
  n_obs: number;
  last_updated: number;
}

/** Posterior après décroissance exponentielle vers le prior. Renvoyé par les
 *  méthodes de lecture — caller voit toujours le posterior aligné au temps
 *  courant, ce qui simplifie la composition end-to-end. */
export interface DecayedStagePosterior {
  endpoint_url_hash: string;
  stage: Stage;
  alpha: number;
  beta: number;
  /** n_obs effectif après décroissance, = (α + β) − (α₀ + β₀). Utilisé pour
   *  gater l'inclusion d'un stage dans la composition multiplicative. */
  n_obs_effective: number;
  /** Mean Beta posterior, α / (α + β). */
  p_success: number;
  last_updated: number;
}

/** Décroissance exponentielle d'un posterior vers le prior (α₀, β₀). Appliquée
 *  à la lecture pour que tous les callers voient un posterior cohérent au
 *  temps courant, sans requérir un cron de "tick" périodique. Identique au
 *  modèle utilisé par bayesianStreamingIngestion. */
export function decayPosterior(
  alpha: number,
  beta: number,
  lastUpdated: number,
  nowSec: number,
): { alpha: number; beta: number; n_obs_effective: number; p_success: number } {
  const dt = Math.max(0, nowSec - lastUpdated);
  const factor = Math.exp(-dt / TAU_SECONDS);
  const a0 = DEFAULT_PRIOR_ALPHA;
  const b0 = DEFAULT_PRIOR_BETA;
  // Décroît la masse d'évidence excédentaire vers le prior. Le prior reste
  // intact (minimum α₀, β₀) — α ne descend jamais sous α₀.
  const decayedAlpha = a0 + (alpha - a0) * factor;
  const decayedBeta = b0 + (beta - b0) * factor;
  const total = decayedAlpha + decayedBeta;
  const p = total > 0 ? decayedAlpha / total : 0.5;
  return {
    alpha: decayedAlpha,
    beta: decayedBeta,
    n_obs_effective: total - (a0 + b0),
    p_success: p,
  };
}

/** Outcome d'un probe à un stage donné. `success=true` ajoute 1 à α,
 *  `success=false` ajoute 1 à β. Le poids permet aux callers (ex. paid probe
 *  Phase 5.12) d'utiliser WEIGHT_PAID_PROBE = 2.0 au lieu du poids unitaire,
 *  ce qui matche la pondération existante dans bayesianStreamingIngestion. */
export interface StageObservation {
  endpoint_url: string;
  stage: Stage;
  success: boolean;
  weight?: number; // default 1
  /** Phase 5.15 — label textuel optionnel ('valid', 'pay_ok', 'delivery_4xx',
   *  'quality_low', etc.) loggé dans endpoint_stage_outcomes_log pour le
   *  calibration debug. Pas utilisé par le streaming posterior, juste pour
   *  l'audit. */
  outcome_label?: string;
}

export class EndpointStagePosteriorsRepository {
  constructor(private readonly db: Queryable) {}

  /** Phase 9.0 — variant qui prend directement le url_hash. Permet aux
   *  callers (consolidation cron de crowd_outcome_reports) qui ont déjà
   *  le hash sans avoir l'URL d'origine. Délégation pure : appelle
   *  observeByUrlHashInternal. */
  async observeByUrlHash(
    urlHash: string,
    stage: Stage,
    success: boolean,
    weight: number,
    outcomeLabel?: string,
    nowSec?: number,
  ): Promise<void> {
    return this.observeByUrlHashInternal(urlHash, stage, success, weight, outcomeLabel, nowSec);
  }

  private async observeByUrlHashInternal(
    urlHash: string,
    stage: Stage,
    success: boolean,
    weight: number,
    outcomeLabel: string | undefined,
    nowSec: number | undefined,
  ): Promise<void> {
    const t = nowSec ?? Math.floor(Date.now() / 1000);
    const w = weight;
    const dAlpha = success ? w : 0;
    const dBeta = success ? 0 : w;
    await this.db.query(
      `INSERT INTO endpoint_stage_posteriors
         (endpoint_url_hash, stage, alpha, beta, n_obs, last_updated)
       VALUES (
         $1::text,
         $2::smallint,
         ($3::double precision + $5::double precision),
         ($4::double precision + $6::double precision),
         ($5::double precision + $6::double precision),
         $7::bigint
       )
       ON CONFLICT (endpoint_url_hash, stage)
       DO UPDATE SET
         alpha = $3::double precision + (
           $5::double precision
           + (endpoint_stage_posteriors.alpha - $3::double precision)
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ),
         beta = $4::double precision + (
           $6::double precision
           + (endpoint_stage_posteriors.beta - $4::double precision)
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ),
         n_obs = (
           endpoint_stage_posteriors.n_obs
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ) + $5::double precision + $6::double precision,
         last_updated = $7::bigint`,
      [urlHash, stage, DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, dAlpha, dBeta, t, TAU_SECONDS],
    );
    if (stage >= 2) {
      await this.db.query(
        `INSERT INTO endpoint_stage_outcomes_log
           (endpoint_url_hash, stage, success, weight, outcome_label, observed_at)
         VALUES ($1::text, $2::smallint, $3::boolean, $4::double precision, $5, $6::bigint)`,
        [urlHash, stage, success, w, outcomeLabel ?? null, t],
      );
    }
  }

  /** Phase 5.14 — applique une observation à un stage, en upsert. Ingestion
   *  decay-at-write : avant d'incrémenter, on rabat le posterior existant au
   *  temps de l'observation, puis on ajoute le poids. Cohérent avec
   *  bayesianStreamingIngestion. */
  async observe(obs: StageObservation, nowSec?: number): Promise<void> {
    const t = nowSec ?? Math.floor(Date.now() / 1000);
    const w = obs.weight ?? 1;
    const urlHash = endpointHash(obs.endpoint_url);
    const dAlpha = obs.success ? w : 0;
    const dBeta = obs.success ? 0 : w;

    // INSERT avec defaults, ON CONFLICT update en appliquant decay puis +w.
    // Le decay se fait via un calcul SQL inline pour éviter un read-then-write.
    // Casts explicites en double precision pour aider Postgres à résoudre les
    // opérateurs sur des paramètres non typés (sinon : "operator is not unique").
    await this.db.query(
      `INSERT INTO endpoint_stage_posteriors
         (endpoint_url_hash, stage, alpha, beta, n_obs, last_updated)
       VALUES (
         $1::text,
         $2::smallint,
         ($3::double precision + $5::double precision),
         ($4::double precision + $6::double precision),
         ($5::double precision + $6::double precision),
         $7::bigint
       )
       ON CONFLICT (endpoint_url_hash, stage)
       DO UPDATE SET
         alpha = $3::double precision + (
           $5::double precision
           + (endpoint_stage_posteriors.alpha - $3::double precision)
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ),
         beta = $4::double precision + (
           $6::double precision
           + (endpoint_stage_posteriors.beta - $4::double precision)
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ),
         n_obs = (
           endpoint_stage_posteriors.n_obs
             * exp(-($7::bigint - endpoint_stage_posteriors.last_updated)::double precision / $8::double precision)
         ) + $5::double precision + $6::double precision,
         last_updated = $7::bigint`,
      [urlHash, obs.stage, DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, dAlpha, dBeta, t, TAU_SECONDS],
    );

    // Phase 5.15 — log per-observation pour la calibration cron. Stage 1
    // (challenge) reste sur endpoint_streaming_posteriors source='probe' et
    // n'est PAS double-loggé ici. Seuls les stages 2-5 (qui sont la cible
    // directe de la calibration) sont loggés.
    if (obs.stage >= 2) {
      await this.db.query(
        `INSERT INTO endpoint_stage_outcomes_log
           (endpoint_url_hash, stage, success, weight, outcome_label, observed_at)
         VALUES ($1::text, $2::smallint, $3::boolean, $4::double precision, $5, $6::bigint)`,
        [urlHash, obs.stage, obs.success, w, obs.outcome_label ?? null, t],
      );
    }
  }

  /** Phase 5.14 — lecture des 5 stages d'un endpoint, posteriors décroissés
   *  au temps courant. Retourne un Map stage → DecayedStagePosterior. Les
   *  stages sans row en DB sont absents de la Map ; le caller décide quoi
   *  faire (typiquement : exclure de la composition). */
  async findAllStages(
    endpointUrl: string,
    nowSec?: number,
  ): Promise<Map<Stage, DecayedStagePosterior>> {
    const t = nowSec ?? Math.floor(Date.now() / 1000);
    const urlHash = endpointHash(endpointUrl);
    const { rows } = await this.db.query<{
      endpoint_url_hash: string;
      stage: number;
      alpha: number;
      beta: number;
      n_obs: number;
      last_updated: number;
    }>(
      `SELECT endpoint_url_hash, stage, alpha, beta, n_obs, last_updated
         FROM endpoint_stage_posteriors
        WHERE endpoint_url_hash = $1`,
      [urlHash],
    );

    const result = new Map<Stage, DecayedStagePosterior>();
    for (const r of rows) {
      const stage = r.stage as Stage;
      const decayed = decayPosterior(r.alpha, r.beta, r.last_updated, t);
      result.set(stage, {
        endpoint_url_hash: r.endpoint_url_hash,
        stage,
        alpha: decayed.alpha,
        beta: decayed.beta,
        n_obs_effective: decayed.n_obs_effective,
        p_success: decayed.p_success,
        last_updated: r.last_updated,
      });
    }
    return result;
  }

  /** Phase 5.14 — lecture brute (sans décroissance), utile pour les tests
   *  d'invariants et les exports d'audit. Caller applique decayPosterior si
   *  besoin. */
  async findRaw(
    endpointUrl: string,
    stage: Stage,
  ): Promise<RawStagePosterior | null> {
    const urlHash = endpointHash(endpointUrl);
    const { rows } = await this.db.query<RawStagePosterior>(
      `SELECT endpoint_url_hash, stage, alpha, beta, n_obs, last_updated
         FROM endpoint_stage_posteriors
        WHERE endpoint_url_hash = $1 AND stage = $2`,
      [urlHash, stage],
    );
    return rows[0] ?? null;
  }
}
