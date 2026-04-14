// Repository for paid L402 probe results (scam detection)
import type Database from 'better-sqlite3';

export interface ServiceProbe {
  id: number;
  url: string;
  agent_hash: string | null;
  probed_at: number;
  paid_sats: number;
  payment_hash: string | null;
  http_status: number | null;
  body_valid: number;
  response_latency_ms: number | null;
  error: string | null;
}

export class ServiceProbeRepository {
  private stmtInsert;
  private stmtFindLatest;
  private stmtCountToday;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO service_probes (url, agent_hash, probed_at, paid_sats, payment_hash, http_status, body_valid, response_latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindLatest = db.prepare(
      'SELECT * FROM service_probes WHERE url = ? ORDER BY probed_at DESC LIMIT 1',
    );
    this.stmtCountToday = db.prepare(
      'SELECT COUNT(*) AS cnt FROM service_probes WHERE probed_at > ?',
    );
  }

  insert(probe: Omit<ServiceProbe, 'id'>): void {
    this.stmtInsert.run(
      probe.url, probe.agent_hash, probe.probed_at, probe.paid_sats,
      probe.payment_hash, probe.http_status, probe.body_valid,
      probe.response_latency_ms, probe.error,
    );
  }

  findLatest(url: string): ServiceProbe | undefined {
    return this.stmtFindLatest.get(url) as ServiceProbe | undefined;
  }

  countSince(sinceTimestamp: number): number {
    const row = this.stmtCountToday.get(sinceTimestamp) as { cnt: number };
    return row.cnt;
  }
}
