// Data access pour les 5 tables *_streaming_posteriors (Phase 3 refactor).
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

import type Database from 'better-sqlite3';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_SECONDS,
} from '../config/bayesianConfig';
import type { BayesianSource } from '../config/bayesianConfig';

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

  constructor(protected db: Database.Database) {}

  /** Ingère une observation pondérée. Applique la décroissance sur l'état
   *  existant avant d'additionner les deltas. Upsert atomique via INSERT
   *  OR IGNORE + UPDATE dans la même transaction caller. */
  ingest(id: string, source: BayesianSource, deltas: StreamingIngestDeltas): void {
    const { successDelta, failureDelta, nowSec } = deltas;

    const existing = this.db
      .prepare(
        `SELECT posterior_alpha, posterior_beta, last_update_ts, total_ingestions
           FROM ${this.table}
          WHERE ${this.idColumn} = ? AND source = ?`,
      )
      .get(id, source) as
      | {
          posterior_alpha: number;
          posterior_beta: number;
          last_update_ts: number;
          total_ingestions: number;
        }
      | undefined;

    if (!existing) {
      // Première observation : on crée la row au prior flat + deltas.
      this.db
        .prepare(
          `INSERT INTO ${this.table}
             (${this.idColumn}, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          source,
          DEFAULT_PRIOR_ALPHA + successDelta,
          DEFAULT_PRIOR_BETA + failureDelta,
          nowSec,
          1,
        );
      return;
    }

    // Row existante : décroissance jusqu'à nowSec, puis addition des deltas.
    const decayed = decayPosterior(
      existing.posterior_alpha,
      existing.posterior_beta,
      existing.last_update_ts,
      nowSec,
    );
    const newAlpha = decayed.alpha + successDelta;
    const newBeta = decayed.beta + failureDelta;

    this.db
      .prepare(
        `UPDATE ${this.table}
            SET posterior_alpha = ?,
                posterior_beta = ?,
                last_update_ts = ?,
                total_ingestions = total_ingestions + 1
          WHERE ${this.idColumn} = ? AND source = ?`,
      )
      .run(newAlpha, newBeta, nowSec, id, source);
  }

  /** Lit la row stockée (sans décroissance). */
  findStored(id: string, source: BayesianSource): StreamingPosterior | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.table}
          WHERE ${this.idColumn} = ? AND source = ?`,
      )
      .get(id, source) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row[this.idColumn] as string,
      source: row.source as BayesianSource,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      lastUpdateTs: row.last_update_ts as number,
      totalIngestions: row.total_ingestions as number,
    };
  }

  /** Lit l'état décayé à `atTs` pour une (id, source). Renvoie le prior flat
   *  si aucune observation n'a jamais été ingérée (nObsEffective = 0). */
  readDecayed(id: string, source: BayesianSource, atTs: number): DecayedPosterior {
    const stored = this.findStored(id, source);
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
  readAllSourcesDecayed(id: string, atTs: number): Record<BayesianSource, DecayedPosterior> {
    return {
      probe: this.readDecayed(id, 'probe', atTs),
      report: this.readDecayed(id, 'report', atTs),
      paid: this.readDecayed(id, 'paid', atTs),
    };
  }

  /** Purge les rows dont la dernière mise à jour est plus ancienne que
   *  `olderThanSec`. Suppression pure (pas de décroissance à zéro) car une
   *  row "dormante" a de toute façon un nObsEffective négligeable. */
  pruneStale(olderThanSec: number): number {
    const res = this.db
      .prepare(`DELETE FROM ${this.table} WHERE last_update_ts < ?`)
      .run(olderThanSec);
    return Number(res.changes ?? 0);
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
  constructor(private db: Database.Database) {}

  ingest(
    routeHash: string,
    callerHash: string,
    targetHash: string,
    source: BayesianSource,
    deltas: StreamingIngestDeltas,
  ): void {
    const { successDelta, failureDelta, nowSec } = deltas;

    const existing = this.db
      .prepare(
        `SELECT posterior_alpha, posterior_beta, last_update_ts, total_ingestions
           FROM route_streaming_posteriors
          WHERE route_hash = ? AND source = ?`,
      )
      .get(routeHash, source) as
      | {
          posterior_alpha: number;
          posterior_beta: number;
          last_update_ts: number;
          total_ingestions: number;
        }
      | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO route_streaming_posteriors
             (route_hash, source, caller_hash, target_hash,
              posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          routeHash,
          source,
          callerHash,
          targetHash,
          DEFAULT_PRIOR_ALPHA + successDelta,
          DEFAULT_PRIOR_BETA + failureDelta,
          nowSec,
          1,
        );
      return;
    }

    const decayed = decayPosterior(
      existing.posterior_alpha,
      existing.posterior_beta,
      existing.last_update_ts,
      nowSec,
    );

    this.db
      .prepare(
        `UPDATE route_streaming_posteriors
            SET posterior_alpha = ?,
                posterior_beta = ?,
                last_update_ts = ?,
                total_ingestions = total_ingestions + 1
          WHERE route_hash = ? AND source = ?`,
      )
      .run(
        decayed.alpha + successDelta,
        decayed.beta + failureDelta,
        nowSec,
        routeHash,
        source,
      );
  }

  findStored(routeHash: string, source: BayesianSource): (StreamingPosterior & { callerHash: string; targetHash: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM route_streaming_posteriors
          WHERE route_hash = ? AND source = ?`,
      )
      .get(routeHash, source) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.route_hash as string,
      source: row.source as BayesianSource,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      lastUpdateTs: row.last_update_ts as number,
      totalIngestions: row.total_ingestions as number,
      callerHash: row.caller_hash as string,
      targetHash: row.target_hash as string,
    };
  }

  readDecayed(routeHash: string, source: BayesianSource, atTs: number): DecayedPosterior {
    const stored = this.findStored(routeHash, source);
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

  readAllSourcesDecayed(routeHash: string, atTs: number): Record<BayesianSource, DecayedPosterior> {
    return {
      probe: this.readDecayed(routeHash, 'probe', atTs),
      report: this.readDecayed(routeHash, 'report', atTs),
      paid: this.readDecayed(routeHash, 'paid', atTs),
    };
  }

  pruneStale(olderThanSec: number): number {
    const res = this.db
      .prepare(`DELETE FROM route_streaming_posteriors WHERE last_update_ts < ?`)
      .run(olderThanSec);
    return Number(res.changes ?? 0);
  }
}
