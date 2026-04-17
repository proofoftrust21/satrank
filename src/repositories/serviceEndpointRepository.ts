// Repository for HTTP service endpoint health tracking
import type Database from 'better-sqlite3';

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
  minScore?: number;
  minUptime?: number;
  sort?: 'score' | 'price' | 'uptime';
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
      score: 'se.check_count DESC',
    };
    const sortKey = typeof filters.sort === 'string' && Object.prototype.hasOwnProperty.call(SORT_SQL, filters.sort)
      ? filters.sort
      : 'score';
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
}
