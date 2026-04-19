// Repository for HTTP service endpoint health tracking
import type Database from 'better-sqlite3';
import { endpointHash } from '../utils/urlCanonical';

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
  private stmtUpsert;
  private stmtFindByUrl;
  private stmtFindByAgent;
  private stmtFindStale;

  constructor(private db: Database.Database) {
    // Upsert with source trust hierarchy: on conflict, keep the highest-trust source
    // (402index > self_registered > ad_hoc). Never downgrade.
    this.stmtUpsert = db.prepare(`
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at, source)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        agent_hash = COALESCE(excluded.agent_hash, agent_hash),
        last_http_status = excluded.last_http_status,
        last_latency_ms = excluded.last_latency_ms,
        last_checked_at = excluded.last_checked_at,
        check_count = check_count + 1,
        success_count = success_count + excluded.success_count,
        source = CASE
          WHEN source = '402index' OR excluded.source = '402index' THEN '402index'
          WHEN source = 'self_registered' OR excluded.source = 'self_registered' THEN 'self_registered'
          ELSE 'ad_hoc'
        END
    `);

    this.stmtFindByUrl = db.prepare('SELECT * FROM service_endpoints WHERE url = ?');
    // findByAgent excludes ad_hoc entries by default — these aren't trusted enough
    // to influence ranking or discovery (URL→agent binding may be incorrect).
    this.stmtFindByAgent = db.prepare(
      "SELECT * FROM service_endpoints WHERE agent_hash = ? AND source IN ('402index', 'self_registered') ORDER BY last_checked_at DESC",
    );
    this.stmtFindStale = db.prepare(`
      SELECT * FROM service_endpoints
      WHERE check_count >= ? AND (last_checked_at IS NULL OR last_checked_at < ?)
      ORDER BY last_checked_at ASC LIMIT ?
    `);
  }

  upsert(agentHash: string | null, url: string, httpStatus: number, latencyMs: number, source: ServiceSource = 'ad_hoc'): void {
    const now = Math.floor(Date.now() / 1000);
    const isSuccess = (httpStatus >= 200 && httpStatus < 400) || httpStatus === 402;
    this.stmtUpsert.run(agentHash, url, httpStatus, latencyMs, now, isSuccess ? 1 : 0, now, source);
  }

  /** Distribution of entries per source — used by /api/health for observability. */
  countBySource(): Record<ServiceSource, number> {
    const rows = this.db.prepare("SELECT source, COUNT(*) as c FROM service_endpoints GROUP BY source").all() as Array<{ source: ServiceSource; c: number }>;
    const out: Record<ServiceSource, number> = { '402index': 0, 'self_registered': 0, 'ad_hoc': 0 };
    for (const r of rows) out[r.source] = r.c;
    return out;
  }

  findByUrl(url: string): ServiceEndpoint | undefined {
    return this.stmtFindByUrl.get(url) as ServiceEndpoint | undefined;
  }

  /** Best-effort metadata lookup by url_hash (sha256 of canonicalized URL).
   *  SQLite has no native sha256, and `service_endpoints` stores only the
   *  literal URL, so we scan trusted rows and compare hashes in-process. The
   *  table is small (low thousands at most today) so the O(N) scan is fine
   *  for a detail view. A dedicated column / index can be added in a later
   *  migration if this endpoint ever gets hot. */
  findByUrlHash(urlHash: string): ServiceEndpoint | undefined {
    const rows = this.db
      .prepare("SELECT * FROM service_endpoints WHERE source IN ('402index', 'self_registered')")
      .all() as ServiceEndpoint[];
    for (const row of rows) {
      try {
        if (endpointHash(row.url) === urlHash) return row;
      } catch {
        // Malformed URL in DB — skip, do not abort the lookup.
      }
    }
    return undefined;
  }

  findByAgent(agentHash: string): ServiceEndpoint[] {
    return this.stmtFindByAgent.all(agentHash) as ServiceEndpoint[];
  }

  findStale(minCheckCount: number, maxAgeSec: number, limit: number): ServiceEndpoint[] {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    return this.stmtFindStale.all(minCheckCount, cutoff, limit) as ServiceEndpoint[];
  }

  updatePrice(url: string, priceSats: number): void {
    this.db.prepare('UPDATE service_endpoints SET service_price_sats = ? WHERE url = ?').run(priceSats, url);
  }

  updateMetadata(url: string, meta: ServiceMetadata): void {
    this.db.prepare(
      'UPDATE service_endpoints SET name = ?, description = ?, category = ?, provider = ? WHERE url = ?',
    ).run(meta.name, meta.description, meta.category, meta.provider, url);
  }

  findServices(filters: ServiceSearchFilters): { services: ServiceEndpoint[]; total: number } {
    // Only trusted sources appear in discovery — ad_hoc URLs may have wrong URL→agent bindings
    const conditions: string[] = ["se.agent_hash IS NOT NULL", "se.source IN ('402index', 'self_registered')"];
    const params: unknown[] = [];

    if (filters.q) {
      const like = `%${filters.q}%`;
      conditions.push('(se.name LIKE ? OR se.description LIKE ? OR se.category LIKE ? OR se.provider LIKE ?)');
      params.push(like, like, like, like);
    }

    if (filters.category) {
      conditions.push('se.category = ?');
      params.push(filters.category.toLowerCase());
    }

    if (filters.minUptime !== undefined) {
      conditions.push('se.check_count >= 3 AND (CAST(se.success_count AS REAL) / se.check_count) >= ?');
      params.push(filters.minUptime);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as c FROM service_endpoints se ${where}`).get(...params) as { c: number };

    // Explicit whitelist for ORDER BY column — defense in depth so a future
    // refactor that widens `filters.sort`'s type can't accidentally route user
    // input into the SQL string. Unknown values fall back to the default.
    const SORT_SQL: Record<string, string> = {
      price: 'se.service_price_sats ASC',
      uptime: '(CAST(se.success_count AS REAL) / MAX(se.check_count, 1)) DESC',
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

    const rows = this.db.prepare(
      `SELECT se.* FROM service_endpoints se ${where} ORDER BY ${sortCol} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as ServiceEndpoint[];

    return { services: rows, total: countRow.c };
  }

  findCategories(): Array<{ category: string; count: number }> {
    return this.db.prepare(
      "SELECT category, COUNT(*) as count FROM service_endpoints WHERE category IS NOT NULL AND agent_hash IS NOT NULL AND source IN ('402index', 'self_registered') GROUP BY category ORDER BY count DESC",
    ).all() as Array<{ category: string; count: number }>;
  }

  /** Résumé par catégorie pour /api/intent/categories : total + nombre
   *  d'endpoints actifs (≥3 probes ET uptime ≥ 50%). L'écart entre les deux
   *  signale aux agents quelles catégories sont saines vs. fossiles. */
  findCategoriesWithActive(): Array<{ category: string; endpoint_count: number; active_count: number }> {
    return this.db.prepare(`
      SELECT
        category,
        COUNT(*) AS endpoint_count,
        SUM(CASE
          WHEN check_count >= 3 AND (CAST(success_count AS REAL) / check_count) >= 0.5
          THEN 1 ELSE 0
        END) AS active_count
      FROM service_endpoints
      WHERE category IS NOT NULL
        AND agent_hash IS NOT NULL
        AND source IN ('402index', 'self_registered')
      GROUP BY category
      ORDER BY endpoint_count DESC
    `).all() as Array<{ category: string; endpoint_count: number; active_count: number }>;
  }

  /** Médiane de response_latency_ms sur `service_probes` dans la fenêtre 7j.
   *  Retourne `null` si moins de `minSample` probes (défaut 3) — les agents
   *  n'ont pas à traiter une "médiane" sur 1 point comme un signal.
   *  SQLite n'a pas de MEDIAN natif — on extrait tous les points triés puis
   *  on prend celui du milieu côté TS. Fenêtre 7j en secondes, cohérente avec
   *  τ du bayésien et la reachability. */
  medianHttpLatency7d(url: string, minSample = 3): number | null {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = this.db.prepare(`
      SELECT response_latency_ms AS latency
      FROM service_probes
      WHERE url = ?
        AND probed_at >= ?
        AND response_latency_ms IS NOT NULL
      ORDER BY response_latency_ms ASC
    `).all(url, cutoff) as Array<{ latency: number }>;
    if (rows.length < minSample) return null;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 === 1
      ? rows[mid].latency
      : Math.round((rows[mid - 1].latency + rows[mid].latency) / 2);
  }

  /** Scan live des URLs pour matcher un url_hash → category. La table n'a pas
   *  de colonne `url_hash` stockée ; pour ~100 endpoints le coût est
   *  négligeable (microsecondes). Ne trust que les sources trusted (pas ad_hoc). */
  findCategoryByUrlHash(targetHash: string): string | null {
    const rows = this.db.prepare(
      "SELECT url, category FROM service_endpoints WHERE category IS NOT NULL AND source IN ('402index', 'self_registered')",
    ).all() as Array<{ url: string; category: string }>;
    for (const r of rows) {
      if (endpointHash(r.url) === targetHash) return r.category;
    }
    return null;
  }

  /** Retourne tous les url_hash appartenant à une catégorie. Utilisé par le
   *  bayesian verdict service pour alimenter le niveau `category` du prior
   *  hiérarchique (somme des streaming posteriors des siblings). */
  listUrlHashesByCategory(category: string): string[] {
    const rows = this.db.prepare(
      "SELECT url FROM service_endpoints WHERE category = ? AND source IN ('402index', 'self_registered')",
    ).all(category) as Array<{ url: string }>;
    return rows.map(r => endpointHash(r.url));
  }
}
