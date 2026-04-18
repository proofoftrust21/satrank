// Data access pour les 5 tables *_aggregates (Phase 3 bayesian).
// Chaque table partage la forme (id, window, n_success, n_failure, n_obs,
// posterior_alpha, posterior_beta, updated_at) + colonnes spécifiques.
// node_aggregates est particulière : deux posteriors (routing + delivery)
// et un schéma de colonnes distinct.
//
// Les repositories exposent :
//   - upsert(key, window, deltas) : incrémente les compteurs et recalcule
//     α/β selon Beta-Binomial. Atomique via `ON CONFLICT` SQLite.
//   - findOne(key, window) : lit la ligne pour une fenêtre précise.
//   - findAll(window) : balaye toute la table filtrée par fenêtre.
//   - findByIds(keys, window) : batch N lignes en un seul SELECT.
//
// Le prior initial (posterior_alpha=1.5, posterior_beta=1.5) est géré par
// le DEFAULT SQL de la colonne — aucun besoin de l'injecter côté TS.

import type Database from 'better-sqlite3';
import type { BayesianWindow } from '../config/bayesianConfig';
import { DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA } from '../config/bayesianConfig';

export interface AggregateDeltas {
  /** Incrément pondéré de succès. Peut être 0. */
  successDelta: number;
  /** Incrément pondéré d'échec. Peut être 0. */
  failureDelta: number;
  /** Timestamp unix de la mise à jour. */
  updatedAt: number;
}

/** Forme commune à endpoint/service/operator/route aggregates. */
export interface SimpleAggregate {
  id: string;
  window: BayesianWindow;
  nSuccess: number;
  nFailure: number;
  nObs: number;
  posteriorAlpha: number;
  posteriorBeta: number;
  updatedAt: number;
}

export interface EndpointAggregate extends SimpleAggregate {
  medianLatencyMs: number | null;
  medianPriceMsat: number | null;
}

export interface NodeAggregate {
  pubkey: string;
  window: BayesianWindow;
  nObservations: number;
  nRoutable: number;
  nDelivered: number;
  nReportedSuccess: number;
  nReportedFailure: number;
  routingAlpha: number;
  routingBeta: number;
  deliveryAlpha: number;
  deliveryBeta: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Base class : comportement commun aux 4 tables simples (endpoint/service/operator/route).
// ---------------------------------------------------------------------------

abstract class SimpleAggregateRepository<T extends SimpleAggregate> {
  protected abstract table: string;
  protected abstract idColumn: string;

  constructor(protected db: Database.Database) {}

  /** Incrémente les compteurs et recalcule α/β via la conjugaison Beta-Binomial.
   *  α_new = α_old + successDelta, β_new = β_old + failureDelta. À la création,
   *  α_old = β_old = 1.5 (DEFAULT de la colonne). */
  upsert(id: string, window: BayesianWindow, deltas: AggregateDeltas): void {
    const { successDelta, failureDelta, updatedAt } = deltas;
    // INSERT OR IGNORE crée la ligne avec les DEFAULTS (α=β=1.5), puis UPDATE
    // applique les deltas. Deux requêtes mais dans la même transaction côté
    // caller (voir TransactionHookService en C8).
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.table} (${this.idColumn}, window, updated_at) VALUES (?, ?, ?)`,
      )
      .run(id, window, updatedAt);
    this.db
      .prepare(
        `UPDATE ${this.table}
           SET n_success = n_success + ?,
               n_failure = n_failure + ?,
               n_obs = n_obs + ?,
               posterior_alpha = posterior_alpha + ?,
               posterior_beta = posterior_beta + ?,
               updated_at = ?
         WHERE ${this.idColumn} = ? AND window = ?`,
      )
      .run(
        successDelta,
        failureDelta,
        successDelta + failureDelta,
        successDelta,
        failureDelta,
        updatedAt,
        id,
        window,
      );
  }

  findOne(id: string, window: BayesianWindow): T | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.table} WHERE ${this.idColumn} = ? AND window = ?`,
      )
      .get(id, window) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  findAll(window: BayesianWindow): T[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE window = ?`)
      .all(window) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  findByIds(ids: readonly string[], window: BayesianWindow): T[] {
    if (ids.length === 0) return [];
    if (ids.length > 500) throw new Error('findByIds: array exceeds 500 elements');
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.table}
          WHERE ${this.idColumn} IN (${placeholders}) AND window = ?`,
      )
      .all(...ids, window) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Purge les lignes non mises à jour depuis `olderThanSec` — utilisé par la rétention. */
  pruneStale(olderThanSec: number): number {
    const res = this.db
      .prepare(`DELETE FROM ${this.table} WHERE updated_at < ?`)
      .run(olderThanSec);
    return Number(res.changes ?? 0);
  }

  protected abstract mapRow(row: Record<string, unknown>): T;
}

// ---------------------------------------------------------------------------
// Repositories concrets
// ---------------------------------------------------------------------------

export class EndpointAggregateRepository extends SimpleAggregateRepository<EndpointAggregate> {
  protected table = 'endpoint_aggregates';
  protected idColumn = 'url_hash';

  protected mapRow(row: Record<string, unknown>): EndpointAggregate {
    return {
      id: row.url_hash as string,
      window: row.window as BayesianWindow,
      nSuccess: row.n_success as number,
      nFailure: row.n_failure as number,
      nObs: row.n_obs as number,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      medianLatencyMs: (row.median_latency_ms as number | null) ?? null,
      medianPriceMsat: (row.median_price_msat as number | null) ?? null,
      updatedAt: row.updated_at as number,
    };
  }

  /** Met à jour les médianes de latence et prix (calculé périodiquement, pas à chaque INSERT). */
  updateMedians(urlHash: string, window: BayesianWindow, latencyMs: number | null, priceMsat: number | null, updatedAt: number): void {
    this.db
      .prepare(
        `UPDATE endpoint_aggregates
           SET median_latency_ms = ?, median_price_msat = ?, updated_at = ?
         WHERE url_hash = ? AND window = ?`,
      )
      .run(latencyMs, priceMsat, updatedAt, urlHash, window);
  }
}

export class ServiceAggregateRepository extends SimpleAggregateRepository<SimpleAggregate> {
  protected table = 'service_aggregates';
  protected idColumn = 'service_hash';

  protected mapRow(row: Record<string, unknown>): SimpleAggregate {
    return {
      id: row.service_hash as string,
      window: row.window as BayesianWindow,
      nSuccess: row.n_success as number,
      nFailure: row.n_failure as number,
      nObs: row.n_obs as number,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class OperatorAggregateRepository extends SimpleAggregateRepository<SimpleAggregate> {
  protected table = 'operator_aggregates';
  protected idColumn = 'operator_id';

  protected mapRow(row: Record<string, unknown>): SimpleAggregate {
    return {
      id: row.operator_id as string,
      window: row.window as BayesianWindow,
      nSuccess: row.n_success as number,
      nFailure: row.n_failure as number,
      nObs: row.n_obs as number,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class RouteAggregateRepository extends SimpleAggregateRepository<SimpleAggregate & { callerHash: string; targetHash: string }> {
  protected table = 'route_aggregates';
  protected idColumn = 'route_hash';

  /** upsert custom pour route_aggregates : on stocke aussi caller_hash et target_hash à la création. */
  upsertRoute(routeHash: string, callerHash: string, targetHash: string, window: BayesianWindow, deltas: AggregateDeltas): void {
    const { successDelta, failureDelta, updatedAt } = deltas;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO route_aggregates (route_hash, window, caller_hash, target_hash, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(routeHash, window, callerHash, targetHash, updatedAt);
    this.db
      .prepare(
        `UPDATE route_aggregates
           SET n_success = n_success + ?,
               n_failure = n_failure + ?,
               n_obs = n_obs + ?,
               posterior_alpha = posterior_alpha + ?,
               posterior_beta = posterior_beta + ?,
               updated_at = ?
         WHERE route_hash = ? AND window = ?`,
      )
      .run(successDelta, failureDelta, successDelta + failureDelta, successDelta, failureDelta, updatedAt, routeHash, window);
  }

  protected mapRow(row: Record<string, unknown>): SimpleAggregate & { callerHash: string; targetHash: string } {
    return {
      id: row.route_hash as string,
      window: row.window as BayesianWindow,
      callerHash: row.caller_hash as string,
      targetHash: row.target_hash as string,
      nSuccess: row.n_success as number,
      nFailure: row.n_failure as number,
      nObs: row.n_obs as number,
      posteriorAlpha: row.posterior_alpha as number,
      posteriorBeta: row.posterior_beta as number,
      updatedAt: row.updated_at as number,
    };
  }
}

// ---------------------------------------------------------------------------
// node_aggregates — posteriors duaux (routing + delivery)
// ---------------------------------------------------------------------------

export interface NodeDeltas {
  routableDelta: number;
  deliveredDelta: number;
  reportedSuccessDelta: number;
  reportedFailureDelta: number;
  updatedAt: number;
}

export class NodeAggregateRepository {
  constructor(private db: Database.Database) {}

  upsert(pubkey: string, window: BayesianWindow, deltas: NodeDeltas): void {
    const { routableDelta, deliveredDelta, reportedSuccessDelta, reportedFailureDelta, updatedAt } = deltas;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO node_aggregates (pubkey, window, updated_at) VALUES (?, ?, ?)`,
      )
      .run(pubkey, window, updatedAt);
    // Routing posterior : routable=success, (observations-routable)=failure.
    // Delivery posterior : delivered/reported_success=success, reported_failure=failure.
    // n_observations = somme de probe attempts (routable attempts).
    const failureRouting = Math.max(0, routableDelta); // simplification : on ne track pas les route-attempts échoués séparément ici
    this.db
      .prepare(
        `UPDATE node_aggregates
           SET n_observations = n_observations + ?,
               n_routable = n_routable + ?,
               n_delivered = n_delivered + ?,
               n_reported_success = n_reported_success + ?,
               n_reported_failure = n_reported_failure + ?,
               routing_alpha = routing_alpha + ?,
               routing_beta = routing_beta + ?,
               delivery_alpha = delivery_alpha + ?,
               delivery_beta = delivery_beta + ?,
               updated_at = ?
         WHERE pubkey = ? AND window = ?`,
      )
      .run(
        routableDelta + reportedSuccessDelta + reportedFailureDelta,
        routableDelta,
        deliveredDelta,
        reportedSuccessDelta,
        reportedFailureDelta,
        routableDelta, // α routing += succès routage
        Math.max(0, 0), // β routing : incrémenté séparément via upsertRoutingFailure
        deliveredDelta + reportedSuccessDelta, // α delivery
        reportedFailureDelta, // β delivery
        updatedAt,
        pubkey,
        window,
      );
  }

  /** Appelé quand une tentative de routage échoue (nœud non-routable). */
  upsertRoutingFailure(pubkey: string, window: BayesianWindow, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO node_aggregates (pubkey, window, updated_at) VALUES (?, ?, ?)`,
      )
      .run(pubkey, window, updatedAt);
    this.db
      .prepare(
        `UPDATE node_aggregates
           SET n_observations = n_observations + 1,
               routing_beta = routing_beta + 1,
               updated_at = ?
         WHERE pubkey = ? AND window = ?`,
      )
      .run(updatedAt, pubkey, window);
  }

  findOne(pubkey: string, window: BayesianWindow): NodeAggregate | undefined {
    const row = this.db
      .prepare('SELECT * FROM node_aggregates WHERE pubkey = ? AND window = ?')
      .get(pubkey, window) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  findAll(window: BayesianWindow): NodeAggregate[] {
    const rows = this.db
      .prepare('SELECT * FROM node_aggregates WHERE window = ?')
      .all(window) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  pruneStale(olderThanSec: number): number {
    const res = this.db.prepare('DELETE FROM node_aggregates WHERE updated_at < ?').run(olderThanSec);
    return Number(res.changes ?? 0);
  }

  private mapRow(row: Record<string, unknown>): NodeAggregate {
    return {
      pubkey: row.pubkey as string,
      window: row.window as BayesianWindow,
      nObservations: row.n_observations as number,
      nRoutable: row.n_routable as number,
      nDelivered: row.n_delivered as number,
      nReportedSuccess: row.n_reported_success as number,
      nReportedFailure: row.n_reported_failure as number,
      routingAlpha: row.routing_alpha as number,
      routingBeta: row.routing_beta as number,
      deliveryAlpha: row.delivery_alpha as number,
      deliveryBeta: row.delivery_beta as number,
      updatedAt: row.updated_at as number,
    };
  }
}

/** Constantes exposées pour tests / vérifications de cohérence. */
export const AGGREGATE_DEFAULT_PRIOR = {
  alpha: DEFAULT_PRIOR_ALPHA,
  beta: DEFAULT_PRIOR_BETA,
} as const;
