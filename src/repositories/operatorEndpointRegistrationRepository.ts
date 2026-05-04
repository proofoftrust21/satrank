// Phase 10 (2026-05-04) — Operator-side SDK : self-service endpoint registration.
//
// Sim 12 follow-up Audit 2 Move C : transform SatRank from a crawler-fed
// catalogue into a two-sided marketplace. Operators POST their L402
// endpoints with structured metadata (OpenAPI schema, recall body
// template, recommended validators, optional bond stake). The fulfill
// orchestrator uses the recall_body_template to auto-compose POST bodies
// when the agent doesn't supply one (extension of Sim 12 Fix B).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type RegistrationState = 'pending' | 'verified' | 'failed' | 'revoked';

export interface OperatorEndpointRegistration {
  registration_id: number;
  endpoint_url: string;
  http_method: 'GET' | 'POST';
  operator_pubkey: string;
  domain: string;
  state: RegistrationState;
  openapi_json: unknown | null;
  recall_body_template: string | null;
  recommended_validators: string[] | null;
  expected_price_sats_min: number | null;
  expected_price_sats_max: number | null;
  bond_id: number | null;
  signed_payload_sha256: string;
  signature_b64: string;
  registered_at: number;
  verified_at: number | null;
  last_health_at: number | null;
  fulfill_count: number;
  fulfill_success_count: number;
  /** Phase 11A.1 — capability schema (required at registration time). */
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  modalities: string[] | null;
  languages: string[] | null;
  freshness_sla_sec: number | null;
  deterministic: boolean | null;
}

export interface CreateRegistrationInput {
  endpoint_url: string;
  http_method: 'GET' | 'POST';
  operator_pubkey: string;
  domain: string;
  openapi_json?: unknown;
  recall_body_template?: string;
  recommended_validators?: string[];
  expected_price_sats_min?: number;
  expected_price_sats_max?: number;
  bond_id?: number;
  signed_payload_sha256: string;
  signature_b64: string;
  registered_at: number;
  /** Phase 11A.1 — at least one of input_schema or output_schema is required
   *  by the service-layer validator. Backwards-compatible at the DB layer
   *  (NULL allowed) so existing v68 fixtures keep working in tests. */
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  modalities?: string[];
  languages?: string[];
  freshness_sla_sec?: number;
  deterministic?: boolean;
}

export class OperatorEndpointRegistrationRepository {
  constructor(private db: Queryable) {}

  async create(input: CreateRegistrationInput): Promise<OperatorEndpointRegistration> {
    const { rows } = await this.db.query<RegistrationRow>(
      `INSERT INTO operator_endpoint_registrations
        (endpoint_url, http_method, operator_pubkey, domain, openapi_json,
         recall_body_template, recommended_validators,
         expected_price_sats_min, expected_price_sats_max, bond_id,
         signed_payload_sha256, signature_b64, registered_at,
         input_schema, output_schema, modalities, languages,
         freshness_sla_sec, deterministic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19)
       ON CONFLICT (endpoint_url) DO UPDATE
         SET http_method = EXCLUDED.http_method,
             operator_pubkey = EXCLUDED.operator_pubkey,
             domain = EXCLUDED.domain,
             openapi_json = EXCLUDED.openapi_json,
             recall_body_template = EXCLUDED.recall_body_template,
             recommended_validators = EXCLUDED.recommended_validators,
             expected_price_sats_min = EXCLUDED.expected_price_sats_min,
             expected_price_sats_max = EXCLUDED.expected_price_sats_max,
             bond_id = EXCLUDED.bond_id,
             signed_payload_sha256 = EXCLUDED.signed_payload_sha256,
             signature_b64 = EXCLUDED.signature_b64,
             registered_at = EXCLUDED.registered_at,
             input_schema = EXCLUDED.input_schema,
             output_schema = EXCLUDED.output_schema,
             modalities = EXCLUDED.modalities,
             languages = EXCLUDED.languages,
             freshness_sla_sec = EXCLUDED.freshness_sla_sec,
             deterministic = EXCLUDED.deterministic,
             state = 'pending',
             verified_at = NULL
       RETURNING *`,
      [
        input.endpoint_url,
        input.http_method,
        input.operator_pubkey,
        input.domain,
        input.openapi_json ?? null,
        input.recall_body_template ?? null,
        input.recommended_validators ?? null,
        input.expected_price_sats_min ?? null,
        input.expected_price_sats_max ?? null,
        input.bond_id ?? null,
        input.signed_payload_sha256,
        input.signature_b64,
        input.registered_at,
        input.input_schema ?? null,
        input.output_schema ?? null,
        input.modalities ?? null,
        input.languages ?? null,
        input.freshness_sla_sec ?? null,
        input.deterministic ?? null,
      ],
    );
    return rowTo(rows[0]);
  }

  async findByUrl(endpointUrl: string): Promise<OperatorEndpointRegistration | null> {
    const { rows } = await this.db.query<RegistrationRow>(
      'SELECT * FROM operator_endpoint_registrations WHERE endpoint_url = $1',
      [endpointUrl],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByOperator(operatorPubkey: string): Promise<OperatorEndpointRegistration[]> {
    const { rows } = await this.db.query<RegistrationRow>(
      `SELECT * FROM operator_endpoint_registrations
       WHERE operator_pubkey = $1
       ORDER BY registered_at DESC`,
      [operatorPubkey],
    );
    return rows.map(rowTo);
  }

  async findPending(batchSize = 50): Promise<OperatorEndpointRegistration[]> {
    const { rows } = await this.db.query<RegistrationRow>(
      `SELECT * FROM operator_endpoint_registrations
       WHERE state = 'pending'
       ORDER BY registered_at ASC
       LIMIT $1`,
      [batchSize],
    );
    return rows.map(rowTo);
  }

  async markVerified(registrationId: number, verifiedAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_endpoint_registrations
          SET state = 'verified', verified_at = $2
        WHERE registration_id = $1 AND state = 'pending'`,
      [registrationId, verifiedAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async markFailed(registrationId: number, atSec: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_endpoint_registrations
          SET state = 'failed', verified_at = $2
        WHERE registration_id = $1 AND state = 'pending'`,
      [registrationId, atSec],
    );
    return (rowCount ?? 0) === 1;
  }

  async revoke(registrationId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_endpoint_registrations
          SET state = 'revoked'
        WHERE registration_id = $1 AND state IN ('pending', 'verified', 'failed')`,
      [registrationId],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Used by fulfillService recall step to look up the recall body
   *  template + recommended validators when the agent didn't supply them. */
  async findVerifiedTemplate(endpointUrl: string): Promise<{
    recall_body_template: string | null;
    recommended_validators: string[] | null;
  } | null> {
    const { rows } = await this.db.query<{
      recall_body_template: string | null;
      recommended_validators: string[] | null;
    }>(
      `SELECT recall_body_template, recommended_validators
         FROM operator_endpoint_registrations
        WHERE endpoint_url = $1 AND state = 'verified'`,
      [endpointUrl],
    );
    return rows[0] ?? null;
  }

  /** Operator dashboard aggregate. */
  async dashboardStats(operatorPubkey: string): Promise<{
    registrations_total: number;
    registrations_verified: number;
    registrations_pending: number;
    fulfill_success_rate: number | null;
  }> {
    const { rows } = await this.db.query<{
      total: string;
      verified: string;
      pending: string;
      fulfill_count_sum: string | null;
      fulfill_success_sum: string | null;
    }>(
      `SELECT COUNT(*)::text                                                AS total,
              COUNT(*) FILTER (WHERE state = 'verified')::text              AS verified,
              COUNT(*) FILTER (WHERE state = 'pending')::text               AS pending,
              SUM(fulfill_count)::text                                      AS fulfill_count_sum,
              SUM(fulfill_success_count)::text                              AS fulfill_success_sum
         FROM operator_endpoint_registrations
        WHERE operator_pubkey = $1`,
      [operatorPubkey],
    );
    const r = rows[0];
    const fc = Number(r?.fulfill_count_sum ?? 0);
    const fs = Number(r?.fulfill_success_sum ?? 0);
    return {
      registrations_total: Number(r?.total ?? 0),
      registrations_verified: Number(r?.verified ?? 0),
      registrations_pending: Number(r?.pending ?? 0),
      fulfill_success_rate: fc > 0 ? fs / fc : null,
    };
  }
}

interface RegistrationRow {
  registration_id: string | number;
  endpoint_url: string;
  http_method: 'GET' | 'POST';
  operator_pubkey: string;
  domain: string;
  state: RegistrationState;
  openapi_json: unknown | null;
  recall_body_template: string | null;
  recommended_validators: string[] | null;
  expected_price_sats_min: string | number | null;
  expected_price_sats_max: string | number | null;
  bond_id: string | number | null;
  signed_payload_sha256: string;
  signature_b64: string;
  registered_at: string | number;
  verified_at: string | number | null;
  last_health_at: string | number | null;
  fulfill_count: string | number;
  fulfill_success_count: string | number;
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  modalities: string[] | null;
  languages: string[] | null;
  freshness_sla_sec: string | number | null;
  deterministic: boolean | null;
}

function rowTo(r: RegistrationRow): OperatorEndpointRegistration {
  return {
    registration_id: Number(r.registration_id),
    endpoint_url: r.endpoint_url,
    http_method: r.http_method,
    operator_pubkey: r.operator_pubkey,
    domain: r.domain,
    state: r.state,
    openapi_json: r.openapi_json,
    recall_body_template: r.recall_body_template,
    recommended_validators: r.recommended_validators,
    expected_price_sats_min: r.expected_price_sats_min != null ? Number(r.expected_price_sats_min) : null,
    expected_price_sats_max: r.expected_price_sats_max != null ? Number(r.expected_price_sats_max) : null,
    bond_id: r.bond_id != null ? Number(r.bond_id) : null,
    signed_payload_sha256: r.signed_payload_sha256,
    signature_b64: r.signature_b64,
    registered_at: Number(r.registered_at),
    verified_at: r.verified_at != null ? Number(r.verified_at) : null,
    last_health_at: r.last_health_at != null ? Number(r.last_health_at) : null,
    fulfill_count: Number(r.fulfill_count),
    fulfill_success_count: Number(r.fulfill_success_count),
    input_schema: r.input_schema ?? null,
    output_schema: r.output_schema ?? null,
    modalities: r.modalities ?? null,
    languages: r.languages ?? null,
    freshness_sla_sec: r.freshness_sla_sec != null ? Number(r.freshness_sla_sec) : null,
    deterministic: r.deterministic ?? null,
  };
}
