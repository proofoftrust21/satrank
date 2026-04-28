// Phase 6.2 — repository pour trust_assertions_published.
//
// Audit log des kind 30782 publiés ; le source of truth est la chaîne
// Nostr. Une row par endpoint (UPSERT replaces sur (endpoint_url_hash)).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface TrustAssertionRecord {
  endpoint_url_hash: string;
  event_id: string;
  oracle_pubkey: string;
  valid_until: number;
  p_e2e: number | null;
  meaningful_stages_count: number;
  calibration_proof_event_id: string | null;
  published_at: number;
  relays: string[];
}

export class TrustAssertionRepository {
  constructor(private readonly db: Queryable) {}

  /** UPSERT : un seul record actif par endpoint. Le replace sur
   *  endpoint_url_hash matche la sémantique NIP-33 addressable
   *  replaceable côté Nostr. */
  async upsert(record: TrustAssertionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO trust_assertions_published
         (endpoint_url_hash, event_id, oracle_pubkey, valid_until,
          p_e2e, meaningful_stages_count, calibration_proof_event_id,
          published_at, relays)
       VALUES ($1::text, $2::text, $3::text, $4::bigint,
               $5, $6::int, $7,
               $8::bigint, $9::text[])
       ON CONFLICT (endpoint_url_hash)
       DO UPDATE SET
         event_id = EXCLUDED.event_id,
         oracle_pubkey = EXCLUDED.oracle_pubkey,
         valid_until = EXCLUDED.valid_until,
         p_e2e = EXCLUDED.p_e2e,
         meaningful_stages_count = EXCLUDED.meaningful_stages_count,
         calibration_proof_event_id = EXCLUDED.calibration_proof_event_id,
         published_at = EXCLUDED.published_at,
         relays = EXCLUDED.relays`,
      [
        record.endpoint_url_hash,
        record.event_id,
        record.oracle_pubkey,
        record.valid_until,
        record.p_e2e,
        record.meaningful_stages_count,
        record.calibration_proof_event_id,
        record.published_at,
        record.relays,
      ],
    );
  }

  /** Lookup par hash — utilisé par /api/oracle/assertion/:url_hash pour
   *  exposer le metadata aux operators (BOLT12 TLV embedding). */
  async findByUrlHash(urlHash: string): Promise<TrustAssertionRecord | null> {
    const { rows } = await this.db.query<TrustAssertionRecord>(
      `SELECT endpoint_url_hash, event_id, oracle_pubkey, valid_until,
              p_e2e, meaningful_stages_count, calibration_proof_event_id,
              published_at, relays
         FROM trust_assertions_published
        WHERE endpoint_url_hash = $1::text`,
      [urlHash],
    );
    return rows[0] ?? null;
  }

  /** Pour idempotence cron : skip si déjà publié il y a < skipWindowSec. */
  async wasPublishedRecently(
    urlHash: string,
    nowSec: number,
    skipWindowSec: number,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ published_at: string }>(
      `SELECT published_at FROM trust_assertions_published
        WHERE endpoint_url_hash = $1::text
          AND published_at >= $2::bigint`,
      [urlHash, nowSec - skipWindowSec],
    );
    return rows.length > 0;
  }
}
