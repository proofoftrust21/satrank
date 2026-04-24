# Security Policy

## 1. Reporting a vulnerability

Preferred channel: GitHub Security Advisory at https://github.com/proofoftrust21/satrank/security/advisories/new.

Email fallback: alex.gauch@protonmail.com.

Include in your report:

- Affected endpoint, file, or component.
- Reproduction steps.
- Expected vs observed behavior.
- Suggested remediation, if you have one.

SLA:

- Acknowledge within 48 hours.
- Initial severity assessment within 7 days.
- Fix timeline is set by severity (see section 6).

No legal action against researchers acting in good faith.

## 2. Scope

In scope:

- satrank.dev and api.satrank.dev production API.
- @satrank/sdk npm package.
- satrank PyPI package.
- Public GitHub repository at github.com/proofoftrust21/satrank, AGPL-3.0.

Out of scope:

- Third-party services linked from documentation.
- Social engineering of operators.
- Physical attacks on infrastructure.

## 3. Rewards

No formal bug bounty program. Public acknowledgement in the GitHub Security Advisory and in CHANGELOG.md is available on request.

## 4. Security architecture summary

- L402 native gate: HMAC-SHA256 macaroons sealed with `L402_MACAROON_SECRET` (32-byte hex). On request, the middleware verifies the HMAC over the full payload, then matches the preimage hash against LND settled invoices. Rotating the secret invalidates all outstanding macaroons; there is no sliding window.
- Balance auth: after macaroon verification, the api container decrements `token_balance` by the route price. A balance at zero returns 402 with a fresh challenge.
- Rate limiting: layered by audience.
  - Probe gates: per-token 10/h (`PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR`), global 20/h (`PROBE_RATE_LIMIT_GLOBAL_PER_HOUR`).
  - Per-IP on /api routes: 100/min (`RATE_LIMIT_MAX`).
  - Write endpoints per-IP: /api/deposit 3/min, /api/attestations 10/min, /api/report 20/min. Per-reporter /api/report cap is also 20/min.
  - Operator bypass via `X-Operator-Token` compared against `OPERATOR_BYPASS_SECRET` with a timing-safe equal.
- SSRF defense: outbound fetches for probes route through `fetchSafeExternal`, which blocks RFC1918 and link-local ranges and refuses the configured `SERVER_IP` (self-block).
- TLS: Let's Encrypt via certbot, TLS 1.2+ only, explicit cipher list in the nginx config.
- Postgres: reachable from VM1 only, over the Hetzner private network, with pg_hba.conf restricted to that IP.
- LND: the api container uses an invoice-only macaroon by default (mints invoices, cannot move funds). The probe path uses a pay macaroon scoped to `offchain:read` plus `offchain:write`.

## 5. Known security considerations

Secret leak impact:

- `L402_MACAROON_SECRET`: an attacker can forge macaroons but still cannot bypass preimage verification at LND. Impact is bounded to enumeration of paid-for macaroons.
- `OPERATOR_BYPASS_SECRET`: unlimited free access to paid endpoints until rotation.
- `API_KEY`: write access to /api/report and /api/attestations. Can pollute the index and the bonus ledger; guardrails (rate limits, bonus caps) bound the blast radius.
- `NOSTR_PRIVATE_KEY`: attacker can publish fraudulent NIP-85 events under the SatRank identity. Recovery needs a new keypair, a fresh NIP-05 DNS record, and a re-published kind 10040 self-declaration.

Recent audits:

- `docs/archive/SECURITY-AUDIT-REPORT-2026-04-20.md`: pre-sunset audit before Aperture removal. All critical and high severity findings closed.

## 6. Security update policy

- Critical severity: fix within 24 hours, out-of-band release.
- High severity: fix within 7 days, normal release.
- Medium and low severity: next scheduled release.

Security fixes are tagged in CHANGELOG.md under the `security` label. Subscribe to GitHub Security Advisories for release-time notifications.

## 7. Dependencies

Auditing:

- `npm audit --production` on every release for api, sdk, and python-sdk dev dependencies.
- `pip-audit` on the Python SDK on every release.
- Lock files (package-lock.json, sdk/package-lock.json, python-sdk/poetry.lock) committed to git.

Critical dependencies:

- Node 20 LTS.
- LND v0.20.1 (the graph breaker carve-out depends on the exact error surface).
- bitcoind v28.1.
- Postgres 16.
