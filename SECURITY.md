# Security Policy

## 1. Reporting a vulnerability

Preferred channel: GitHub Security Advisory at
https://github.com/proofoftrust21/satrank/security/advisories/new.

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

- `satrank.dev` and `api.satrank.dev` production API.
- `satrank-mcp` npm package.
- Public GitHub repository at github.com/proofoftrust21/satrank, AGPL-3.0.

Out of scope:

- Third-party services linked from documentation (e.g. l402.directory, l402.services).
- Social engineering of operators.
- Physical attacks on infrastructure.

## 3. Rewards

No formal bug bounty program. Public acknowledgement in the GitHub Security
Advisory and in `CHANGELOG.md` is available on request.

## 4. Security architecture summary

The hardened V3 surface (post-audit 2026-05-09, commit `f22235b`):

- **L402 native gate**: HMAC-SHA256 macaroons sealed with `L402_MACAROON_SECRET`
  (32-byte hex). The middleware verifies the HMAC in constant time
  (`crypto.timingSafeEqual`), then matches `sha256(preimage)` against the
  payment_hash. Single-use is enforced via `revenue_log` UPSERT — an attempted
  preimage replay returns `402 PAYMENT_ALREADY_USED`. Macaroon TTL is 10 min.
- **Deposit credits**: alternate bearer of shape `Authorization: L402
  deposit_<id>:<preimage>`. Linear decrement via single-statement
  `UPDATE … RETURNING` — concurrent calls cannot double-spend the balance.
- **SSRF defense**: every outbound URL (catalog ingest + probes) passes through
  `assertSafeUrl()` which blocks RFC1918, loopback, link-local, IPv6 ULA, and
  multicast. Only HTTPS is probed.
- **Rate limiting**: 120 req/min/IP global + 30 req/min/IP additional on
  `/api/intent`. Keys honor `X-Forwarded-For` (Express `trust proxy = 1`).
  `429 RATE_LIMITED` with clean JSON envelope.
- **Body caps**: 64 KB at Express, 16 KB at nginx (defense-in-depth). Probe
  response cap 256 KB (streaming read stops at limit, prevents OOM from a
  malicious GB-streaming endpoint).
- **TLS**: TLS 1.2 / 1.3 only, modern cipher list, server-chosen order.
  Let's Encrypt via certbot.
- **Security headers** at nginx: HSTS (1 year, includeSubDomains),
  X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy
  no-referrer, Permissions-Policy denying geolocation/microphone/camera.
- **Schema CHECK** on `service_endpoints.http_method` (only GET/POST/PUT/DELETE
  allowed at the table level — no SQL-injection pivot can write a non-allowlisted method).
- **Container hardening**: read-only filesystem, `cap_drop: ALL`,
  `no-new-privileges`, non-root user (uid 1001).
- **LND macaroon**: the api container uses a single invoice-and-pay macaroon,
  bound read-only into the container. Channel and onchain scopes are not
  granted.

## 5. Known security considerations

Secret leak impact:

- `L402_MACAROON_SECRET` (32-byte hex): an attacker can forge macaroons but
  still cannot bypass preimage verification — every paid call requires a real
  Lightning settlement. Impact is bounded to a denial-of-service vector
  (forged macaroons trigger LND lookup work).
- `NOSTR_PRIVATE_KEY` (32-byte hex): attacker can publish fraudulent kind 30782
  trust assertions under the SatRank oracle identity. Recovery requires a new
  keypair and a re-published `/.well-known/satrank-key`.
- `DATABASE_URL`: read access to revenue logs, observation history, and deposit
  state. No PII (no email, no IP-tied user records). Write access enables
  catalog poisoning.

## 6. Security update policy

- Critical severity: fix within 24 hours, out-of-band release.
- High severity: fix within 7 days, normal release.
- Medium and low severity: next scheduled release.

Security fixes are tagged in `CHANGELOG.md`. Subscribe to GitHub Security
Advisories for release-time notifications.

## 7. Dependencies

- `npm audit --omit=dev --audit-level=high` runs on every CI build.
- `package-lock.json` committed to git.
- Critical dependencies:
  - Node 20 LTS (Docker image: `node:22-alpine` for build, runtime).
  - PostgreSQL 16.
  - Express 4.21+, express-rate-limit 8.5+, zod 3.24+.
  - LND v0.18+ (V3 paid gate uses LND REST `/v1/invoices` + `/v2/router/send`).
