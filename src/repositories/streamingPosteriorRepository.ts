// Data access pour les 5 tables *_streaming_posteriors (Phase 3 refactor; pg async port, Phase 12B).
//
// Modèle :
//   Une unique row par (id, source) — plus de window column. Chaque row
//   maintient (posterior_alpha, posterior_beta, last_update_ts). La décroissance
//   exponentielle τ=7 jours est appliquée :
//     - à l'ingestion : on décroît l'état stocké vers le prior avant d'ajouter
//       les deltas de la nouvelle observation
//     - à la lecture : on décroît l'état stocké vers le prior jusqu'au
//       timestamp `atTs` pour obtenir un état cohérent temporellement
//
// Formule de décroissance (garde le prior flat α₀=β₀=1.5 comme attracteur) :
//   α(t) = (α_stored - α₀)·exp(-Δt/τ) + α₀
//   β(t) = (β_stored - β₀)·exp(-Δt/τ) + β₀
// À la limite t→∞, (α,β) → (α₀,β₀) : toute information se dissout. À t=0 (Δt=0),
// (α,β) = (α_stored, β_stored) — aucune perte d'information si on ingère
// immédiatement une autre observation.
//
// n_obs_effective = (α + β) - (α₀ + β₀) représente "l'excès d'évidence"
// par rapport au prior flat — c'est cette grandeur qui sert au verdict.
//
// Source CHECK constraint SQL : {'probe','report','paid'}. Observer est
// explicitement rejeté (contrat Q3 — observer compte dans daily_buckets pour
// l'activité mais n'alimente pas le verdict).

import type { Pool, PoolClient } from 'pg';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_SECONDS,
} from '../config/bayesianConfig';
import type { BayesianSource } from '../config/bayesianConfig';

type Queryable = Pool | PoolClient;

/** État décroché du disque, avant ou après application de la décroissance. */
export interface StreamingPosterior {
  id: string;
  source: BayesianSource;
  posteriorAlpha: number;
  posteriorBeta: number;
  lastUpdateTs: number;
  totalIngestions: number;
}

/** État décroché + décayé jusqu'à un timestamp donné. Utilisé côté verdict. */
export interface DecayedPosterior {
  id: string;
  source: BayesianSource;
  posteriorAlpha: number;
  posteriorBeta: number;
  /** n_obs effectif après décroissance : (α + β) - (α₀ + β₀). */
  nObsEffective: number;
  /** Timestamp auquel la décroissance a été évaluée. */
  atTs: number;
  /** Timestamp de la dernière mise à jour du stockage (pré-décroissance). */
  lastUpdateTs: number;
  totalIngestions: number;
}

/** Deltas pondérés à ingérer dans le modèle. */
export interface StreamingIngestDeltas {
  successDelta: number;
  failureDelta: number;
  nowSec: number;
}

/** Calcule la décroissance d'un (α,β) vers le prior flat sur Δt secondes. */
export function decayPosterior(
  storedAlpha: number,
  storedBeta: number,
  lastUpdateTs: number,
  atTs: number,
): { alpha: number; beta: number } {
  const deltaSec = Math.max(0, atTs - lastUpdateTs);
  const decayFactor = Math.exp(-deltaSec / TAU_SECONDS);
  const alpha = (storedAlpha - DEFAULT_PRIOR_ALPHA) * decayFactor + DEFAULT_PRIOR_ALPHA;
  const beta = (storedBeta - DEFAULT_PRIOR_BETA) * decayFactor + DEFAULT_PRIOR_BETA;
  return { alpha, beta };
}

// ---------------------------------------------------------------------------
// Base class — comportement commun aux 4 tables simples
// (endpoint/node/service/operator). Route a sa propre classe (colonnes extra).
// ---------------------------------------------------------------------------

abstract class BaseStreamingRepository {
  protected abstract table: string;
  protected abstract idColumn: string;

  constructor(protected db: Queryable) {}

  /** Ingère une observation pondérée. Applique la décroissance sur l'état
   *  existant avant d'additionner les deltas. Upsert atomique — le caller
   *  wrappe la séquence SELECT→INSERT/UPDATE dans withTransaction() quand
   *  l'atomicité inter-calls est requise. */
  async ingest(id: string, source: BayesianSource, deltas: StreamingIngestDeltas): Promise<void> {
    const { successDelta, failureDelta, nowSec } = deltas;

    const { rows } = await this.db.query<{
      posterior_alpha: number;
      posterior_beta: number;
      last_update_ts: number;
      total_ingestions: number;
    }>(
      `SELECT posterior_alpha, posterior_beta, last_update_ts, total_ingestions
         FROM ${this.table}
        WHERE ${this.idColumn} = $1 AND source = $2`,
      [id, source],
    );
    const existing = rows[0];

    if (!existing) {
      // Première observation : on crée la row au prior flat + deltas.
      await this.db.query(
        `INSERT INTO ${this.table}
           (${this.idColumn}, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          source,
          DEFAULT_PRIOR_ALPHA + successDelta,
          DEFAULT_PRIOR_BETA + failureDelta,
          nowSec,
          1,
        ],
      );
      return;
    }

    // Cas chronologique normal (nowSec >= last_update_ts) : décroissance de
    // l'état existant jusqu'à nowSec, puis addition des nouveaux deltas.
    //
    // Cas out-of-order (nowSec < last_update_ts) — survient lors d'un backfill
    // qui replaye les rows par id croissant alors que les probes sont stockées
    // en ordre reverse-chrono, ou lors d'une observation tardive reçue après
    // une plus récente. On garde l'état aligné au `last_update_ts` le plus
    // récent (forward-only) et on ajoute les nouveaux deltas *déjà agés* de
    // (last_update_ts - nowSec) via le facteur exp(-Δt/τ). Mathématiquement
    // équivalent à : ingérer nowSec puis décayer jusqu'à last_update_ts.
    const alignTs = Math.max(existing.last_update_ts, nowSec);
    let newAlpha: number;
    let newBeta: number;
    if (nowSec >= existing.last_update_ts) {
      const decayed = decayPosterior(
        existing.posterior_alpha,
        existing.posterior_beta,
        existing.last_update_ts,
        nowSec,
      );
      newAlpha = decayed.alpha + successDelta;
      newBeta = decayed.beta + failureDelta;
    } else {
      const ageDelta = existing.last_update_ts - nowSec;
      const ageFactor = Math.exp(-ageDelta / TAU_SECONDS);
      newAlpha = existing.posterior_alpha + successDelta * ageFactor;
      newBeta = existing.posterior_beta + failureDelta * ageFactor;
    }

    await this.db.query(
      `UPDATE ${this.table}
          SET posterior_alpha = $1,
              posterior_beta = $2,
              last_update_ts = $3,
              total_ingestions = total_ingestions + 1
        WHERE ${this.idColumn} = $4 AND source = $5`,
      [newAlpha, newBeta, alignTs, id, source],
    );
  }

  /** Lit la row stockée (sans décroissance). */
  async findStored(id: string, source: BayesianSource): Promise<StreamingPosterior | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table}
        WHERE ${this.idColumn} = $1 AND source = $2`,
      [id, source],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row[this.idColumn] as string,
      source: row.source as BayesianSource,
      posteriorAlpha: Number(row.posterior_alpha),
      posteriorBeta: Number(row.posterior_beta),
      lastUpdateTs: Number(row.last_update_ts),
      totalIngestions: Number(row.total_ingestions),
    };
  }

  /** Lit l'état décayé à `atTs` pour une (id, source). Renvoie le prior flat
   *  si aucune observation n'a jamais été ingérée (nObsEffective = 0). */
  async readDecayed(id: string, source: BayesianSource, atTs: number): Promise<DecayedPosterior> {
    const stored = await this.findStored(id, source);
    if (!stored) {
      return {
        id,
        source,
        posteriorAlpha: DEFAULT_PRIOR_ALPHA,
        posteriorBeta: DEFAULT_PRIOR_BETA,
        nObsEffective: 0,
        atTs,
        lastUpdateTs: 0,
        totalIngestions: 0,
      };
    }
    const { alpha, beta } = decayPosterior(
      stored.posteriorAlpha,
      stored.posteriorBeta,
      stored.lastUpdateTs,
      atTs,
    );
    return {
      id,
      source,
      posteriorAlpha: alpha,
      posteriorBeta: beta,
      nObsEffective: alpha + beta - (DEFAULT_PRIOR_ALPHA + DEFAULT_PRIOR_BETA),
      atTs,
      lastUpdateTs: stored.lastUpdateTs,
      totalIngestions: stored.totalIngestions,
    };
  }

  /** Lit l'état décayé des 3 sources pour un même id. Utile pour le verdict. */
  async readAllSourcesDecayed(id: string, atTs: number): Promise<Record<BayesianSource, DecayedPosterior>> {
    return {
      probe: await this.readDecayed(id, 'probe', atTs),
      report: await this.readDecayed(id, 'report', atTs),
      paid: await this.readDecayed(id, 'paid', atTs),
    };
  }

  /** Purge les rows dont la dernière mise à jour est plus ancienne que
   *  `olderThanSec`. Suppression pure (pas de décroissance à zéro) car une
   *  row "dormante" a de toute façon un nObsEffective négligeable. */
  async pruneStale(olderThanSec: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE last_update_ts < $1`,
      [olderThanSec],
    );
    return result.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Repositories concrets
// ---------------------------------------------------------------------------

export class EndpointStreamingPosteriorRepository extends BaseStreamingRepository {
  protected table = 'endpoint_streaming_posteriors';
  protected idColumn = 'url_hash';
}

export class NodeStreamingPosteriorRepository extends BaseStreamingRepository {
  protected table = 'node_streaming_posteriors';
  protected idColumn = 'pubkey';
}

export class ServiceStreamingPosteriorRepository extends BaseStreamingRepository {
  protected table = 'service_streaming_posteriors';
  protected idColumn = 'service_hash';
}

export class OperatorStreamingPosteriorRepository extends BaseStreamingRepository {
  protected table = 'operator_streaming_posteriors';
  protected idColumn = 'operator_id';
}

// Route a besoin de caller_hash + target_hash en plus.
export class RouteStreamingPosteriorRepository {
  constructor(private db: Queryable) {}

  async ingest(
    routeHash: string,
    callerHash: string,
    targetHash: string,
    source: BayesianSource,
    deltas: StreamingIngestDeltas,
  ): Promise<void> {
    const { successDelta, failureDelta, nowSec } = deltas;

    const { rows } = await this.db.query<{
      posterior_alpha: number;
      posterior_beta: number;
      last_update_ts: number;
      total_ingestions: number;
    }>(
      `SELECT posterior_alpha, posterior_beta, last_update_ts, total_ingestions
         FROM route_streaming_posteriors
        WHERE route_hash = $1 AND source = $2`,
      [routeHash, source],
    );
    const existing = rows[0];

    if (!existing) {
      await this.db.query(
        `INSERT INTO route_streaming_posteriors
           (route_hash, source, caller_hash, target_hash,
            posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          routeHash,
          source,
          callerHash,
          targetHash,
          DEFAULT_PRIOR_ALPHA + successDelta,
          DEFAULT_PRIOR_BETA + failureDelta,
          nowSec,
          1,
        ],
      );
      return;
    }

    // Forward-only last_update_ts — cf BaseStreamingRepository.ingest pour
    // la logique out-of-order (backfill reverse-chrono, late arrivals).
    const alignTs = Math.max(existing.last_update_ts, nowSec);
    let newAlpha: number;
    let newBeta: number;
    if (nowSec >= existing.last_update_ts) {
      const decayed = decayPosterior(
        existing.posterior_alpha,
        existing.posterior_beta,
        existing.last_update_ts,
        nowSec,
      );
      newAlpha = decayed.alpha + successDelta;
      newBeta = decayed.beta + failureDelta;
    } else {
      const ageDelta = existing.last_update_ts - nowSec;
      const ageFactor = Math.exp(-ageDelta / TAU_SECONDS);
      newAlpha = existing.posterior_alpha + successDelta * ageFactor;
      newBeta = existing.posterior_beta + failureDelta * ageFactor;
    }

    await this.db.query(
      `UPDATE route_streaming_posteriors
          SET posterior_alpha = $1,
              posterior_beta = $2,
              last_update_ts = $3,
              total_ingestions = total_ingestions + 1
        WHERE route_hash = $4 AND source = $5`,
      [newAlpha, newBeta, alignTs, routeHash, source],
    );
  }

  async findStored(routeHash: string, source: BayesianSource): Promise<(StreamingPosterior & { callerHash: string; targetHash: string }) | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM route_streaming_posteriors
        WHERE route_hash = $1 AND source = $2`,
      [routeHash, source],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.route_hash as string,
      source: row.source as BayesianSource,
      posteriorAlpha: Number(row.posterior_alpha),
      posteriorBeta: Number(row.posterior_beta),
      lastUpdateTs: Number(row.last_update_ts),
      totalIngestions: Number(row.total_ingestions),
      callerHash: row.caller_hash as string,
      targetHash: row.target_hash as string,
    };
  }

  async readDecayed(routeHash: string, source: BayesianSource, atTs: number): Promise<DecayedPosterior> {
    const stored = await this.findStored(routeHash, source);
    if (!stored) {
      return {
        id: routeHash,
        source,
        posteriorAlpha: DEFAULT_PRIOR_ALPHA,
        posteriorBeta: DEFAULT_PRIOR_BETA,
        nObsEffective: 0,
        atTs,
        lastUpdateTs: 0,
        totalIngestions: 0,
      };
    }
    const { alpha, beta } = decayPosterior(
      stored.posteriorAlpha,
      stored.posteriorBeta,
      stored.lastUpdateTs,
      atTs,
    );
    return {
      id: routeHash,
      source,
      posteriorAlpha: alpha,
      posteriorBeta: beta,
      nObsEffective: alpha + beta - (DEFAULT_PRIOR_ALPHA + DEFAULT_PRIOR_BETA),
      atTs,
      lastUpdateTs: stored.lastUpdateTs,
      totalIngestions: stored.totalIngestions,
    };
  }

  async readAllSourcesDecayed(routeHash: string, atTs: number): Promise<Record<BayesianSource, DecayedPosterior>> {
    return {
      probe: await this.readDecayed(routeHash, 'probe', atTs),
      report: await this.readDecayed(routeHash, 'report', atTs),
      paid: await this.readDecayed(routeHash, 'paid', atTs),
    };
  }

  async pruneStale(olderThanSec: number): Promise<number> {
    const result = await this.db.query(
      'DELETE FROM route_streaming_posteriors WHERE last_update_ts < $1',
      [olderThanSec],
    );
    return result.rowCount ?? 0;
  }
}
