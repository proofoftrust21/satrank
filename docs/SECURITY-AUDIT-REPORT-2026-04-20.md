# Security Audit Report — Phase 11

**Scope:** SatRank 1.0.0 full attack surface (14 endpoints, 6 critical flows, infrastructure, dependencies, secrets, crypto).
**Date:** 2026-04-20
**Commit under audit:** `main` @ Phase 10 close (post `ca7a060` nginx versioning).
**Auditor:** Claude Code (Phase 11 C1–C4 sequence).
**Policy:** No fix applied during audit. PoCs run **locally only**, never against production. Remediation lives in Phase 11bis.

> **Responsible disclosure note.** This repository is public. The report and the two PoC scripts in `src/tests/security/` were held back from public commit until all Critical and High findings were remediated and deployed to production. Publication order: Phase 11bis fix (commit `0eeb820`, merge `7488354`, live 2026-04-20) → live validation → this report committed.

---

## Remediation status (Phase 11bis + 11ter — 2026-04-20)

| ID | Sev | Status | Evidence |
|----|-----|--------|----------|
| F-01 | Critical | **Closed** in `0eeb820` (merge `7488354`) | `fetchSafeExternal` wraps both `/api/probe` fetches. Live validation against `https://satrank.dev/api/probe`: 5/5 scenarios (literal `127.0.0.1`, hostname `localhost`, decimal IP `2130706433`, userinfo `public.com@127.0.0.1`, IMDS `169.254.169.254`) returned `VALIDATION_ERROR: URL_NOT_ALLOWED`. |
| F-02 | High | **Closed** in `0eeb820` | `resolveAndPin → fetch(url)` TOCTOU pattern replaced with a single undici `Agent.connect.lookup` hook — one DNS lookup, validated inline before socket open. Applied in `operatorVerificationService`, `serviceHealthCrawler`, `decideService`, `registryCrawler`. |
| F-03 | High | **Closed** in `0eeb820` | `fetchSafeExternal` forces `redirect: 'manual'` by default; callers re-validate 3xx themselves. |
| F-01-bis | Medium | **Closed** in `0eeb820` + prod env (`2026-04-20`) | `PROBE_RATE_LIMIT_GLOBAL_PER_HOUR` default 100 → 20 (`src/config.ts`); prod `.env.production` updated; `satrank-api` recreated. Rate limit is documented as economic friction only, not a security boundary. |
| F-07 | Medium | **Partial** in `0eeb820` | `bodyPreview` now forced empty for binary Content-Type (`readBodyCapped` + `BINARY_CT_RE`). Size cap remains 256 B. `bodyHash` and `bodyBytes` still returned — observability trade-off, candidate for P3 hygiene pass. |
| F-04 | Low | **Accepted** (case C — see investigation below) | `bolt11@2.x` does not exist on npm (latest `1.4.1`, 2023-03). `@lightning/bolt11` does not exist (audit error). `light-bolt11-decoder` is a viable migration target but out of P3 scope. No exploit surface in our decode-only path: `GHSA-848j-6mx2-7j84` concerns ECDSA signing under specific conditions, which we never run. Dependabot (Phase 11ter) will flag future bolt11 / elliptic releases automatically. |
| F-05 | Low | **Closed** in `d68613c` | Hardcoded `'178.104.108.108'` default removed from `src/utils/ssrf.ts`; production boot fails if `SERVER_IP` env is unset (same pattern as `API_KEY`). `.env.example` documents the variable. |
| F-06 | Info | **Closed** in `cbc5857` | SSR boot JSON escape extracted into `src/utils/safeJsonForScript.ts`; now also covers U+2028 and U+2029. 6 unit tests added. |
| F-08 | Low | **Closed** (Phase 12B B6.2) | `/metrics` localhost bypass removed from both api (`src/app.ts`) and crawler (`src/crawler/metricsServer.ts`). X-API-Key is required on every scrape. `L402_BYPASS=true` keeps the endpoint open on the staging/bench plane and is fail-safed against prod by the boot guard in `config.ts`. Finding originally raised in `docs/phase-12a/A7-NOTES.md` §"Latent security finding". |

**Live validation (2026-04-20)** — test token provisioned on prod (random preimage, 10 credits, rate 1), 5 scenarios curled against `https://satrank.dev/api/probe`, all five returned HTTP 400 with `URL_NOT_ALLOWED: target must be a public http(s) URL (no loopback, private, link-local, CGN, userinfo).` Token balance intact after the run (SSRF block precedes the credit debit). Token purged post-validation.

### F-04 investigation (Phase 11ter)

Three mitigation cases were evaluated:

- **Case A — upgrade `bolt11` to 2.x.** Not possible. `npm view bolt11 versions` returns `1.0.0 … 1.4.1`; the `2.x` line does not exist. The audit's original recommendation ("Defer until `bolt11@2.x` ships a compatible upgrade") was based on an incorrect assumption.
- **Case B — migrate to an elliptic-free library.** `@lightning/bolt11` referenced by the audit does not exist on npm (404). The closest viable alternative is `light-bolt11-decoder` (fiatjaf, MIT, active, depends only on `@scure/base`). Migration is technically feasible but requires an API shape translation and careful handling of `payeeNodeKey` recovery, signet prefixes, and tagsObject semantics. Medium effort, non-zero regression risk on the L402 discovery path (`registryCrawler`).
- **Case C — accept the risk with monitoring.** Chosen. Our usage in `src/utils/bolt11Parser.ts` is decode-only: we extract `payment_hash`, `satoshis`, `prefix`, `payeeNodeKey`, `expire_time`, `timestamp`. We never sign. `GHSA-848j-6mx2-7j84` is an ECDSA-signing risk (malleable signatures under specific conditions); decoding BOLT11 does not exercise the risky primitive. Dependabot (added in Phase 11ter C6) will watch weekly for a bolt11 security release or a direct elliptic advisory; this finding will be re-opened automatically if either lands.

---

## Executive summary

One **Critical** SSRF in `/api/probe`, validated by a local reachability PoC. Two **High** DNS-rebinding TOCTOUs in peer services (shared utility pattern). Two **Medium** findings that amplify the Critical (rate-limit economics, `/api/probe` response shape). Two **Low** and one **Info**. No hardcoded secrets, no SQL-injection surface, no auth bypass outside the SSRF chain.

The `/api/probe` Critical is reachable by any caller with a valid deposit token (minimum 21 sats, ≈€0.013). Rate limits provide ≈€0.30–€0.75/h of economic friction for a full /24 internal subnet scan — not a defense.

---

## Findings table

| ID | Sev | Title | Location | Reproducibility |
|----|-----|-------|----------|-----------------|
| F-01 | **Critical** | SSRF in `/api/probe` — no guard on user URL | `src/controllers/probeController.ts:339, 415` | PoC local: reach 127.0.0.1:8099 + decimal IP confirmed |
| F-02 | High | DNS-rebinding TOCTOU on `resolveAndPin` callers | `src/services/operatorVerificationService.ts:96-102`, `src/services/decideService.ts:253`, `src/crawler/serviceHealthCrawler.ts:43-55` | By code reading; mitigated by `redirect: 'error'` + JSON CT check |
| F-03 | High | `/api/probe` `fetch()` uses default `redirect: 'follow'` | `src/controllers/probeController.ts:339, 415` | Any initial guard would be bypassed by a 30x chain |
| F-01-bis | Medium | Rate limits do not defend against repeated SSRF | `src/config.ts:81-82`, Phase 9 C8 limiter | Economic model (see below) |
| F-07 | Medium | `/api/probe` response shape amplifies exfiltration | `src/controllers/probeController.ts:115-117, 420-430` | Code reading |
| F-04 | Low | npm audit — `elliptic` GHSA-848j-6mx2-7j84 via `bolt11 → secp256k1 → elliptic` | `package.json`, `npm audit` | `npm audit` (3 low) |
| F-05 | Low | Prod IP `178.104.108.108` hardcoded as default in SSRF utility | `src/utils/ssrf.ts:6` | Source grep |
| F-06 | Info | SSR boot JSON escape covers `</<>&` but not U+2028/U+2029 | `src/app.ts:382-385` | Code reading |
| — | Positive | `isSafeUrl`/`isUrlBlocked` correctly handle decimal/octal/hex IPv4 (WHATWG URL normalization) | `src/utils/ssrf.ts` | PoC `ssrf-utility-bypass.ts` — all 14 shapes blocked |

---

## F-01 — Critical: SSRF in `/api/probe`

### Evidence

`src/controllers/probeController.ts`, flow of `performProbe(url)`:

```ts
// line 67-69: Zod schema only enforces URL shape, not destination.
const probeBodySchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
});

// line 339: first fetch — no isSafeUrl, no resolveAndPin, default redirect 'follow'.
firstResponse = await fetch(url, {
  method: 'GET',
  signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
});

// line 415: second fetch (L402 retry) — same shape, same gap.
const secondResponse = await fetch(url, {
  method: 'GET',
  headers: { Authorization: authHeader },
  signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
});
```

Peer code in this repo *does* apply SSRF protection. `/api/probe` is the outlier:

| Caller | Guard |
|--------|-------|
| `src/crawler/registryCrawler.ts:139` | `isSafeUrl(serviceUrl)` |
| `src/services/operatorVerificationService.ts:97` | `resolveAndPin(url)` + `redirect: 'error'` |
| `src/crawler/serviceHealthCrawler.ts:43` | `resolveAndPin(endpoint.url)` + `redirect: 'manual'` |
| **`src/controllers/probeController.ts:339, 415`** | **— none —** |

### Reachability PoC (local)

`src/tests/security/ssrf-probe-poc.ts` — in-process, mock HTTP server on `127.0.0.1:8099`, `performProbe()` called directly (no auth, no LND, no DB debit path). Mock body contains the canary `INTERNAL_CREDENTIAL_NEVER_LEAK_ME`.

```
$ npx tsx src/tests/security/ssrf-probe-poc.ts

[PASS] 1. literal 127.0.0.1      → firstFetch.status=200  (SSRF reachable)
[FAIL] 2. hostname localhost     → "fetch failed"         (undici IPv6-first vs v4-only listener)
[PASS] 3. decimal IP 2130706433  → firstFetch.status=200  (SSRF reachable)
[FAIL] 4. userinfo confusion     → rejected by Node fetch (native WHATWG rule)
[PASS] 5. IMDS 169.254.169.254   → timeout after 10006ms  (blind-SSRF timing oracle)
```

*Interpretation:* any attacker with a deposit token reaches loopback through both the literal and decimal IP notations. The IMDS scenario fails to connect on the dev host but the 10 s timeout signal itself is a recon primitive on a cloud deployment. Exfiltration via `bodyPreview` was not proven in PoC (would require a mock L402 challenge + LND fake payment); it is covered by code reading in F-07 and is a straightforward chain.

### Preconditions

1. A deposit token (minimum `DEPOSIT_MIN_SATS=21`; `src/middleware/balanceAuth.ts` + `/api/deposit` flow).
2. Rate-limit budget (see F-01-bis).

No operator status, no API key, no LND credential required.

### Impact

- Blind/recon SSRF: internal host reachability via `firstFetch.status`, `firstFetch.latencyMs`, `firstFetch.httpError`.
- Direct exfiltration (once chained with a co-operated mock L402 server): `secondFetch.bodyPreview` (256 B), `bodyHash` (full sha256), `bodyBytes` (exact size). See F-07.
- Cloud metadata exposure (IMDS on AWS/GCP/Azure) — most valuable target; not reproducible on the non-cloud dev host but fully in-shape.

### Recommendation (deferred to Phase 11bis)

1. Call `await resolveAndPin(url)` on both fetches; return 400 if `null`.
2. Set `redirect: 'manual'` (or `'error'`) and reject any 3xx.
3. Optionally keep `bodyPreview` but consider whether to continue returning the sha256 and exact byte count — both are fingerprinting primitives.
4. Add an integration test that asserts `/api/probe` rejects each of the five shapes in `ssrf-probe-poc.ts`.

---

## F-02 — High: DNS-rebinding TOCTOU on `resolveAndPin` callers

### Evidence

Three call sites all follow the same pattern — validate via `resolveAndPin(url)`, then fetch the original URL, which re-resolves DNS:

```ts
// src/services/operatorVerificationService.ts:96-117
const pinned = await resolveAndPin(url);        // DNS query #1: validates public IP
if (pinned === null) return null;
const res = await fetch(url, { ... });          // DNS query #2: attacker flips record to 127.0.0.1
```

Same shape in `src/services/decideService.ts:253` and `src/crawler/serviceHealthCrawler.ts:43-55`.

### Mitigations present

- `redirect: 'error'` / `'manual'` caps chain depth.
- NIP-05 fetcher requires `Content-Type: application/json`; non-JSON internal endpoints are rejected after the connect.
- 5 s timeout on NIP-05 path.

### Residual

Reachability signal still leaks (timing + error message), which is exploitable as a blind-SSRF primitive. `decideService` path is partially off since `/api/decide` returns 410 Gone, but the underlying helper is still referenced.

### Recommendation (deferred)

Replace `resolveAndPin → fetch(url)` pattern with `fetch(https://<pinnedIp>, { headers: { Host: hostname } })` plus TLS SNI override, or use Node's [`dns.lookup` hook](https://undici.nodejs.org/#/docs/api/Dispatcher.md?id=dispatcherconnect) via a custom `undici.Agent`.

---

## F-03 — High: default `redirect: 'follow'` on `/api/probe`

Both fetches in `src/controllers/probeController.ts` (lines 339 and 415) omit `redirect`, inheriting Node's default `'follow'`. If F-01 is addressed by pinning the initial URL, an attacker can register `attack.example.com` that returns `301 http://127.0.0.1:8080/`. The probe follows the redirect without re-validating — circumventing any guard applied only to `url`.

**Recommendation:** set `redirect: 'manual'` and reject any 3xx explicitly, or set `redirect: 'error'` and catch the thrown TypeError.

---

## F-01-bis — Medium: rate limits are not an SSRF defense

### Economic model (per `src/config.ts:81-82` + Phase 9 limiter)

| Parameter | Value |
|-----------|-------|
| Deposit minimum | 21 sats (`DEPOSIT_MIN_SATS`) |
| `/api/probe` cost | 5 credits = 5 sats |
| Per-token rate limit | 10 probes / hour |
| Global rate limit | 100 probes / hour |
| Deposit ceiling | 10 000 sats (`DEPOSIT_MAX_SATS`) |

### Attacker math

- **Minimum buy-in:** 21 sats → 4 probes (1 every ~6 min per-token).
- **Sustained throughput:** 100 probes/h globally, regardless of how many tokens are minted. Cost: 500 sats/h ≈ **€0.30/h** at $60k/BTC.
- **/24 subnet scan (256 hosts):** 256 probes ÷ 100/h ≈ 2.5 h, total **≈1280 sats ≈ €0.75**.
- **IMDS probe:** 1 probe; cost **5 sats ≈ €0.003**.

### Residual

The rate limit is dimensioned for legitimate discovery burst suppression. It is not a security control; documenting it as one would misrepresent the posture.

### Recommendation (Phase 11bis)

After closing F-01 and F-03 at the URL layer, keep the existing rate limit — but do not credit it in the threat model.

---

## F-07 — Medium: `/api/probe` response shape amplifies exfiltration

### Evidence

`ProbeResult.secondFetch` (returned verbatim in `res.json({ data: result })`) exposes:

```ts
// src/controllers/probeController.ts:112-118
secondFetch?: {
  status: number;
  latencyMs: number;
  bodyBytes: number;   // exact body size — precise fingerprint
  bodyHash: string;    // sha256 of the full body — dictionary attack primitive
  bodyPreview: string; // first 256 bytes, control chars → '.'
};

// line 423: preview construction
const preview = body.subarray(0, 256).toString('utf8').replace(/[\x00-\x1f\x7f]/g, '.');
```

- **Size:** 256 bytes (not 1 KB as the original brief estimated).
- **Content-Type:** ignored — binary is replaced with `.` but everything else passes through UTF-8.
- **Headers:** none exposed — only status code leaks from the response envelope.

### Impact

Chained with F-01, this gives an attacker:

- 256 bytes of any internal HTTP response body whose status is exposed by a cooperating L402 challenge server (e.g. mock hosted externally, fetched via redirect from the first probe URL after F-03 is closed at the initial URL only).
- Full-body fingerprint via `bodyHash` even when the payload is > 256 B.
- Exact payload size via `bodyBytes`.

### Recommendation (Phase 11bis)

If `/api/probe` must continue to return body metadata for legitimate observability, strip `bodyHash` and `bodyBytes`, clamp `bodyPreview` to a smaller window (e.g. 64 B), and return a boolean `bodyLooksJson` rather than raw content. Headers are already withheld — keep them that way.

---

## F-04 — Low: `elliptic` vulnerable transitive dep

`npm audit --omit=dev` (2026-04-20):

```
elliptic  *
  GHSA-848j-6mx2-7j84 — "Uses a Cryptographic Primitive with a Risky Implementation"
Path: bolt11@* → secp256k1@>=2.0.0 → elliptic@*
Severity: low  (3 advisories)
Fix: npm audit fix --force → bolt11@1.0.0 (BREAKING)
```

### Impact

SatRank uses `bolt11` only to parse invoice `amount` and `paymentHash` in `src/utils/bolt11Parser.ts`. No signature verification path runs `elliptic` in our code, so the risky-primitive issue has no exploit surface here.

### Recommendation (Phase 11bis)

Defer until `bolt11@2.x` ships a compatible upgrade, or replace the parser with `@lightning/bolt11` which removes the elliptic dependency. Not blocking.

> **Phase 11ter note.** Investigation showed `bolt11@2.x` does not exist and `@lightning/bolt11` is not a published npm package. `light-bolt11-decoder` (fiatjaf) is the only viable elliptic-free alternative. See the **F-04 investigation** section above — accepted as case C.

---

## F-05 — Low: hardcoded prod server IP in SSRF utility default

```ts
// src/utils/ssrf.ts:6
const SERVER_IP = process.env.SERVER_IP ?? '178.104.108.108';
```

If the repo moves to a public surface (open-source release, fork on GitHub), the server IP is public. This doesn't enable attack paths by itself — the IP is also in the DNS record — but keeping environment-specific constants out of source is the cleaner posture.

### Recommendation (Phase 11bis)

Require `SERVER_IP` to be set explicitly (throw at startup if missing in production), or remove the default and let `isPrivateIp` return `false` if the env is unset (with a boot-time warning).

---

## F-06 — Info: SSR boot JSON escape misses U+2028/U+2029

`src/app.ts:382-385` escapes `</`, `<`, `>`, `&` before embedding SSR boot data into a `<script>` tag. It does not escape U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR), which terminate JS string literals in pre-ES2019 interpreters.

### Impact

Potential page breakage if a user-controlled field surfaces one of these characters. Not a security exploit — the script would fail to parse, not execute attacker code.

### Recommendation (Phase 11bis)

Extend the regex to replace `\u2028` and `\u2029` with their `\u` escapes, or run the JSON through `JSON.stringify` + `String.prototype.replace` for the two code points. Trivial diff.

---

## Positives confirmed

| Area | Observation |
|------|-------------|
| Secrets in source | `grep -Eri '(sk\|secret\|password)'` → zero hits under `src/` |
| SQL injection | Every repo uses `db.prepare(…).run(?, ?)` or `.get(?)`. Interpolated strings are internal table/column constants only |
| Constant-time compares | `safeEqual` (HMAC + `timingSafeEqual`) used for API key, Aperture token; `crypto.timingSafeEqual` used for preimage→hash in `depositController` and `reportService` |
| NIP-98 hardening | rawBody binding (C1 closed), asymmetric freshness window (M1 closed), uniform 'invalid' reason (M2 closed) |
| Aperture gate | Three paths correctly guarded (operator token, deposit bypass, localhost+L402); belt-and-suspenders `APERTURE_SHARED_SECRET` required in prod |
| SSRF utility | `isSafeUrl` / `isUrlBlocked` correctly block decimal/octal/hex IPv4 (WHATWG URL normalization — see `ssrf-utility-bypass.ts`) |
| Dockerfile | Non-root (uid 1001), `read_only: true`, `cap_drop ALL`, `no-new-privileges`, loopback-only ports, scoped LND macaroon (`offchain:read + offchain:write` only) |
| Config boot | `z.safeParse` → exit on invalid; placeholder rejection; `API_KEY` + `APERTURE_SHARED_SECRET` required in production; NODE_ENV guard prevents accidental dev-in-prod |
| TLS / nginx | TLS 1.2/1.3 only, modern ciphers, `client_max_body_size 16k`; XFF propagation safe with `trust proxy: 1` (Express reads rightmost non-trusted IP) |
| CSP | Strict prod policy: `default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'` |
| Cache hardening | Watchlist cache keys HMAC'd (audit H9 closed) |
| Rate limits | Global 100/min, deposit 3/min, probe 10/h per-token + 100/h global, metrics 30/min |
| Error handler | PASS_THROUGH_CODES whitelist, stack omitted in prod (H10 closed), body-parser syntax errors handled |

---

## Residual risks (non-findings)

1. **DNS rebinding after remediation** — any pure "resolve + re-fetch" pattern remains a window. Closing F-02 properly requires pinning the resolved IP into the request dispatcher, not just checking it.
2. **Aperture shared secret leakage** — the `X-Aperture-Token` path bypasses the L402 gate. If the secret leaks (a log line, a memory dump, a misconfigured reverse proxy), the attacker gets unlimited free access to paid endpoints. Operational concern, not a code bug.
3. **LND admin macaroon on-disk** — scoped (`offchain:read + offchain:write`) but still permits draining liquidity if the macaroon file is exfiltrated from the container. Mitigated by `read_only` + cap drops; not further reducible without HSM.
4. **SSR boot JSON U+2028/U+2029** — availability risk, not security; tracked as F-06.

---

## Prioritized remediation plan (Phase 11bis)

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| **P0 — blocker** | F-01, F-03 | Call `resolveAndPin(url)` on both fetches in `probeController.ts`; set `redirect: 'manual'`; reject 3xx. Add integration tests mirroring `ssrf-probe-poc.ts`. | S (≤ 1 day) |
| P1 | F-02 | Rewrite `resolveAndPin` callers to pin via `undici.Agent` DNS hook or direct-IP fetch with `Host` header. | M (2–3 days) |
| P1 | F-07 | Remove `bodyHash` and `bodyBytes` from `/api/probe` response; clamp `bodyPreview` to 64 B; add `bodyLooksJson` boolean. | S |
| P2 | F-01-bis | Update threat-model doc so rate limits are not credited as an SSRF defense; no code change. | XS |
| P3 | F-04 | Track `bolt11` releases via Dependabot; migrate to `light-bolt11-decoder` if a signing-path CVE surfaces. | S–M |
| P3 | F-05 | ~~Require `SERVER_IP` env in prod, no default.~~ **Closed** (`d68613c`). | XS |
| P3 | F-06 | ~~Extend SSR JSON escape for U+2028/U+2029.~~ **Closed** (`cbc5857`). | XS |

**Sequencing:** P0 first, in a single small PR gated on the new integration tests. P1 in a follow-up. P2/P3 bundled into a hygiene PR.

---

## Artifacts

Local-only PoC scripts, excluded from CI (no `.test.ts` suffix):

- `src/tests/security/ssrf-probe-poc.ts` — reachability PoC for F-01 (5 scenarios).
- `src/tests/security/ssrf-utility-bypass.ts` — validation artifact for the SSRF utility (14 bypass shapes, all blocked).

Run with `npx tsx <path>`.

---

## Audit methodology

- **C1 (enumeration + code reading):** All 30+ endpoints via `src/app.ts`; all controllers, services, repositories, middlewares; nginx config; Docker/compose; `.env.example`; `package.json` + `npm audit`.
- **C2 (hypothesis validation):** PoC for F-01 and F-08 run locally in-process. F-02 and F-03 validated by code reading and peer-comparison. F-04 via `npm audit --omit=dev`. F-05–F-07 via source grep + line reads.
- **C3 (PoC scripts):** `src/tests/security/` — reachability only, no exfiltration, no production targets.
- **C4 (this report).**
- **C5:** held back from public commit until Phase 11bis remediation was deployed and validated.
- **Phase 11bis (2026-04-20):** fix-then-publish sequence — `fetchSafeExternal` helper (`0eeb820`), hardened callers, rate-limit tightening, live validation on `satrank.dev` with a disposable test token, then public commit of this report and the PoC scripts.

No destructive action taken during audit. No production endpoint hit during C1–C4. Live validation in Phase 11bis hit production with a disposable test token; the five SSRF scenarios were all rejected pre-debit, no sats spent, token purged after.
