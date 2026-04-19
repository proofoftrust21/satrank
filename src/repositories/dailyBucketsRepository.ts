// Data access pour les 5 tables *_daily_buckets (Phase 3 refactor).
//
// Les daily_buckets sont "display-only" : ils servent à exposer le recent_activity
// côté API (n_obs par fenêtre 24h/7d/30d) sans passer par les streaming_posteriors
// qui sont une mesure continue. Une row par (id, source, day UTC). L'observer
// est autorisé ici (contrat Q3) — l'activité visible inclut la présence
// des reports et probes passives, même si elle n'alimente pas le verdict.
//
// Rétention : BUCKET_RETENTION_DAYS (=30) jours glissants, purgés par cron (C12).

import type Database from 'better-sqlite3';

export type BucketSource = 'probe' | 'report' | 'paid' | 'observer';

export interface BucketIncrement {
  /** Jour UTC au format 'YYYY-MM-DD'. */
  day: string;
  nObsDelta: number;
  nSuccessDelta: number;
  nFailureDelta: number;
}

export interface BucketRow {
  id: string;
  source: BucketSource;
  day: string;
  nObs: number;
  nSuccess: number;
  nFailure: number;
}

/** Résumé cumulé sur une fenêtre glissante (24h/7d/30d). Le verdict/API lit ceci. */
export interface RecentActivity {
  last_24h: number;
  last_7d: number;
  last_30d: number;
}

/** Convertit un timestamp unix en clé jour UTC 'YYYY-MM-DD'. */
export function dayKeyUTC(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

abstract class BaseDailyBucketsRepository {
  protected abstract table: string;
  protected abstract idColumn: string;

  constructor(protected db: Database.Database) {}

  /** Incrémente les compteurs d'une (id, source, day). Upsert atomique. */
  bump(id: string, source: BucketSource, increment: BucketIncrement): void {
    const { day, nObsDelta, nSuccessDelta, nFailureDelta } = increment;
    this.db
      .prepare(
        `INSERT INTO ${this.table}
           (${this.idColumn}, source, day, n_obs, n_success, n_failure)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(${this.idColumn}, source, day) DO UPDATE SET
           n_obs = n_obs + excluded.n_obs,
           n_success = n_success + excluded.n_success,
           n_failure = n_failure + excluded.n_failure`,
      )
      .run(id, source, day, nObsDelta, nSuccessDelta, nFailureDelta);
  }

  /** Lit toutes les rows d'un id (toutes sources, tous jours). */
  findAllForId(id: string): BucketRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.table} WHERE ${this.idColumn} = ? ORDER BY day DESC`,
      )
      .all(id) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Compte cumulé n_obs sur les 24h, 7d, 30d derniers jours (inclusif).
   *  `atTs` est le timestamp de référence — la fenêtre est [atTs - Xd, atTs].
   *  Agrège toutes les sources (observer inclus). */
  recentActivity(id: string, atTs: number): RecentActivity {
    const atDay = dayKeyUTC(atTs);
    const day1agoKey = dayKeyUTC(atTs - 86400);
    const day7agoKey = dayKeyUTC(atTs - 7 * 86400);
    const day30agoKey = dayKeyUTC(atTs - 30 * 86400);

    const last24h = this.sumObsBetween(id, day1agoKey, atDay);
    const last7d = this.sumObsBetween(id, day7agoKey, atDay);
    const last30d = this.sumObsBetween(id, day30agoKey, atDay);

    return { last_24h: last24h, last_7d: last7d, last_30d: last30d };
  }

  /** Somme n_obs sur une plage [fromDay, toDay] inclusive, toutes sources. */
  private sumObsBetween(id: string, fromDay: string, toDay: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(n_obs), 0) AS total
           FROM ${this.table}
          WHERE ${this.idColumn} = ?
            AND day >= ?
            AND day <= ?`,
      )
      .get(id, fromDay, toDay) as { total: number };
    return row.total;
  }

  /** Comptes success/failure cumulés sur [fromDay, toDay] — utilisé par
   *  riskProfile (Option B) pour calculer success_rate(récent) vs (antérieur). */
  sumSuccessFailureBetween(id: string, fromDay: string, toDay: string): { nSuccess: number; nFailure: number; nObs: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(n_success), 0) AS nSuccess,
                COALESCE(SUM(n_failure), 0) AS nFailure,
                COALESCE(SUM(n_obs), 0) AS nObs
           FROM ${this.table}
          WHERE ${this.idColumn} = ?
            AND day >= ?
            AND day <= ?`,
      )
      .get(id, fromDay, toDay) as { nSuccess: number; nFailure: number; nObs: number };
    return row;
  }

  /** Purge les rows plus vieilles que `retentionDays`. Clé par jour UTC. */
  pruneOlderThan(beforeDay: string): number {
    const res = this.db
      .prepare(`DELETE FROM ${this.table} WHERE day < ?`)
      .run(beforeDay);
    return Number(res.changes ?? 0);
  }

  protected mapRow(row: Record<string, unknown>): BucketRow {
    return {
      id: row[this.idColumn] as string,
      source: row.source as BucketSource,
      day: row.day as string,
      nObs: row.n_obs as number,
      nSuccess: row.n_success as number,
      nFailure: row.n_failure as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Repositories concrets
// ---------------------------------------------------------------------------

export class EndpointDailyBucketsRepository extends BaseDailyBucketsRepository {
  protected table = 'endpoint_daily_buckets';
  protected idColumn = 'url_hash';
}

export class NodeDailyBucketsRepository extends BaseDailyBucketsRepository {
  protected table = 'node_daily_buckets';
  protected idColumn = 'pubkey';
}

export class ServiceDailyBucketsRepository extends BaseDailyBucketsRepository {
  protected table = 'service_daily_buckets';
  protected idColumn = 'service_hash';
}

export class OperatorDailyBucketsRepository extends BaseDailyBucketsRepository {
  protected table = 'operator_daily_buckets';
  protected idColumn = 'operator_id';
}

// Route a besoin de caller_hash + target_hash à la création.
export class RouteDailyBucketsRepository {
  constructor(private db: Database.Database) {}

  bump(
    routeHash: string,
    callerHash: string,
    targetHash: string,
    source: BucketSource,
    increment: BucketIncrement,
  ): void {
    const { day, nObsDelta, nSuccessDelta, nFailureDelta } = increment;
    this.db
      .prepare(
        `INSERT INTO route_daily_buckets
           (route_hash, source, day, caller_hash, target_hash, n_obs, n_success, n_failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(route_hash, source, day) DO UPDATE SET
           n_obs = n_obs + excluded.n_obs,
           n_success = n_success + excluded.n_success,
           n_failure = n_failure + excluded.n_failure`,
      )
      .run(routeHash, source, day, callerHash, targetHash, nObsDelta, nSuccessDelta, nFailureDelta);
  }

  findAllForId(routeHash: string): (BucketRow & { callerHash: string; targetHash: string })[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM route_daily_buckets WHERE route_hash = ? ORDER BY day DESC`,
      )
      .all(routeHash) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.route_hash as string,
      source: r.source as BucketSource,
      day: r.day as string,
      nObs: r.n_obs as number,
      nSuccess: r.n_success as number,
      nFailure: r.n_failure as number,
      callerHash: r.caller_hash as string,
      targetHash: r.target_hash as string,
    }));
  }

  recentActivity(routeHash: string, atTs: number): RecentActivity {
    const atDay = dayKeyUTC(atTs);
    const day1agoKey = dayKeyUTC(atTs - 86400);
    const day7agoKey = dayKeyUTC(atTs - 7 * 86400);
    const day30agoKey = dayKeyUTC(atTs - 30 * 86400);

    const sum = (from: string, to: string): number => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(n_obs), 0) AS total
             FROM route_daily_buckets
            WHERE route_hash = ? AND day >= ? AND day <= ?`,
        )
        .get(routeHash, from, to) as { total: number };
      return row.total;
    };

    return {
      last_24h: sum(day1agoKey, atDay),
      last_7d: sum(day7agoKey, atDay),
      last_30d: sum(day30agoKey, atDay),
    };
  }

  sumSuccessFailureBetween(routeHash: string, fromDay: string, toDay: string): { nSuccess: number; nFailure: number; nObs: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(n_success), 0) AS nSuccess,
                COALESCE(SUM(n_failure), 0) AS nFailure,
                COALESCE(SUM(n_obs), 0) AS nObs
           FROM route_daily_buckets
          WHERE route_hash = ? AND day >= ? AND day <= ?`,
      )
      .get(routeHash, fromDay, toDay) as { nSuccess: number; nFailure: number; nObs: number };
    return row;
  }

  pruneOlderThan(beforeDay: string): number {
    const res = this.db
      .prepare(`DELETE FROM route_daily_buckets WHERE day < ?`)
      .run(beforeDay);
    return Number(res.changes ?? 0);
  }
}
