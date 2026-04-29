// Excellence pass — audit trail for self-registration (v57).
//
// Append-only log of every register/update/delete attempt against
// /api/services/register, captured with the signing NIP-98 npub and event
// id. Forensics surface for disputes ("did anyone else change my entry?")
// and for anti-abuse pattern detection ("which npub keeps spamming?").
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type ServiceRegisterAction = 'register' | 'update' | 'delete';

export interface ServiceRegisterLogEntry {
  url: string;
  url_hash: string;
  npub_hex: string;
  nip98_event_id: string;
  action: ServiceRegisterAction;
  success: boolean;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  observed_at?: number;
}

export interface ServiceRegisterLogRow {
  id: number;
  url: string;
  url_hash: string;
  npub_hex: string;
  nip98_event_id: string;
  action: ServiceRegisterAction;
  success: boolean;
  reason: string | null;
  payload_json: Record<string, unknown> | null;
  observed_at: number;
}

export class ServiceRegisterLogRepository {
  constructor(private readonly db: Queryable) {}

  async log(entry: ServiceRegisterLogEntry): Promise<void> {
    const observedAt = entry.observed_at ?? Math.floor(Date.now() / 1000);
    await this.db.query(
      `INSERT INTO service_register_log
         (url, url_hash, npub_hex, nip98_event_id, action, success, reason, payload_json, observed_at)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::boolean, $7, $8::jsonb, $9::bigint)`,
      [
        entry.url,
        entry.url_hash,
        entry.npub_hex,
        entry.nip98_event_id,
        entry.action,
        entry.success,
        entry.reason ?? null,
        entry.payload ? JSON.stringify(entry.payload) : null,
        observedAt,
      ],
    );
  }

  /** Most recent N entries for a given URL hash. Used by an opérateur
   *  asking "what's the history of changes to my endpoint?". */
  async findByUrlHash(urlHash: string, limit = 50): Promise<ServiceRegisterLogRow[]> {
    const { rows } = await this.db.query<ServiceRegisterLogRow>(
      `SELECT id, url, url_hash, npub_hex, nip98_event_id, action, success, reason, payload_json, observed_at
         FROM service_register_log
        WHERE url_hash = $1::text
        ORDER BY observed_at DESC
        LIMIT $2::int`,
      [urlHash, limit],
    );
    return rows;
  }

  /** Most recent N entries for a given npub. Used to investigate spam
   *  patterns or to show an opérateur their submission history. */
  async findByNpub(npubHex: string, limit = 50): Promise<ServiceRegisterLogRow[]> {
    const { rows } = await this.db.query<ServiceRegisterLogRow>(
      `SELECT id, url, url_hash, npub_hex, nip98_event_id, action, success, reason, payload_json, observed_at
         FROM service_register_log
        WHERE npub_hex = $1::text
        ORDER BY observed_at DESC
        LIMIT $2::int`,
      [npubHex, limit],
    );
    return rows;
  }
}
