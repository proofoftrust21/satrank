-- Phase 5 — schema version bump.
--
-- The actual backfill of endpoint_streaming_posteriors from
-- service_endpoints.check_count / success_count runs through a TypeScript
-- one-shot script (src/scripts/backfillEndpointPosteriors.ts) which has
-- access to the proper urlCanonical.endpointHash function. RFC 3986
-- canonicalization (lowercased scheme/host, default port stripping,
-- normalized percent-encoding, etc.) cannot be replicated reliably in
-- pure SQL, so the backfill stays in TS where the URL hashing rules are
-- already implemented.
--
-- This file exists only so the schema version reaches 46, matching the
-- expected_schema_version constant in statsService.ts. No DDL is applied
-- because no schema columns change in Phase 5.

INSERT INTO schema_version (version, applied_at, description)
VALUES (46, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Phase 5 - per-endpoint posteriors in /api/intent (TS-side fix); backfill via scripts/backfillEndpointPosteriors.ts');
