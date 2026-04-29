-- Excellence pass — audit trail for self-registration.
--
-- Every register/update/delete attempt against /api/services/register is
-- logged here with the signing npub, the NIP-98 event id, the requested
-- action, and the outcome. Use cases:
--   - Forensics if an opérateur disputes an unwanted change.
--   - Anti-abuse forensics if a npub spams.
--   - Reconstruct the self-register history of an endpoint when investigating
--     conflicts with the upstream 402index ingest.
--
-- Designed to be append-only. No update/delete cron — let it grow; rows
-- are tiny and the indexes are narrow.

CREATE TABLE IF NOT EXISTS service_register_log (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  npub_hex CHAR(64) NOT NULL,
  nip98_event_id CHAR(64) NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('register', 'update', 'delete')),
  success BOOLEAN NOT NULL,
  reason TEXT,
  payload_json JSONB,
  observed_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_service_register_log_npub
  ON service_register_log (npub_hex, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_register_log_url_hash
  ON service_register_log (url_hash, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_register_log_event_id
  ON service_register_log (nip98_event_id);

INSERT INTO schema_version (version, applied_at, description)
VALUES (57, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'service_register_log — audit trail for NIP-98-gated self-registration')
ON CONFLICT (version) DO NOTHING;
