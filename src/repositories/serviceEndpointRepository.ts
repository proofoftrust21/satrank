// Repository for HTTP service endpoint health tracking (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import { endpointHash } from '../utils/urlCanonical';

type Queryable = Pool | PoolClient;

export type ServiceSource = '402index' | 'self_registered' | 'ad_hoc';

/** Sources trusted enough to influence the 3D ranking composite.
 *  ad_hoc entries (observed from /api/decide serviceUrl) stay in DB for later
 *  validation but are filtered out of ranking and discovery queries. */
export const TRUSTED_SOURCES: ServiceSource[] = ['402index', 'self_registered'];

export interface ServiceEndpoint {
  id: number;
  agent_hash: string | null;
  url: string;
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_checked_at: number | null;
  check_count: number;
  success_count: number;
  created_at: number;
  service_price_sats: number | null;
  name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
  source: ServiceSource;
}

export interface ServiceMetadata {
  name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
}

export interface ServiceSearchFilters {
  q?: string;
  category?: string;
  minUptime?: number;
  /** SQL-level sort axis. `activity` is the default (ORDER BY check_count DESC).
   *  `p_success` sort is delegated to the controller (requires per-row agent
   *  lookup, so it's a post-filter re-sort in JS). */
  sort?: 'p_success' | 'activity' | 'price' | 'uptime';
  limit?: number;
  offset?: number;
}

export class ServiceEndpointRepository {
  constructor(private db: Queryable) {}

  async upsert(agentHash: string | null, url: string, httpStatus: number, latencyMs: number, source: ServiceSource = 'ad_hoc'): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const isSuccess = (httpStatus >= 200 && httpStatus < 400) || httpStatus === 402;
    // Upsert with source trust hierarchy: on conflict, keep the highest-trust source
    // (402index > self_registered > ad_hoc). Never downgrade.
    await this.db.query(
      `
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at, source)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
      ON CONFLICT (url) DO UPDATE SET
        agent_hash = COALESCE(EXCLUDED.agent_hash, service_endpoints.agent_hash),
        last_http_status = EXCLUDED.last_http_status,
        last_latency_ms = EXCLUDED.last_latency_ms,
        last_checked_at = EXCLUDED.last_checked_at,
        check_count = service_endpoints.check_count + 1,
        success_count = service_endpoints.success_count + EXCLUDED.success_count,
        source = CASE
          WHEN service_endpoints.source = '402index' OR EXCLUDED.source = '402index' THEN '402index'
          WHEN service_endpoints.source = 'self_registered' OR EXCLUDED.source = 'self_registered' THEN 'self_registered'
          ELSE 'ad_hoc'
        END
      `,
      [agentHash, url, httpStatus, latencyMs, now, isSuccess ? 1 : 0, now, source],
    );
  }

  /** Distribution of entries per source — used by /api/health for observability. */
  async countBySource(): Promise<Record<ServiceSource, number>> {
    const { rows } = await this.db.query<{ source: ServiceSource; c: string }>(
      'SELECT source, COUNT(*)::text as c FROM service_endpoints GROUP BY source',
    );
    const out: Record<ServiceSource, number> = { '402index': 0, 'self_registered': 0, 'ad_hoc': 0 };
    for (const r of rows) out[r.source] = Number(r.c);
    return out;
  }

  async findByUrl(url: string): Promise<ServiceEndpoint | undefined> {
    const { rows } = await this.db.query<ServiceEndpoint>(
      'SELECT * FROM service_endpoints WHERE url = $1',
      [url],
    );
    return rows[0];
  }

  /** Best-effort metadata lookup by url_hash (sha256 of canonicalized URL).
   *  Postgres has no native sha256 helper matching our canonicalization, and
   *  `service_endpoints` stores only the literal URL, so we scan trusted rows
   *  and compare hashes in-process. The table is small (low thousands at most
   *  today) so the O(N) scan is fine for a detail view. A dedicated column /
   *  index can be added in a later migration if this endpoint ever gets hot. */
  async findByUrlHash(urlHash: string): Promise<ServiceEndpoint | undefined> {
    const { rows } = await this.db.query<ServiceEndpoint>(
      "SELECT * FROM service_endpoints WHERE source IN ('402index', 'self_registered')",
    );
    for (const row of rows) {
      try {
        if (endpointHash(row.url) === urlHash) return row;
      } catch {
        // Malformed URL in DB — skip, do not abort the lookup.
      }
    }
    return undefined;
  }

  async findByAgent(agentHash: string): Promise<ServiceEndpoint[]> {
    // findByAgent excludes ad_hoc entries by default — these aren't trusted enough
    // to influence ranking or discovery (URL→agent binding may be incorrect).
    const { rows } = await this.db.query<ServiceEndpoint>(
      "SELECT * FROM service_endpoints WHERE agent_hash = $1 AND source IN ('402index', 'self_registered') ORDER BY last_checked_at DESC",
      [agentHash],
    );
    return rows;
  }

  async findStale(minCheckCount: number, maxAgeSec: number, limit: number): Promise<ServiceEndpoint[]> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const { rows } = await this.db.query<ServiceEndpoint>(
      `
      SELECT * FROM service_endpoints
      WHERE check_count >= $1 AND (last_checked_at IS NULL OR last_checked_at < $2)
      ORDER BY last_checked_at ASC LIMIT $3
      `,
      [minCheckCount, cutoff, limit],
    );
    return rows;
  }

  async updatePrice(url: string, priceSats: number): Promise<void> {
    await this.db.query('UPDATE service_endpoints SET service_price_sats = $1 WHERE url = $2', [priceSats, url]);
  }

  async updateMetadata(url: string, meta: ServiceMetadata): Promise<void> {
    await this.db.query(
      'UPDATE service_endpoints SET name = $1, description = $2, category = $3, provider = $4 WHERE url = $5',
      [meta.name, meta.description, meta.category, meta.provider, url],
    );
  }

  async findServices(filters: ServiceSearchFilters): Promise<{ services: ServiceEndpoint[]; total: number }> {
    // Only trusted sources appear in discovery — ad_hoc URLs may have wrong URL→agent bindings
    const conditions: string[] = ["se.agent_hash IS NOT NULL", "se.source IN ('402index', 'self_registered')"];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.q) {
      const like = `%${filters.q}%`;
      conditions.push(`(se.name LIKE $${idx} OR se.description LIKE $${idx + 1} OR se.category LIKE $${idx + 2} OR se.provider LIKE $${idx + 3})`);
      params.push(like, like, like, like);
      idx += 4;
    }

    if (filters.category) {
      conditions.push(`se.category = $${idx}`);
      params.push(filters.category.toLowerCase());
      idx += 1;
    }

    if (filters.minUptime !== undefined) {
      conditions.push(`se.check_count >= 3 AND (CAST(se.success_count AS DOUBLE PRECISION) / se.check_count) >= $${idx}`);
      params.push(filters.minUptime);
      idx += 1;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: countRows } = await this.db.query<{ c: string }>(
      `SELECT COUNT(*)::text as c FROM service_endpoints se ${where}`,
      params,
    );
    const total = Number(countRows[0]?.c ?? 0);

    // Explicit whitelist for ORDER BY column — defense in depth so a future
    // refactor that widens `filters.sort`'s type can't accidentally route user
    // input into the SQL string. Unknown values fall back to the default.
    const SORT_SQL: Record<string, string> = {
      price: 'se.service_price_sats ASC',
      uptime: '(CAST(se.success_count AS DOUBLE PRECISION) / GREATEST(se.check_count, 1)) DESC',
      activity: 'se.check_count DESC',
      // `p_success` at the SQL layer is a no-op fallback to activity; the
      // controller re-sorts in JS with the per-row Bayesian posterior.
      p_success: 'se.check_count DESC',
    };
    const sortKey = typeof filters.sort === 'string' && Object.prototype.hasOwnProperty.call(SORT_SQL, filters.sort)
      ? filters.sort
      : 'activity';
    const sortCol = SORT_SQL[sortKey];

    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    const { rows } = await this.db.query<ServiceEndpoint>(
      `SELECT se.* FROM service_endpoints se ${where} ORDER BY ${sortCol} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    return { services: rows, total };
  }

  async findCategories(): Promise<Array<{ category: string; count: number }>> {
    const { rows } = await this.db.query<{ category: string; count: string }>(
      "SELECT category, COUNT(*)::text as count FROM service_endpoints WHERE category IS NOT NULL AND agent_hash IS NOT NULL AND source IN ('402index', 'self_registered') GROUP BY category ORDER BY count DESC",
    );
    return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
  }

  /** Résumé par catégorie pour /api/intent/categories : total + nombre
   *  d'endpoints actifs (≥3 probes ET uptime ≥ 50% ET probé dans les 7 derniers
   *  jours). Sans le gate de fraîcheur, des fossiles avec un vieil historique
   *  vert remontaient comme actifs ; on aligne le critère sur la fenêtre 7j
   *  utilisée par le posterior bayésien. `last_checked_at` est stocké en
   *  epoch seconds (BIGINT), donc on compare à un cutoff calculé côté TS.
   *  L'écart total/active signale aux agents quelles catégories sont saines
   *  vs. fossiles. */
  async findCategoriesWithActive(): Promise<Array<{ category: string; endpoint_count: number; active_count: number }>> {
    const freshCutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const { rows } = await this.db.query<{ category: string; endpoint_count: string; active_count: string }>(
      `
      SELECT
        category,
        COUNT(*)::text AS endpoint_count,
        SUM(CASE
          WHEN check_count >= 3
            AND (CAST(success_count AS DOUBLE PRECISION) / check_count) >= 0.5
            AND last_checked_at IS NOT NULL
            AND last_checked_at > $1
          THEN 1 ELSE 0
        END)::text AS active_count
      FROM service_endpoints
      WHERE category IS NOT NULL
        AND agent_hash IS NOT NULL
        AND source IN ('402index', 'self_registered')
      GROUP BY category
      ORDER BY endpoint_count DESC
      `,
      [freshCutoff],
    );
    return rows.map((r) => ({
      category: r.category,
      endpoint_count: Number(r.endpoint_count),
      active_count: Number(r.active_count),
    }));
  }

  /** Médiane de response_latency_ms sur `service_probes` dans la fenêtre 7j.
   *  Retourne `null` si moins de `minSample` probes (défaut 3) — les agents
   *  n'ont pas à traiter une "médiane" sur 1 point comme un signal.
   *  Postgres n'expose pas toujours MEDIAN natif (percentile_cont fonctionne
   *  aussi) ; on extrait tous les points triés puis on prend celui du milieu
   *  côté TS pour garder la sémantique identique au code SQLite. Fenêtre 7j
   *  en secondes, cohérente avec τ du bayésien et la reachability. */
  async medianHttpLatency7d(url: string, minSample = 3): Promise<number | null> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const { rows } = await this.db.query<{ latency: number }>(
      `
      SELECT response_latency_ms AS latency
      FROM service_probes
      WHERE url = $1
        AND probed_at >= $2
        AND response_latency_ms IS NOT NULL
      ORDER BY response_latency_ms ASC
      `,
      [url, cutoff],
    );
    if (rows.length < minSample) return null;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 === 1
      ? rows[mid].latency
      : Math.round((rows[mid - 1].latency + rows[mid].latency) / 2);
  }

  /** Scan live des URLs pour matcher un url_hash → category. La table n'a pas
   *  de colonne `url_hash` stockée ; pour ~100 endpoints le coût est
   *  négligeable (microsecondes). Ne trust que les sources trusted (pas ad_hoc). */
  async findCategoryByUrlHash(targetHash: string): Promise<string | null> {
    const { rows } = await this.db.query<{ url: string; category: string }>(
      "SELECT url, category FROM service_endpoints WHERE category IS NOT NULL AND source IN ('402index', 'self_registered')",
    );
    for (const r of rows) {
      if (endpointHash(r.url) === targetHash) return r.category;
    }
    return null;
  }

  /** Retourne tous les url_hash appartenant à une catégorie. Utilisé par le
   *  bayesian verdict service pour alimenter le niveau `category` du prior
   *  hiérarchique (somme des streaming posteriors des siblings). */
  async listUrlHashesByCategory(category: string): Promise<string[]> {
    const { rows } = await this.db.query<{ url: string }>(
      "SELECT url FROM service_endpoints WHERE category = $1 AND source IN ('402index', 'self_registered')",
      [category],
    );
    return rows.map((r) => endpointHash(r.url));
  }
}
