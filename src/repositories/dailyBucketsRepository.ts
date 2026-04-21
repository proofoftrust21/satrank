// Data access pour les 5 tables *_daily_buckets (Phase 3 refactor; pg async port, Phase 12B).
//
// Les daily_buckets sont "display-only" : ils servent à exposer le recent_activity
// côté API (n_obs par fenêtre 24h/7d/30d) sans passer par les streaming_posteriors
// qui sont une mesure continue. Une row par (id, source, day UTC).
//
// Rétention : BUCKET_RETENTION_DAYS (=30) jours glissants, purgés par cron (C12).

import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type BucketSource = 'probe' | 'report' | 'paid';

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

  constructor(protected db: Queryable) {}

  /** Incrémente les compteurs d'une (id, source, day). Upsert atomique. */
  async bump(id: string, source: BucketSource, increment: BucketIncrement): Promise<void> {
    const { day, nObsDelta, nSuccessDelta, nFailureDelta } = increment;
    await this.db.query(
      `INSERT INTO ${this.table}
         (${this.idColumn}, source, day, n_obs, n_success, n_failure)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (${this.idColumn}, source, day) DO UPDATE SET
         n_obs = ${this.table}.n_obs + EXCLUDED.n_obs,
         n_success = ${this.table}.n_success + EXCLUDED.n_success,
         n_failure = ${this.table}.n_failure + EXCLUDED.n_failure`,
      [id, source, day, nObsDelta, nSuccessDelta, nFailureDelta],
    );
  }

  /** Lit toutes les rows d'un id (toutes sources, tous jours). */
  async findAllForId(id: string): Promise<BucketRow[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE ${this.idColumn} = $1 ORDER BY day DESC`,
      [id],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /** Compte cumulé n_obs sur les 24h, 7d, 30d derniers jours (inclusif).
   *  `atTs` est le timestamp de référence — la fenêtre est [atTs - Xd, atTs].
   *  Agrège toutes les sources. */
  async recentActivity(id: string, atTs: number): Promise<RecentActivity> {
    const atDay = dayKeyUTC(atTs);
    const day1agoKey = dayKeyUTC(atTs - 86400);
    const day7agoKey = dayKeyUTC(atTs - 7 * 86400);
    const day30agoKey = dayKeyUTC(atTs - 30 * 86400);

    const last24h = await this.sumObsBetween(id, day1agoKey, atDay);
    const last7d = await this.sumObsBetween(id, day7agoKey, atDay);
    const last30d = await this.sumObsBetween(id, day30agoKey, atDay);

    return { last_24h: last24h, last_7d: last7d, last_30d: last30d };
  }

  /** Somme n_obs sur une plage [fromDay, toDay] inclusive, toutes sources. */
  private async sumObsBetween(id: string, fromDay: string, toDay: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(n_obs), 0)::text AS total
         FROM ${this.table}
        WHERE ${this.idColumn} = $1
          AND day >= $2
          AND day <= $3`,
      [id, fromDay, toDay],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** Comptes success/failure cumulés sur [fromDay, toDay] — utilisé par
   *  riskProfile (Option B) pour calculer success_rate(récent) vs (antérieur). */
  async sumSuccessFailureBetween(id: string, fromDay: string, toDay: string): Promise<{ nSuccess: number; nFailure: number; nObs: number }> {
    const { rows } = await this.db.query<{ nsuccess: string; nfailure: string; nobs: string }>(
      `SELECT COALESCE(SUM(n_success), 0)::text AS nSuccess,
              COALESCE(SUM(n_failure), 0)::text AS nFailure,
              COALESCE(SUM(n_obs), 0)::text AS nObs
         FROM ${this.table}
        WHERE ${this.idColumn} = $1
          AND day >= $2
          AND day <= $3`,
      [id, fromDay, toDay],
    );
    const row = rows[0];
    return {
      nSuccess: Number(row?.nsuccess ?? 0),
      nFailure: Number(row?.nfailure ?? 0),
      nObs: Number(row?.nobs ?? 0),
    };
  }

  /** Purge les rows plus vieilles que `retentionDays`. Clé par jour UTC. */
  async pruneOlderThan(beforeDay: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE day < $1`,
      [beforeDay],
    );
    return result.rowCount ?? 0;
  }

  protected mapRow(row: Record<string, unknown>): BucketRow {
    return {
      id: row[this.idColumn] as string,
      source: row.source as BucketSource,
      day: row.day as string,
      nObs: Number(row.n_obs),
      nSuccess: Number(row.n_success),
      nFailure: Number(row.n_failure),
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
  constructor(private db: Queryable) {}

  async bump(
    routeHash: string,
    callerHash: string,
    targetHash: string,
    source: BucketSource,
    increment: BucketIncrement,
  ): Promise<void> {
    const { day, nObsDelta, nSuccessDelta, nFailureDelta } = increment;
    await this.db.query(
      `INSERT INTO route_daily_buckets
         (route_hash, source, day, caller_hash, target_hash, n_obs, n_success, n_failure)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (route_hash, source, day) DO UPDATE SET
         n_obs = route_daily_buckets.n_obs + EXCLUDED.n_obs,
         n_success = route_daily_buckets.n_success + EXCLUDED.n_success,
         n_failure = route_daily_buckets.n_failure + EXCLUDED.n_failure`,
      [routeHash, source, day, callerHash, targetHash, nObsDelta, nSuccessDelta, nFailureDelta],
    );
  }

  async findAllForId(routeHash: string): Promise<(BucketRow & { callerHash: string; targetHash: string })[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM route_daily_buckets WHERE route_hash = $1 ORDER BY day DESC',
      [routeHash],
    );
    return rows.map((r) => ({
      id: r.route_hash as string,
      source: r.source as BucketSource,
      day: r.day as string,
      nObs: Number(r.n_obs),
      nSuccess: Number(r.n_success),
      nFailure: Number(r.n_failure),
      callerHash: r.caller_hash as string,
      targetHash: r.target_hash as string,
    }));
  }

  async recentActivity(routeHash: string, atTs: number): Promise<RecentActivity> {
    const atDay = dayKeyUTC(atTs);
    const day1agoKey = dayKeyUTC(atTs - 86400);
    const day7agoKey = dayKeyUTC(atTs - 7 * 86400);
    const day30agoKey = dayKeyUTC(atTs - 30 * 86400);

    const sum = async (from: string, to: string): Promise<number> => {
      const { rows } = await this.db.query<{ total: string }>(
        `SELECT COALESCE(SUM(n_obs), 0)::text AS total
           FROM route_daily_buckets
          WHERE route_hash = $1 AND day >= $2 AND day <= $3`,
        [routeHash, from, to],
      );
      return Number(rows[0]?.total ?? 0);
    };

    return {
      last_24h: await sum(day1agoKey, atDay),
      last_7d: await sum(day7agoKey, atDay),
      last_30d: await sum(day30agoKey, atDay),
    };
  }

  async sumSuccessFailureBetween(routeHash: string, fromDay: string, toDay: string): Promise<{ nSuccess: number; nFailure: number; nObs: number }> {
    const { rows } = await this.db.query<{ nsuccess: string; nfailure: string; nobs: string }>(
      `SELECT COALESCE(SUM(n_success), 0)::text AS nSuccess,
              COALESCE(SUM(n_failure), 0)::text AS nFailure,
              COALESCE(SUM(n_obs), 0)::text AS nObs
         FROM route_daily_buckets
        WHERE route_hash = $1 AND day >= $2 AND day <= $3`,
      [routeHash, fromDay, toDay],
    );
    const row = rows[0];
    return {
      nSuccess: Number(row?.nsuccess ?? 0),
      nFailure: Number(row?.nfailure ?? 0),
      nObs: Number(row?.nobs ?? 0),
    };
  }

  async pruneOlderThan(beforeDay: string): Promise<number> {
    const result = await this.db.query(
      'DELETE FROM route_daily_buckets WHERE day < $1',
      [beforeDay],
    );
    return result.rowCount ?? 0;
  }
}
