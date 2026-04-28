// Phase 8.1 — repositories pour les crowd outcome reports + identity-age.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface CrowdOutcomeRecord {
  event_id: string;
  agent_pubkey: string;
  endpoint_url_hash: string;
  trust_assertion_event_id: string | null;
  outcome: string;
  stage: number;
  success: boolean;
  effective_weight: number;
  pow_factor: number;
  identity_age_factor: number;
  preimage_factor: number;
  declared_pow_bits: number | null;
  verified_pow_bits: number | null;
  preimage_verified: boolean;
  latency_ms: number | null;
  observed_at: number;
  ingested_at: number;
}

export class CrowdOutcomeRepository {
  constructor(private readonly db: Queryable) {}

  /** INSERT, ON CONFLICT (event_id) skip — chaque event Nostr ingéré une
   *  seule fois. Retourne true si nouveau, false si dup. */
  async insertIfNew(record: CrowdOutcomeRecord): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO crowd_outcome_reports
         (event_id, agent_pubkey, endpoint_url_hash, trust_assertion_event_id,
          outcome, stage, success, effective_weight, pow_factor,
          identity_age_factor, preimage_factor, declared_pow_bits,
          verified_pow_bits, preimage_verified, latency_ms,
          observed_at, ingested_at)
       VALUES ($1::text, $2::text, $3::text, $4,
               $5::text, $6::smallint, $7::boolean, $8::double precision,
               $9::double precision, $10::double precision,
               $11::double precision, $12, $13, $14::boolean,
               $15, $16::bigint, $17::bigint)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        record.event_id,
        record.agent_pubkey,
        record.endpoint_url_hash,
        record.trust_assertion_event_id,
        record.outcome,
        record.stage,
        record.success,
        record.effective_weight,
        record.pow_factor,
        record.identity_age_factor,
        record.preimage_factor,
        record.declared_pow_bits,
        record.verified_pow_bits,
        record.preimage_verified,
        record.latency_ms,
        record.observed_at,
        record.ingested_at,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async findByEventId(eventId: string): Promise<CrowdOutcomeRecord | null> {
    const { rows } = await this.db.query<CrowdOutcomeRecord>(
      `SELECT event_id, agent_pubkey, endpoint_url_hash, trust_assertion_event_id,
              outcome, stage, success, effective_weight, pow_factor,
              identity_age_factor, preimage_factor, declared_pow_bits,
              verified_pow_bits, preimage_verified, latency_ms,
              observed_at, ingested_at
         FROM crowd_outcome_reports
        WHERE event_id = $1::text`,
      [eventId],
    );
    return rows[0] ?? null;
  }
}

// ---------- nostr_identity_first_seen ----------

export interface NostrIdentityRecord {
  pubkey: string;
  first_seen: number;
  report_count: number;
  last_seen: number;
}

export class NostrIdentityRepository {
  constructor(private readonly db: Queryable) {}

  /** UPSERT : insert si nouvelle pubkey, sinon update last_seen + ++count.
   *  Retourne le record après update (avec first_seen original). */
  async observeIdentity(pubkey: string, nowSec: number): Promise<NostrIdentityRecord> {
    const { rows } = await this.db.query<NostrIdentityRecord>(
      `INSERT INTO nostr_identity_first_seen (pubkey, first_seen, last_seen, report_count)
       VALUES ($1::text, $2::bigint, $2::bigint, 1)
       ON CONFLICT (pubkey)
       DO UPDATE SET
         last_seen = $2::bigint,
         report_count = nostr_identity_first_seen.report_count + 1
       RETURNING pubkey, first_seen, last_seen, report_count`,
      [pubkey, nowSec],
    );
    return rows[0];
  }

  async findByPubkey(pubkey: string): Promise<NostrIdentityRecord | null> {
    const { rows } = await this.db.query<NostrIdentityRecord>(
      `SELECT pubkey, first_seen, last_seen, report_count
         FROM nostr_identity_first_seen
        WHERE pubkey = $1::text`,
      [pubkey],
    );
    return rows[0] ?? null;
  }
}
