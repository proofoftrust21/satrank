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
    this.stmtFindByAgent = db.prepare('SELECT * FROM service_endpoints WHERE agent_hash = ?');
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
}
