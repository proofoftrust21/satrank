// Phase 12.1 (2026-05-05) — capability inference audit-log repository.
//
// Sovereignty audit trail (audit L6, impact 2). Every LLM-inferred
// capability row is logged with full prompt + raw response + parsed
// result so a regulator / dispute / model-upgrade can replay any
// ranking decision back to its source.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type RunKind = 'backfill' | 'enrichment' | 'review';

export interface CapabilityInferenceLogEntry {
  log_id: number;
  endpoint_url: string;
  model_id: string;
  prompt_hash: string;
  prompt_raw: string;
  response_raw: string;
  parsed_capability: Record<string, unknown>;
  run_kind: RunKind;
  run_id: string;
  created_at: number;
  applied: boolean;
  applied_at: number | null;
}

export interface CreateLogEntryInput {
  endpoint_url: string;
  model_id: string;
  prompt_hash: string;
  prompt_raw: string;
  response_raw: string;
  parsed_capability: Record<string, unknown>;
  run_kind: RunKind;
  run_id: string;
  created_at: number;
}

export class CapabilityInferenceLogRepository {
  constructor(private db: Queryable) {}

  async create(input: CreateLogEntryInput): Promise<CapabilityInferenceLogEntry> {
    const { rows } = await this.db.query<LogRow>(
      `INSERT INTO capability_inference_log
        (endpoint_url, model_id, prompt_hash, prompt_raw, response_raw,
         parsed_capability, run_kind, run_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.endpoint_url,
        input.model_id,
        input.prompt_hash,
        input.prompt_raw,
        input.response_raw,
        input.parsed_capability,
        input.run_kind,
        input.run_id,
        input.created_at,
      ],
    );
    return rowTo(rows[0]);
  }

  async markApplied(logId: number, appliedAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE capability_inference_log
          SET applied = TRUE, applied_at = $2
        WHERE log_id = $1 AND applied = FALSE`,
      [logId, appliedAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async findLatestByEndpoint(endpointUrl: string): Promise<CapabilityInferenceLogEntry | null> {
    const { rows } = await this.db.query<LogRow>(
      `SELECT * FROM capability_inference_log
        WHERE endpoint_url = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [endpointUrl],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByRunId(runId: string, limit = 1000): Promise<CapabilityInferenceLogEntry[]> {
    const { rows } = await this.db.query<LogRow>(
      `SELECT * FROM capability_inference_log
        WHERE run_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [runId, limit],
    );
    return rows.map(rowTo);
  }

  async runStats(runId: string): Promise<{ total: number; applied: number; failed: number }> {
    const { rows } = await this.db.query<{ total: string; applied: string; failed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE applied = TRUE)::text AS applied,
              COUNT(*) FILTER (WHERE applied = FALSE)::text AS failed
         FROM capability_inference_log
        WHERE run_id = $1`,
      [runId],
    );
    return {
      total: Number(rows[0]?.total ?? 0),
      applied: Number(rows[0]?.applied ?? 0),
      failed: Number(rows[0]?.failed ?? 0),
    };
  }
}

interface LogRow {
  log_id: string | number;
  endpoint_url: string;
  model_id: string;
  prompt_hash: string;
  prompt_raw: string;
  response_raw: string;
  parsed_capability: Record<string, unknown>;
  run_kind: RunKind;
  run_id: string;
  created_at: string | number;
  applied: boolean;
  applied_at: string | number | null;
}

function rowTo(r: LogRow): CapabilityInferenceLogEntry {
  return {
    log_id: Number(r.log_id),
    endpoint_url: r.endpoint_url,
    model_id: r.model_id,
    prompt_hash: r.prompt_hash,
    prompt_raw: r.prompt_raw,
    response_raw: r.response_raw,
    parsed_capability: r.parsed_capability,
    run_kind: r.run_kind,
    run_id: r.run_id,
    created_at: Number(r.created_at),
    applied: r.applied,
    applied_at: r.applied_at != null ? Number(r.applied_at) : null,
  };
}
