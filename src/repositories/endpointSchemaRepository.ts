// Phase 3 (2026-05-01) — JSON Schema registry repository.
//
// One row per (canonical schema hash). Re-registering the same schema
// (any operator) is idempotent — bumps last_seen_at, returns the existing
// row. Different operators registering the same content-equal schema
// share the row but only the *first* operator_pubkey is recorded; this
// avoids accidental ownership claims on community-standard schemas.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface EndpointSchema {
  schema_hash: string;
  schema_json: unknown;
  operator_pubkey: string;
  signed_event_id: string;
  registered_at: number;
  last_seen_at: number;
  name: string | null;
  content_type: string | null;
}

export interface RegisterSchemaInput {
  schema_json: unknown;
  operator_pubkey: string;
  signed_event_id: string;
  name?: string;
  content_type?: string;
  registered_at: number;
}

export class EndpointSchemaRepository {
  constructor(private db: Queryable) {}

  /** Register a new schema. Idempotent on schema_hash — re-submission by
   *  any operator returns the existing row, only updates last_seen_at. */
  async register(input: RegisterSchemaInput): Promise<{ schema_hash: string; created: boolean }> {
    const schemaJsonText = canonicalJson(input.schema_json);
    const schema_hash = sha256Hex(schemaJsonText);
    const { rows } = await this.db.query<{ created: boolean }>(
      `WITH ins AS (
        INSERT INTO endpoint_schemas
          (schema_hash, schema_json, operator_pubkey, signed_event_id,
           registered_at, last_seen_at, name, content_type)
        VALUES ($1, $2::jsonb, $3, $4, $5, $5, $6, $7)
        ON CONFLICT (schema_hash) DO NOTHING
        RETURNING schema_hash
      ), upd AS (
        UPDATE endpoint_schemas SET last_seen_at = $5
         WHERE schema_hash = $1
           AND NOT EXISTS (SELECT 1 FROM ins)
        RETURNING schema_hash
      )
      SELECT EXISTS(SELECT 1 FROM ins) AS created`,
      [
        schema_hash,
        schemaJsonText,
        input.operator_pubkey,
        input.signed_event_id,
        input.registered_at,
        input.name ?? null,
        input.content_type ?? null,
      ],
    );
    return { schema_hash, created: rows[0]?.created === true };
  }

  async findByHash(schemaHash: string): Promise<EndpointSchema | null> {
    const { rows } = await this.db.query<EndpointSchemaRow>(
      'SELECT * FROM endpoint_schemas WHERE schema_hash = $1',
      [schemaHash],
    );
    return rows[0] ? rowToSchema(rows[0]) : null;
  }

  async listRecent(limit: number = 50): Promise<EndpointSchema[]> {
    const { rows } = await this.db.query<EndpointSchemaRow>(
      'SELECT * FROM endpoint_schemas ORDER BY registered_at DESC LIMIT $1',
      [Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    return rows.map(rowToSchema);
  }
}

interface EndpointSchemaRow {
  schema_hash: string;
  schema_json: unknown | string;
  operator_pubkey: string;
  signed_event_id: string;
  registered_at: string | number;
  last_seen_at: string | number;
  name: string | null;
  content_type: string | null;
}

function rowToSchema(row: EndpointSchemaRow): EndpointSchema {
  return {
    schema_hash: row.schema_hash,
    schema_json: typeof row.schema_json === 'string' ? JSON.parse(row.schema_json) : row.schema_json,
    operator_pubkey: row.operator_pubkey,
    signed_event_id: row.signed_event_id,
    registered_at: Number(row.registered_at),
    last_seen_at: Number(row.last_seen_at),
    name: row.name,
    content_type: row.content_type,
  };
}

/** Canonical JSON serialization — keys sorted recursively, no whitespace.
 *  Two structurally-equal schemas (different formatting) hash identically.
 *  Pure function — exported so callers can hash off-thread. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  // Plain object — sort keys.
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalize(obj[k]);
  return out;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Public helper — used by callers that want to compute the hash without
 *  hitting the DB (e.g. agent SDKs precomputing what to ask for). */
export function computeSchemaHash(schema: unknown): string {
  return sha256Hex(canonicalJson(schema));
}
