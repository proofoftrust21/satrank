// Phase 9.3 (2026-05-01) — Intent-keyed result cache storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface IntentResultCacheEntry {
  cache_id: number;
  intent_hash: string;
  body: string;
  body_sha256: string;
  source_job_id: string;
  source_attempt_index: number;
  source_candidate_url: string;
  source_operator_pubkey: string | null;
  source_preimage: string;
  source_sats_paid: number;
  source_agent_pubkey: string;
  created_at: number;
  expires_at: number;
  hit_count: number;
}

export interface CreateCacheInput {
  intent_hash: string;
  body: string;
  body_sha256: string;
  source_job_id: string;
  source_attempt_index: number;
  source_candidate_url: string;
  source_operator_pubkey: string | null;
  source_preimage: string;
  source_sats_paid: number;
  source_agent_pubkey: string;
  created_at: number;
  expires_at: number;
}

export class IntentResultCacheRepository {
  constructor(private db: Queryable) {}

  /** Lookup the freshest non-expired entry for an intent_hash. Returns null
   *  when no fresh entry exists (cache miss). */
  async lookup(intentHash: string, nowSec: number): Promise<IntentResultCacheEntry | null> {
    const { rows } = await this.db.query<CacheRow>(
      `SELECT * FROM intent_result_cache
       WHERE intent_hash = $1 AND expires_at > $2
       ORDER BY expires_at DESC
       LIMIT 1`,
      [intentHash, nowSec],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async create(input: CreateCacheInput): Promise<IntentResultCacheEntry> {
    const { rows } = await this.db.query<CacheRow>(
      `INSERT INTO intent_result_cache
        (intent_hash, body, body_sha256, source_job_id, source_attempt_index,
         source_candidate_url, source_operator_pubkey, source_preimage,
         source_sats_paid, source_agent_pubkey, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.intent_hash, input.body, input.body_sha256,
        input.source_job_id, input.source_attempt_index,
        input.source_candidate_url, input.source_operator_pubkey,
        input.source_preimage, input.source_sats_paid,
        input.source_agent_pubkey, input.created_at, input.expires_at,
      ],
    );
    return rowTo(rows[0]);
  }

  async incrementHit(cacheId: number): Promise<void> {
    await this.db.query(
      'UPDATE intent_result_cache SET hit_count = hit_count + 1 WHERE cache_id = $1',
      [cacheId],
    );
  }

  /** Cron : evict expired rows. */
  async pruneExpired(nowSec: number, batchSize = 200): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM intent_result_cache
        WHERE cache_id IN (
          SELECT cache_id FROM intent_result_cache
           WHERE expires_at < $1
           ORDER BY expires_at ASC
           LIMIT $2
        )`,
      [nowSec, batchSize],
    );
    return rowCount ?? 0;
  }
}

interface CacheRow {
  cache_id: string | number;
  intent_hash: string;
  body: string;
  body_sha256: string;
  source_job_id: string;
  source_attempt_index: string | number;
  source_candidate_url: string;
  source_operator_pubkey: string | null;
  source_preimage: string;
  source_sats_paid: string | number;
  source_agent_pubkey: string;
  created_at: string | number;
  expires_at: string | number;
  hit_count: string | number;
}

function rowTo(r: CacheRow): IntentResultCacheEntry {
  return {
    cache_id: Number(r.cache_id),
    intent_hash: r.intent_hash,
    body: r.body,
    body_sha256: r.body_sha256,
    source_job_id: r.source_job_id,
    source_attempt_index: Number(r.source_attempt_index),
    source_candidate_url: r.source_candidate_url,
    source_operator_pubkey: r.source_operator_pubkey,
    source_preimage: r.source_preimage,
    source_sats_paid: Number(r.source_sats_paid),
    source_agent_pubkey: r.source_agent_pubkey,
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    hit_count: Number(r.hit_count),
  };
}
