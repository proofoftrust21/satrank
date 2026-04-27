-- Phase 5.6 — ensure pgcrypto extension is loaded.
--
-- The new findServices ORDER BY uses digest(url, 'sha256') to JOIN the URL
-- column to endpoint_streaming_posteriors.url_hash. pgcrypto provides the
-- digest() function. Production has the extension installed (per Phase 5.5
-- inspection); this migration ensures test template DBs and future fresh
-- bootstraps also have it.
--
-- Idempotent: CREATE EXTENSION IF NOT EXISTS is a no-op when the extension
-- already exists in the current DB.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO schema_version (version, applied_at, description)
VALUES (47, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 5.6 - ensure pgcrypto extension for digest() in p_success ORDER BY');
