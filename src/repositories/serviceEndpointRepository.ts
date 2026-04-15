// Repository for HTTP service endpoint health tracking
import type Database from 'better-sqlite3';

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
    this.stmtUpsert = db.prepare(`
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        agent_hash = COALESCE(excluded.agent_hash, agent_hash),
        last_http_status = excluded.last_http_status,
        last_latency_ms = excluded.last_latency_ms,
        last_checked_at = excluded.last_checked_at,
        check_count = check_count + 1,
        success_count = success_count + excluded.success_count
    `);

    this.stmtFindByUrl = db.prepare('SELECT * FROM service_endpoints WHERE url = ?');
    this.stmtFindByAgent = db.prepare('SELECT * FROM service_endpoints WHERE agent_hash = ? ORDER BY last_checked_at DESC');
    this.stmtFindStale = db.prepare(`
      SELECT * FROM service_endpoints
      WHERE check_count >= ? AND (last_checked_at IS NULL OR last_checked_at < ?)
      ORDER BY last_checked_at ASC LIMIT ?
    `);
  }

  upsert(agentHash: string | null, url: string, httpStatus: number, latencyMs: number): void {
    const now = Math.floor(Date.now() / 1000);
    const isSuccess = (httpStatus >= 200 && httpStatus < 400) || httpStatus === 402;
    this.stmtUpsert.run(agentHash, url, httpStatus, latencyMs, now, isSuccess ? 1 : 0, now);
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
    const conditions: string[] = ['se.agent_hash IS NOT NULL'];
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

    const sortCol = filters.sort === 'price' ? 'se.service_price_sats ASC'
      : filters.sort === 'uptime' ? '(CAST(se.success_count AS REAL) / MAX(se.check_count, 1)) DESC'
      : 'se.check_count DESC'; // default: most-checked first (proxy for popularity)

    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT se.* FROM service_endpoints se ${where} ORDER BY ${sortCol} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as ServiceEndpoint[];

    return { services: rows, total: countRow.c };
  }

  findCategories(): Array<{ category: string; count: number }> {
    return this.db.prepare(
      'SELECT category, COUNT(*) as count FROM service_endpoints WHERE category IS NOT NULL AND agent_hash IS NOT NULL GROUP BY category ORDER BY count DESC',
    ).all() as Array<{ category: string; count: number }>;
  }
}
