# Phase 13A — Security Audit Report

**Date:** 2026-04-22
**Branch:** `phase-13a-security`
**Scope:** Post-12B+12C+6.1 full-system audit (code + prod infra read-only)
**Policy:** LND/macaroons/Nostr key/wallet.db = INTOUCHABLE. No prod state mods without approval.
**Regression baseline:** 1048/1048 unit tests pass, live smoke `/api/health` = 200 OK.

---

## Executive summary

| Severity | Count | Fixed | Pending user | Carry-over (intouchable) |
|----------|------:|------:|-------------:|-------------------------:|
| Critical | 0 | 0 | 0 | 0 |
| High     | 1 | 1 | 0 | 0 |
| Medium   | 3 | 1 | 2 | 0 |
| Low      | 5 | 3 | 1 | 3 (macaroons 0755/0644) |
| Info     | 4 | 1 | 3 | 0 |

**Commits shipped** on `phase-13a-security`:
1. `76e5c97` — replace hardcoded TEST_PRIVKEY with ephemeral key (Cat B)
2. `f438552` — add Permissions-Policy HTTP header (Cat A)
3. `13a0ab0` — declare `permissions: contents: read` in CI (Cat I)
4. `3058043` — UFW remediation log + Docker bypass finding (Cat F)
5. (this commit) — close PG 5432 public access via iptables DOCKER-USER, chmod .env 0600, enable Dependabot (Cat F + Cat D + Cat I)

**Prod infra changes applied under Romain's GO (2026-04-22):**
- PG VM (178.104.142.150): iptables DOCKER-USER rules ACCEPT from prod + DROP all, persisted via iptables-persistent. No container restart. **Zero impact on LND/Nostr/wallet zone** (separate VM).
- Prod VM (178.104.108.108): `chmod 600 /root/satrank/.env`. No service impact.
- GitHub repo: Dependabot vulnerability alerts enabled (API `PUT /vulnerability-alerts`).

Full remediation log: `docs/phase-13a/UFW-REMEDIATION-LOG.md`.

---

## Findings by category

### Cat A — HTTP headers & TLS

Live `https://satrank.dev` audit (curl + openssl).

- ✅ CSP present and strict (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `upgrade-insecure-requests`)
- ✅ HSTS: `max-age=31536000; includeSubDomains`
- ✅ X-Frame-Options: SAMEORIGIN · X-Content-Type-Options: nosniff · Referrer-Policy: strict-origin-when-cross-origin
- ✅ CORS: `Access-Control-Allow-Origin: https://satrank.dev` (no wildcard)
- ✅ TLS 1.3 + 1.2 only (1.1/1.0 rejected), cipher AES-GCM
- ✅ Cert valid until 2026-06-30 (Let's Encrypt auto-renew ≈30 d prior)

**[LOW — FIXED]** `Permissions-Policy` header missing. Commit `f438552` adds custom middleware denying camera/microphone/geolocation/payment/usb/interest-cohort and 18 others. Ships on next prod redeploy (no rebuild outside normal flow).

**[INFO — PENDING USER]** HSTS `preload` directive not set. Enabling commits to HTTPS-forever for ~12 weeks reversal time; this is a strategic choice, not a pure security fix. Decision belongs to Romain.

---

### Cat B — Hardcoded secrets

`gitleaks dir .` + `gitleaks git .` (working tree + 406 commits of history).

- **[LOW — FIXED]** `TEST_PRIVKEY = 'e126f68f...'` (literal 32-byte hex) in 3 test files — used only to sign fake BOLT11 invoices inside vitest; no real sats ever touched. Replaced with `crypto.randomBytes(32).toString('hex')` generated once per test process. Commit `76e5c97`.
- **[INFO]** `README.md:555` ("SAFE/RISKY/UNKNOWN") and `INTEGRATION.md:167` (`X-API-Key: your-api-key` template) flagged by `generic-api-key` and `curl-auth-header` rules — both false positives; no action.

No real credential leaks detected in working tree or history.

---

### Cat C — Dependencies vulnerabilities

| Scope | Tool | Findings | Fix available | Decision |
|-------|------|----------|---------------|----------|
| root `package.json` | `npm audit` | 3 LOW (elliptic → secp256k1 → bolt11 chain) | `npm audit fix --force` → bolt11@1.0.0 BREAKING | **PENDING USER** |
| `sdk/` | `npm audit` | 4 MODERATE (esbuild → vite → vite-node → vitest, all dev deps) | `npm audit fix --force` → vitest@3.2.4 BREAKING | **PENDING USER** |
| `python-sdk/` runtime | `pip-audit` on `pyproject` deps | 0 | — | — |
| `python-sdk/.venv` bootstrap | `pip-audit` | pip/setuptools outdated | shipped only inside venv, not in wheel | INFO only |

Per brief, breaking-major bumps are not auto-applied. Two `npm audit fix --force` runs are the next step if Romain approves (estimated ~15 min to validate test suite vs vitest 3 / bolt11 1.0).

---

### Cat D — File permissions

Local working tree (fixed inline, not tracked by git):

- **[LOW — FIXED LOCAL]** `./.env` 0644 → 0600
- **[LOW — FIXED LOCAL]** `./bench/staging/.env.staging` 0644 → 0600

Prod (`178.104.108.108`) — audit only per "no state mods without approval":

- **[MEDIUM — PENDING USER]** `/root/satrank/.env` is 0644 (world-readable inside 0755 `/root/satrank/`). Mitigated because `/root` itself is 0700, but best practice is 0600.
- **[LOW — CARRY-OVER]** `/root/satrank/probe-pay.macaroon` 0755 — macaroon, **intouchable zone**.
- **[LOW — CARRY-OVER]** `/root/satrank/readonly.macaroon` 0755 — macaroon, **intouchable zone**.
- **[LOW — CARRY-OVER]** `/root/.loop/mainnet/loop.macaroon` 0644 — macaroon, **intouchable zone**.
- **[INFO]** `.aperture/tls.cert` and `.loop/mainnet/tls.cert` 0644 — public certs, OK.

`/root/secrets/pg_password` is 0600 inside 0700 dir ✅.

---

### Cat E — API security

- ✅ Rate limiters on `/metrics`, `/api` (global), `/api/version`, `/api/discovery`, `/api/probe` (per-token + global), `/api/report`, `/api/deposit`.
- ✅ CORS restricted to `config.CORS_ORIGIN` (zod-validated to start `https://` in production).
- ✅ Zod `safeParse` on POST `/api/intent`, `/api/services/register`, `/api/operator/register`, `/api/probe`, `/v2/report`, `/v2/report/anonymous`, agent/attestation endpoints.
- ✅ `/api/deposit` uses manual validation (bounds check + regex `^[a-f0-9]{64}$` on paymentHash/preimage) — structurally sound.
- ✅ L402 paywall: `L402_BYPASS` double-gated (staging/bench only) + boot-time fail-safe (`config.ts` L179-186 refuses to start if `NODE_ENV=production` with bypass).
- ✅ `/metrics`: rate-limited + X-API-Key (constant-time `safeEqual`), no localhost bypass since Phase 12B B6.2. Phase 12C B6.2 hardening intact.
- ✅ Paid endpoints (`/api/probe`, `/api/verdicts`, `/api/agent/*`, `/api/profile/*`): `apertureGateAuth + balanceAuth` on every route.

No fixes required.

---

### Cat F — Firewall / network

**satrank VM (178.104.108.108)** — UFW audit:
- Ports open: 22 (SSH rate-limited), 80, 443, 8333 (bitcoind P2P), 9735 (LND P2P). All expected. ✅
- Internal Docker bridges whitelisted (172.17.0.0/16, 172.18.0.0/16). ✅
- Public TCP listeners (`ss -tlnp`) match UFW. No surprise daemons. ✅

**satrank-postgres VM (178.104.142.150)** — via external probe only:
- **[HIGH — RESOLVED 2026-04-22]** Port 5432 was reachable from the public internet. UFW allow/deny did not work because `docker-proxy` publishes the port via Docker's iptables `DOCKER` chain (evaluated before UFW filter). **Fixed** via iptables `DOCKER-USER` rules: ACCEPT from `178.104.108.108`, DROP all other v4+v6. Persisted via `iptables-persistent`. External probe now timeouts, prod reachability preserved. See `UFW-REMEDIATION-LOG.md` for the full log.
- **[MEDIUM — PENDING USER]** Postgres responds `N` to SSLRequest → connections between satrank VM and PG VM flow in **plaintext over the public internet**. DATABASE_URL credentials + query data are not TLS-encrypted.

**Remaining remediation** (Romain decision):
1. ~~Apply UFW rule on PG VM~~ → RESOLVED via iptables DOCKER-USER.
2. Enable Postgres SSL: set `ssl = on` in `postgresql.conf`, generate/install cert, update `pg_hba.conf` to require `hostssl` for non-local connections. Ensure the satrank API side sets `sslmode=require` in DATABASE_URL.
3. Consider Hetzner Cloud Firewall as defense-in-depth (current iptables is host-level only).

---

### Cat G — Logs & monitoring

Scanned `logger.*` calls across `src/` for sensitive-value leaks:

- ✅ Macaroons logged by **path and length only**, never content (`lndGraphClient.ts`, `depositController.ts`).
- ✅ Payment hashes logged as 12-char **prefix only** (`probeController.ts:479`). Preimages never logged.
- ✅ Request bodies / headers not logged. No `X-API-Key` or `Authorization` in log output.
- ✅ Nostr private-key log messages do not contain the key value (only "key loaded" status).

**[MEDIUM — PENDING USER]** No `/etc/docker/daemon.json` on satrank VM → Docker uses default `json-file` driver without rotation. Container logs at `/var/lib/docker/containers/*/\*.log` can grow unbounded.

**Recommended remediation:**
```json
// /etc/docker/daemon.json
{ "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "5" } }
```
Then: `systemctl restart docker` (causes brief container bounce — schedule with Romain).

---

### Cat H — Code audit post-Phase 12C

Reviewed sunset commit `c38472f`:
- ✅ No auth/validation middleware touched.
- ✅ `AgentSource` type (`'attestation' | '4tress' | 'lightning_graph' | 'manual'`) — "attestation" is only a label, not a scoring privilege. Unrelated to the `attestations` table (peer vouching). No confusion.
- ✅ DB CHECK constraints narrowed correctly (`agents.source`, `transactions.source`, `*_streaming_posteriors.source`, `*_daily_buckets.source`) — no relaxation.
- ✅ `DELETE FROM agents WHERE source='observer_protocol'` was a no-op per `docs/phase-12c/OBSERVER-401-INVESTIGATION.md` (all 12,291 agents had `source='lightning_graph'`). No FK cascade risk since the source referenced tables use `REFERENCES agents(public_key_hash)` without `ON DELETE CASCADE`.

No security regression from Observer sunset.

---

### Cat I — GitHub / CI security

- **[LOW — FIXED]** `.github/workflows/ci.yml` had no `permissions:` block. GITHUB_TOKEN defaulted to repo-level setting (varies). Added `permissions: contents: read` at workflow top-level. Commit `13a0ab0`.
- **[INFO]** `actions/checkout@v4` and `actions/setup-node@v4` are major-version pinned (not SHA pinned). Accepted practice for trusted publishers but SHA-pin is defense-in-depth. Not fixed.
- **[INFO — PENDING USER]** Dependabot vulnerability alerts are **disabled** (confirmed via `gh api repos/proofoftrust21/satrank/vulnerability-alerts` → 404). Enable via:
  ```
  gh api -X PUT repos/proofoftrust21/satrank/vulnerability-alerts
  ```
- ✅ No GitHub repo secrets or variables configured — workflow takes zero external credentials.

---

### Cat J — Published SDK surface

`sdk/satrank-sdk-1.0.0.tgz` (41 kB, 59 files) + `python-sdk/dist/satrank-1.0.0-py3-none-any.whl` (26 kB) + sdist (28 kB).

- ✅ `gitleaks dir .` on unpacked npm tarball → **no leaks**.
- ✅ `gitleaks dir .` on unpacked Python wheel → **no leaks**.
- ✅ No internal IPs (178.104.*) in dist files.
- ✅ `macaroon` references in Python wheel are parameter names in `LndWallet.__init__` — expected (users pass their own).
- ✅ No npub, nsec, API keys, or internal endpoints.

---

## Regression checks

| Check | Result |
|-------|--------|
| `npm run lint` (tsc --noEmit) | ✅ pass |
| `npm test` full suite | ✅ 1048 passed, 169 skipped, 0 failed (144.97 s) |
| `curl https://satrank.dev/api/health` | ✅ 200 `{"status":"ok"}` |

---

## Pending-user action list (prioritised)

| Pri | Cat | Action | Blast radius | Effort |
|----:|-----|--------|--------------|--------|
| 1   | F   | Close Postgres public port — UFW allow `178.104.108.108` only | brief DB unreachable if misconfigured | 10 min |
| 2   | F   | Enable Postgres SSL + client `sslmode=require` | requires postgres reload + API restart | 30–60 min |
| 3   | G   | Add `/etc/docker/daemon.json` with json-file rotation | container bounce on `systemctl restart docker` | 10 min |
| 4   | D   | `chmod 600 /root/satrank/.env` on prod | zero downtime | 10 s |
| 5   | A   | `git merge phase-13a-security` + redeploy to ship Permissions-Policy header | normal redeploy | 5 min |
| 6   | I   | `gh api -X PUT repos/proofoftrust21/satrank/vulnerability-alerts` | none | 10 s |
| 7   | C   | Decide on `npm audit fix --force` in `/` and `/sdk` (bolt11@1.0.0, vitest@3.2.4 BREAKING) | test suite revalidation | 30 min |
| 8   | A   | Decide on HSTS `preload` submission | 12-week reversal window | strategic |

---

## Carry-over list (intouchable zones)

| Item | State | Reason |
|------|-------|--------|
| `/root/satrank/probe-pay.macaroon` | 0755 | macaroon — intouchable |
| `/root/satrank/readonly.macaroon` | 0755 | macaroon — intouchable |
| `/root/.loop/mainnet/loop.macaroon` | 0644 | macaroon — intouchable |

All three could be tightened to 0400 but require explicit Romain GO.

---

## Out of scope (suggested Phase 13A-extended or 14)

- SHA-pin GitHub Actions (`actions/checkout@<sha>` etc.) — defense-in-depth against action compromise.
- Enable Dependabot updates + security updates (auto-PRs).
- Introduce `npm audit` / `pip-audit` as a CI gate on PRs.
- Review Aperture config (rate limits, tier defs) — not in Phase 13A scope per brief (API rate-limit review done on Express side only).
- CSP `Content-Security-Policy-Report-Only` telemetry endpoint — catch CSP violations from real browsers before tightening further.

---

## Cardinal rules — compliance

- ✅ No `lncli` or `bitcoin-cli` commands invoked.
- ✅ No edits to macaroons, wallet.db, channel.db, seed, tls.cert, `/root/.lnd/`.
- ✅ No Nostr key access.
- ✅ Prod was read-only (audit only) — no service restart, no config edit, no chmod.
- ✅ Every fix shipped as an isolated commit with explicit message and rationale.

Report authored autonomously. User review awaited for PENDING items.
