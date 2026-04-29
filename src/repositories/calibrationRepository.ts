// Phase 5.15 — calibration repository.
//
// Fournit les queries pour reconstruire les fenêtres temporelles de la
// calibration cron. La complexité est gardée côté SQL (filtrage par
// observed_at, aggregation par endpoint+stage) ; le service consomme les
// résultats brut et fait le calcul Bayesian.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface OutcomesAggregate {
  endpoint_url_hash: string;
  stage: number;
  /** Nombre d'observations dans la fenêtre. */
  n_obs: number;
  /** Somme des poids des success. */
  weighted_successes: number;
  /** Somme des poids totaux (success + failures). */
  weighted_total: number;
}

export interface CalibrationRunRecord {
  window_start: number;
  window_end: number;
  delta_mean: number | null;
  delta_median: number | null;
  delta_p95: number | null;
  n_endpoints: number;
  n_outcomes: number;
  published_event_id: string | null;
  created_at: number;
}

export class CalibrationRepository {
  constructor(private readonly db: Queryable) {}

  /** Outcomes observed dans la fenêtre [windowStart, windowEnd). Aggregé par
   *  (endpoint, stage). Filtre minObs >= seuil pour ne retourner que les
   *  endpoints avec assez de données dans la fenêtre. Stage est inclus dans
   *  le SELECT pour calculer la calibration par-stage. */
  async findOutcomesInWindow(
    windowStart: number,
    windowEnd: number,
    minObs: number,
  ): Promise<OutcomesAggregate[]> {
    const { rows } = await this.db.query<{
      endpoint_url_hash: string;
      stage: number;
      n_obs: string;
      weighted_successes: string;
      weighted_total: string;
    }>(
      `SELECT
         endpoint_url_hash,
         stage,
         COUNT(*) AS n_obs,
         SUM(CASE WHEN success THEN weight ELSE 0 END) AS weighted_successes,
         SUM(weight) AS weighted_total
       FROM endpoint_stage_outcomes_log
       WHERE observed_at >= $1::bigint AND observed_at < $2::bigint
       GROUP BY endpoint_url_hash, stage
       HAVING COUNT(*) >= $3::int`,
      [windowStart, windowEnd, minObs],
    );
    return rows.map((r) => ({
      endpoint_url_hash: r.endpoint_url_hash,
      stage: r.stage,
      n_obs: Number(r.n_obs),
      weighted_successes: Number(r.weighted_successes),
      weighted_total: Number(r.weighted_total),
    }));
  }

  /** Aggregate des outcomes AVANT windowStart pour reconstruire le posterior
   *  en début de fenêtre. Pondération sans décroissance pour MVP — la
   *  décroissance exponentielle τ=7d est appliquée côté service via le
   *  timestamp moyen des outcomes. Caller passe la liste des (endpoint,
   *  stage) à hydrater (filtre la requête).
   *
   *  Retourne aussi le timestamp moyen des outcomes pour permettre le decay
   *  weighting côté service. */
  async findHistoryBeforeWindow(
    targetEndpointStages: Array<{ endpoint_url_hash: string; stage: number }>,
    windowStart: number,
  ): Promise<Array<OutcomesAggregate & { mean_observed_at: number | null }>> {
    if (targetEndpointStages.length === 0) return [];
    // Pas d'IN sur tuples Postgres-friendly — on construit deux arrays parallèles.
    const hashes = targetEndpointStages.map((t) => t.endpoint_url_hash);
    const stages = targetEndpointStages.map((t) => t.stage);
    const { rows } = await this.db.query<{
      endpoint_url_hash: string;
      stage: number;
      n_obs: string;
      weighted_successes: string;
      weighted_total: string;
      mean_observed_at: string | null;
    }>(
      `SELECT
         endpoint_url_hash,
         stage,
         COUNT(*) AS n_obs,
         SUM(CASE WHEN success THEN weight ELSE 0 END) AS weighted_successes,
         SUM(weight) AS weighted_total,
         AVG(observed_at)::bigint AS mean_observed_at
       FROM endpoint_stage_outcomes_log
       WHERE observed_at < $1::bigint
         AND (endpoint_url_hash, stage) IN (
           SELECT * FROM unnest($2::text[], $3::smallint[])
         )
       GROUP BY endpoint_url_hash, stage`,
      [windowStart, hashes, stages],
    );
    return rows.map((r) => ({
      endpoint_url_hash: r.endpoint_url_hash,
      stage: r.stage,
      n_obs: Number(r.n_obs),
      weighted_successes: Number(r.weighted_successes),
      weighted_total: Number(r.weighted_total),
      mean_observed_at: r.mean_observed_at ? Number(r.mean_observed_at) : null,
    }));
  }

  /** Insère un audit record pour une calibration run. */
  async insertCalibrationRun(record: CalibrationRunRecord): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO oracle_calibration_runs
         (window_start, window_end, delta_mean, delta_median, delta_p95,
          n_endpoints, n_outcomes, published_event_id, created_at)
       VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6::int, $7::int, $8, $9::bigint)
       RETURNING id`,
      [
        record.window_start,
        record.window_end,
        record.delta_mean,
        record.delta_median,
        record.delta_p95,
        record.n_endpoints,
        record.n_outcomes,
        record.published_event_id,
        record.created_at,
      ],
    );
    return rows[0].id;
  }

  /** Le run le plus récent — utilisé par la cron pour idempotence (ne pas
   *  re-publier deux fois la même semaine). */
  async findLatestRun(): Promise<CalibrationRunRecord | null> {
    const { rows } = await this.db.query<CalibrationRunRecord>(
      `SELECT window_start, window_end, delta_mean, delta_median, delta_p95,
              n_endpoints, n_outcomes, published_event_id, created_at
         FROM oracle_calibration_runs
        ORDER BY window_end DESC
        LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /** Audit 2026-04-29 fix — list our own calibration runs for the
   *  `/api/oracle/peers/<self>/calibrations` endpoint. The peer-calibrations
   *  ingestor explicitly skips self events (anti-loop), so a self lookup
   *  through PeerCalibrationRepository returns empty. This method serves
   *  the local oracle_calibration_runs table directly so the federation
   *  surface can be inspected by clients pointing at our own pubkey. */
  async listRuns(limit = 20): Promise<CalibrationRunRecord[]> {
    const { rows } = await this.db.query<CalibrationRunRecord>(
      `SELECT window_start, window_end, delta_mean, delta_median, delta_p95,
              n_endpoints, n_outcomes, published_event_id, created_at
         FROM oracle_calibration_runs
        ORDER BY window_end DESC
        LIMIT $1::int`,
      [Math.max(1, Math.min(100, limit))],
    );
    return rows;
  }
}
