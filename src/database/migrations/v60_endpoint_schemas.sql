-- Phase 3 (2026-05-01) — Endpoint schema registry.
--
-- Operators publish a canonical JSON Schema (draft-07) describing the
-- response shape their L402 endpoint guarantees. Agents reference the
-- schema by its content-hash via fulfill's expected_schema_hash, and the
-- orchestrator validates each successful delivery against it. A response
-- that returns 2xx but doesn't match → delivery_schema_violation refund
-- (Tier 2). The validator framework lives in src/services/responseValidator.ts.
--
-- Hash = sha256 of the canonical-JSON serialization of the schema (keys
-- sorted lex, no whitespace). Same schema → same hash, regardless of
-- formatting. Storing schema_json verbatim lets us return the original
-- formatting on GET /api/schemas/:hash for human auditors.
--
-- Operator binding via operator_pubkey + signed_event_id keeps the audit
-- trail: who registered this schema, what NIP-98 event proved it. Phase 3
-- doesn't gate fulfillment on operator_pubkey == endpoint owner — anyone
-- can register a schema and any agent can reference it. Phase 4+ may add
-- ownership pinning if the open registry surfaces abuse.

CREATE TABLE IF NOT EXISTS endpoint_schemas (
  schema_hash      TEXT        PRIMARY KEY,
  schema_json      JSONB       NOT NULL,
  operator_pubkey  TEXT        NOT NULL,
  signed_event_id  TEXT        NOT NULL,
  registered_at    INTEGER     NOT NULL,
  last_seen_at     INTEGER     NOT NULL,
  /* Optional human-readable name surfaced in /api/schemas listings.
     Allows agents and auditors to recognise common schemas. */
  name             TEXT,
  /* Optional content-type expected alongside the schema (e.g. "application/json").
     null = allow anything. */
  content_type     TEXT
);

-- Lookup by registering operator (for audit / their submission history).
CREATE INDEX IF NOT EXISTS idx_endpoint_schemas_operator
  ON endpoint_schemas (operator_pubkey, registered_at DESC);

-- Recent-schema queries.
CREATE INDEX IF NOT EXISTS idx_endpoint_schemas_recent
  ON endpoint_schemas (registered_at DESC);

COMMENT ON TABLE endpoint_schemas IS
  'Phase 3 (2026-05-01) — JSON Schema registry. Operators publish; agents reference by hash in fulfill. See project_fulfill_proxy_plan.md.';

INSERT INTO schema_version (version, applied_at, description)
VALUES (60, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'endpoint_schemas — Phase 3 fulfill proxy: JSON Schema registry')
ON CONFLICT (version) DO NOTHING;
