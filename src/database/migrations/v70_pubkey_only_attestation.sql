-- Phase 11A.3 (2026-05-04) — pubkey-only operator attestation.
--
-- Per autonomy audit 2026-05-04 (lens L5 Composition / agent-to-agent
-- economy, sev-5 gap "no-agent-operator-symmetry"). DNS TXT
-- (_satrank-operator.<domain>) requires the operator to control DNS
-- records — viable for hosted services but not for agent-operators
-- running on Heroku/Render/ngrok/etc, which is the dominant case for
-- autonomous AI agents that want to BECOME providers.
--
-- This migration adds an alternative attestation method : the operator
-- publishes their pubkey at `https://<endpoint_host>/.well-known/
-- satrank-operator-pubkey`. The verifier fetches that URL via
-- fetchSafeExternal (SSRF-protected) and confirms the body matches the
-- declared operator_pubkey. Same trust property as DNS TXT (proves
-- control of the URL host), accessible to operators without domain DNS.
--
-- Backwards compatibility : DEFAULT 'dns_txt' so all v68 rows keep their
-- existing behaviour. New registrations opt into 'wellknown_pubkey'.

ALTER TABLE operator_endpoint_registrations
  ADD COLUMN IF NOT EXISTS attestation_method TEXT NOT NULL DEFAULT 'dns_txt'
    CHECK (attestation_method IN ('dns_txt', 'wellknown_pubkey'));

CREATE INDEX IF NOT EXISTS operator_endpoint_registrations_attestation_method_idx
  ON operator_endpoint_registrations (attestation_method, state);

INSERT INTO schema_version (version, applied_at, description)
VALUES (70, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pubkey_only_attestation — Phase 11A.3 : attestation_method enum (dns_txt | wellknown_pubkey) so agent-operators can self-attest without DNS control')
ON CONFLICT (version) DO NOTHING;
