# SatRank Security Audit — 2026-04-16 (post-Tier 2 deploy)

_Scope: Tier 2 code, scaling abstractions, scoring refactor, new endpoints, observability, SDK 0.2.3, regression check on fundamentals, dependencies, supply chain, prod config._

Adversarial: attacker knows the architecture, reads the code, has a non-trivial budget. Findings ranked by severity.

---

## CRITICAL

### C1. NIP-98 payload tag **never checked** — full body-binding bypass

**File**: `src/middleware/nip98.ts:113` + `src/services/reportBonusService.ts:108`.

The verifier accepts a `rawBody` argument and only validates the `payload` tag when `rawBody !== null && rawBody.length > 0`. The caller passes `(req as Request & { rawBody?: Buffer | string }).rawBody ?? null`. **Express's `express.json()` middleware does NOT populate `req.rawBody`** (no `verify` callback wired — see `src/app.ts:174`). Consequence: `rawBody` is **always null at runtime**, the payload check is skipped on every call, and the signature only binds `u`/`method`/`kind`/`created_at` — not the body.

**Exploit (once Tier 2 is enabled AND npub cache has data)**:
1. Attacker signs ONE NIP-98 kind-27235 event with `u: https://satrank.dev/api/report`, `method: POST`, any `payload` tag (or none).
2. Within the 60s freshness window, they fire N POSTs to `/api/report` with arbitrary bodies (different targets, outcomes, preimages) — all accepted as "validly signed by their aged npub".
3. Each verified report counts toward their 10-report bonus threshold. With a single signed envelope they unlock the cap.

**Severity**: CRITICAL because it directly defeats the anti-sybil design that Tier 2 rests on. Mitigated today only by `REPORT_BONUS_ENABLED=false` and `nostr-pubkey-ages.json` being empty. Activating either side of the gate makes this live.

**Fix**: restore raw body capture via `express.json({ limit: '10kb', verify: (req, _res, buf) => { (req as ...).rawBody = buf; } })` and assert `rawBody !== null` before admitting NIP-98 paths.

---

### C2. `/metrics` API key comparison is **not constant-time**

**File**: `src/app.ts:276` (`apiKey === config.API_KEY`) and `src/crawler/metricsServer.ts:46` (`apiKey !== config.API_KEY`).

Both endpoints accept `X-API-Key` from the internet (no upstream rate limit — `apiRateLimit` is scoped to `/api/*` only). JS `===` on strings is not timing-safe: two implementations can differ microsecondally based on first differing character.

**Exploit**: send millions of guesses. Each response time leaks whether the current prefix matches. Over ~5M requests with ~20ns discrimination per byte, recover the 64-hex key. No rate limit → trivially automatable.

`src/middleware/auth.ts:24-30` already exports a `safeEqual` helper used by `reportAuth` and `apertureGateAuth`. The two `/metrics` sites didn't get the helper.

**Severity**: CRITICAL because the API_KEY unlocks write endpoints (`POST /attestations`), metrics (business intel), crawler metrics. Single secret, multiple consequences.

**Fix**: replace both with `safeEqual(apiKey, config.API_KEY)`, add a low-rate limiter (`max: 20/min`) to both.

---

### C3. Auto-rollback guard math measures the wrong thing

**File**: `src/services/reportBonusService.ts:193-213`.

`snapshotSafeRate()` computes `SAFE_cumulative / total_cumulative` from the Prometheus counter directly. `verdictTotal` is a monotonically-increasing counter — once the service has seen 1M verdicts at 10% SAFE, the cumulative ratio is pinned at 0.10. A 1,000-report SAFE spike moves the cumulative ratio by 0.0001 — nowhere near the `1.3× baseline` trigger.

**Exploit**: attacker activates Tier 2 (or waits for operator to), then floods verified reports via any accepted gate. The scoring gradually absorbs the poisoning; the guard never fires because cumulative ratio barely moves. The "auto-rollback" is **structurally unable to trip** under any real attack.

**Fix**: compare a SHORT-WINDOW rate, not cumulative. Either (a) snapshot the cumulative at baseline AND at every guard tick, compute `Δsafe/Δtotal` for the interval; (b) add a rolling window via `satrank_verdict_total` differentiated in Prometheus and passed to the guard; (c) use `rate()` via a Prometheus client pull.

**Severity**: CRITICAL because the operator believes auto-rollback exists. False sense of security is worse than no safety net.

---

### C4. watchlist cache key truncated to **64 bits** — second-preimage / privacy crossover

**File**: `src/controllers/watchlistController.ts:67`.

`sha256(sortedHashes.join(',')).slice(0, 16)` = 8 bytes = 2^64 space. Birthday collision expected at ~2^32 (4 B requests). Second-preimage against a specific user: ~2^64 (hard but finite for a motivated adversary).

**Exploit**: find two distinct `targets` lists whose keys collide. Query both — the cached payload is shared. One user's target list + since-bucket collapses with another, leaking which targets someone is watching.

**Fix**: use the full hex digest (or at minimum 32 hex = 128 bits). Zero perf cost.

**Severity**: CRITICAL because the feature is privacy-sensitive (who is watching whom) and the mitigation is literally deleting `.slice(0, 16)`.

---

## HIGH

### H1. Semaphore has no queue bound — LND-pathfinding DoS

**File**: `src/utils/semaphore.ts:6`.

`queue: Array<() => void> = []` is unbounded. With `max=10` and 100k concurrent requests, 99,990 waiters sit in memory with no timeout. OOM at scale; tail latency catastrophic even before OOM.

**Exploit**: flood `/api/decide` or `/api/best-route` (both gated behind the shared LND semaphore). Tokens cost 1 sat each but the attacker can issue thousands of concurrent requests from a funded token before balance exhausts.

**Fix**: cap queue (e.g. `max × 10` waiters), reject with 503 beyond. Add per-waiter timeout.

---

### H2. Semaphore permit-leak on double-release

**File**: `src/utils/semaphore.ts:14`.

`return () => this.release();` — caller receives a closure with no "already called" guard. A buggy caller double-calling → `inflight` goes negative → unlimited concurrency past the cap. Today's call sites use try/finally correctly, but a future refactor could silently uncap LND concurrency.

**Fix**: one-shot release via internal `released` flag; subsequent calls are no-ops.

---

### H3. NIP-98 URL binding relies on attacker-controlled `Host` header

**File**: `src/services/reportBonusService.ts:106-107`.

`const host = req.headers.host ?? 'satrank.dev'; const fullUrl = \`https://${host}${req.originalUrl.split('?')[0]}\`;` — the URL used for the `u` tag match comes from the incoming request's `Host` header (attacker-controlled). An attacker sends `Host: evil.com` + signed event with `u: https://evil.com/api/report` → verifier validates same-host + signature passes.

This defeats the entire "bind this signature to satrank.dev" guarantee. The attacker can replay/craft signatures without knowing the production hostname.

**Fix**: canonicalize to a known constant (`config.CORS_ORIGIN` or a new `PUBLIC_HOST`). Ignore the client's `Host`.

---

### H4. SSRF: `isPrivateIp` misses RFC6598 CGN range + no IPv6 AAAA resolution

**File**: `src/utils/ssrf.ts:2-17` + `src/services/decideService.ts:114`.

- `100.64.0.0/10` (RFC6598 Carrier-Grade NAT) not blocked — can target ISP infrastructure.
- `resolveAndPin` uses `resolve4` only — AAAA records ignored. A hostname with only an AAAA record pointing to `::1` or `fc00::/7` would fail `resolve4` (no A record) and return null safely, BUT a hostname with A→safe_ip AND AAAA→private_ipv6 would pass A-check; if the OS resolver later prefers IPv6 (dual-stack), fetch targets IPv6.

In practice Node's `fetch` respects the pinned hostname from `u.hostname = pinnedIp` (IPv4), so IPv6 exposure is less critical. But CGN is a real leak.

**Fix**: add `100.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.` pattern; always `resolve6` alongside `resolve4` and reject if any AAAA hits a private range.

---

### H5. `findServices` default sort — pollution via `check_count`

**File**: `src/repositories/serviceEndpointRepository.ts:149`.

Default sort is `ORDER BY se.check_count DESC`. An attacker who registers their service endpoint (via `/api/services/register`) then forces many health checks via `/api/decide?serviceUrl=...` inflates `check_count`. Their entry floats to the top of the candidate pool. `/api/services/best` pulls the top 100 by the same sort → pollution propagates into the "bestQuality/bestValue/cheapest" selections.

Rate limits on `/api/services/register` (10/min) + `/api/decide` (1 sat/call) cap the absolute rate but not the relative advantage at low network scale.

**Fix**: combine `check_count` with `score * success_rate` in the default sort so fresh spam can't out-rank legitimate entries.

---

### H6. Prod code `/metrics` endpoint has **no rate limit**

**File**: `src/app.ts:270`.

The `/metrics` handler is mounted outside `api.use(apiRateLimit)`. Combined with C2 (timing comparison), the key can be brute-forced at network line rate. Same on crawler (`src/crawler/metricsServer.ts`).

**Fix**: add `rateLimit({ windowMs: 60_000, max: 30 })` as a dedicated `metricsRateLimit` and apply to both the API and crawler scrape endpoints.

---

### H7. `reportStatsController` leaks business intelligence

**File**: `src/controllers/reportStatsController.ts` (the whole file).

`/api/stats/reports` is public (discoveryRateLimit, 10/min/IP). Exposes: `totalSubmitted`, `totalVerified`, `distinctReporters`, `bonus.totalBonusesGranted`, `bonus.totalSatsPaid`, `bonus.distinctRecipients`, weekly buckets. A competitor building a rival oracle can map SatRank's adoption curve + payout spend with zero cost.

**Severity**: HIGH for business intel, not user PII.

**Fix**: gate behind X-API-Key OR round to nearest 10 OR remove `bonus.*` fields from the public path.

---

### H8. Deposit invoice value parseInt with no NaN guard

**File**: `src/controllers/depositController.ts:191`.

`const quota = parseInt(invoice.value, 10);` — if LND returns a non-numeric `value` (e.g., `"0"` invoice or malformed response), `quota` can be 0 or NaN. NaN passed to better-sqlite3 INSERT on line 149 becomes null-ish, possibly `0` depending on driver behavior. User pays the invoice but gets 0-balance token.

Probably a LND-integrity issue, not an attack — but worth a validation gate.

**Fix**: `if (!Number.isFinite(quota) || quota <= 0) throw new ValidationError('Invoice value invalid')`.

---

### H9. Watchlist cache keys deterministic → cache-poisoning side-channel

**File**: `src/controllers/watchlistController.ts:67`.

Same key for same `(sortedHashes, sinceBucket)` means any attacker knowing a user's watchlist can predict their exact cache slot. With C4's truncation, probabilistic enumeration of top-N users' keys is cheap. A privacy leak without collision: an attacker who simply asks the same key gets the same payload (= the user's watched changes).

**Fix**: include a user-specific salt (if reporter is authenticated) — e.g. hash (sortedHashes + since + caller_hash). Or accept that watchlist data is non-secret.

---

### H10. Error handler logs full `err` object — stack trace in logs

**File**: `src/middleware/errorHandler.ts:80`.

`logger.error({ err, requestId: req.requestId }, 'Unhandled internal error')` — pino serializes Error object → stack trace with internal paths, function names, Node version. If logs ever leak (log aggregation compromise, misconfigured remote shipping), internal topology is exposed.

**Fix**: strip stack in production `logger.error({ message: err.message, requestId: req.requestId }, ...)`. Keep stack in dev via `NODE_ENV` check.

---

## MEDIUM

### M1. NIP-98 `created_at` window is symmetric (accepts future events)

**File**: `src/middleware/nip98.ts:99`.

`Math.abs(now - event.created_at) > NIP98_MAX_AGE_SEC` → accepts events up to 60s in the future. An attacker with predictable clock skew can pre-sign batches for future delivery. Micro-extends the replay window.

**Fix**: `if (event.created_at < now - 60 || event.created_at > now + 10) reject`.

---

### M2. NIP-98 reason codes are specific — leak exact breakage point

**File**: `src/middleware/nip98.ts` — every return.

If the `reason` field ever reaches the client (currently only logged at warn), it tells the attacker exactly which part of their forgery failed (`url_mismatch` vs `bad_signature` vs `stale_or_future_event`). Oracle for iterating attacks.

**Fix**: collapse to a single `reason: 'invalid'` in the returned object; keep granularity only in server logs.

---

### M3. `reportBonusGateTotal.inc({ gate })` fires even when bonus is disabled

**File**: `src/services/reportBonusService.ts:140`.

Counter increments on every verified report regardless of `enabled`. This gives an attacker free oracle access to determine whether their NIP-98 signature would pass the gate, without risking a real bonus credit (since the bonus is off). They can probe the gate's behavior silently.

Low impact while cache is empty (NIP-98 always fails) but becomes relevant when Tier 2 is live.

**Fix**: early-return before `reportBonusGateTotal.inc` if `!this.enabled`; emit the counter only when the decision would actually matter.

---

### M4. `evaluateEligibility` loads snapshot for every report (unauthenticated path)

**File**: `src/services/reportBonusService.ts:93`.

`scoringService.getScore(reporterHash).total` runs on every report submission, even when `enabled=false`. Under flood conditions this is a DB + scoring round-trip per request. Not a DB hammer (scoring has its own cache) but asymmetric: the attacker pays 1 sat, we pay ~20ms of compute including snapshot lookup.

**Fix**: short-circuit when `!enabled` AND non-verified.

---

### M5. Npub cache reload only called once at boot

**File**: `src/app.ts:140` + `src/nostr/npubAgeCache.ts:43`.

`npubAgeCache.reload()` is called once. If a future Stream B enhancement writes to the file, the cache stays stale until process restart. Operator surprise: "I updated the file, why isn't it picked up?".

**Fix**: schedule `setInterval(() => npubAgeCache.reload(), 3600_000)` or watch the file via `fs.watch`.

---

### M6. `req.url !== '/metrics'` doesn't strip query string

**File**: `src/crawler/metricsServer.ts:35`.

`req.url` includes `?foo=bar`. A scraper using `/metrics?instance=crawler` returns 404. Minor, but surprising.

**Fix**: `const path = req.url?.split('?')[0]; if (path !== '/metrics') ...`.

---

### M7. Nginx `ssl_protocols` not explicitly set

**File**: `/etc/nginx/sites-enabled/satrank*` (prod).

Default Nginx config allows OS defaults — may include TLS 1.0/1.1 on older distros. No explicit cipher ordering. HSTS is delivered at the Express layer (helmet), so missing it at nginx is not fatal, but breaks the "defense in depth" rule.

**Fix**: `ssl_protocols TLSv1.2 TLSv1.3;` + `ssl_ciphers HIGH:!aNULL:!MD5;` + `ssl_prefer_server_ciphers on;`.

---

### M8. Nginx `client_max_body_size` default (1 MB) — express caps at 10kb anyway

**File**: nginx config.

If nginx accepts 1MB, the body travels the wire + upstream before Express rejects. DoS amplifier.

**Fix**: `client_max_body_size 16k;` at server block.

---

### M9. `/opt/satrank` directory owned by rsync UID (501)

**File**: server filesystem.

`drwxr-xr-x 11  501 staff` — UID 501 is the operator's local UID, preserved by rsync. If another user with UID 501 ever exists on the server, they gain write access. Cosmetic on a single-user server but not best-practice.

**Fix**: `chown -R root:root /opt/satrank` after each deploy (add to Makefile deploy target).

---

### M10. `tokenQueryLog` re-prepares statement each call

**File**: `src/utils/tokenQueryLog.ts:42`.

Every paid target-query (5 endpoints) calls `db.prepare(...)` freshly. SQLite caches internally but the cache churns on heavy traffic.

**Fix**: hoist `prepare` once and export the prepared statement.

---

### M11. `elliptic` CVE (GHSA-848j-6mx2-7j84) in bolt11 dependency chain

**File**: `package-lock.json`.

`bolt11@1.4.1 → secp256k1@4.0.4 → elliptic@6.6.1` — Minerva-class ECDSA timing leak. `bolt11` is an indirect transitive (not imported directly in our code) but it's still in the install tree. An attacker with access to our process memory could exploit.

**Fix**: `npm audit fix` — it's available. Or drop the transitive if reachable.

---

### M12. Dev `vite` vulnerabilities (path traversal + WebSocket file read)

**File**: `package-lock.json`.

Vite is dev-only (vitest). Prod images don't ship dev dependencies. But if developers run the vite dev server exposed on 0.0.0.0, path traversal and arbitrary file read are trivial.

**Fix**: `npm audit fix` (SemVer-major — may bump vite to 7.x; validate tests).

---

## LOW

### L1. Dynamic ESM `await import('nostr-tools/pure')` per NIP-98 verify

**File**: `src/middleware/nip98.ts:128`. Minor perf, no security impact. Cache is Node-level, but the re-import is measurable at > 10k req/s.

### L2. `utcDay` computed outside transaction

**File**: `src/services/reportBonusService.ts:156`. Theoretical midnight-crossing race, ms-scale. Not exploitable.

### L3. `isSafeUrl` tolerates embedded credentials via fragment/query shenanigans

**File**: `src/utils/ssrf.ts:24`. `u.username || u.password` only checks the parsed URL. WHATWG URL parser handles `http://user:pass@host` correctly. Confirmed safe.

### L4. SDK error subclasses named `SatRankError`-suffixed — conflict with user code

**File**: `sdk/src/client.ts:37`. Naming, not security. SDK users overriding `ValidationError` in their app might be surprised.

### L5. Stack trace in `logger.warn({ error: msg, stack: err.stack?.split('\n').slice(0, 5) }, ...)`

**File**: `src/crawler/run.ts:48`. Stack trace for uncaught exceptions. 5-line cap is reasonable. Logged warn, not exposed.

### L6. Node `--experimental-require-module` flag

**File**: `Dockerfile:52` + `docker-compose.yml:57`. Using experimental flag. If Node 22 changes semantics, imports break. Operational, not security.

### L7. Memory cache `MAX_ENTRIES = 500`

**File**: `src/cache/memoryCache.ts:20`. LRU eviction prevents unbounded growth. But 500 entries × unbounded value size = still up to GBs. Not an attack, worth a value-size cap.

### L8. Reporter hash truncated to 12 chars in logs

**File**: multiple. `reporterHash.slice(0, 12)`. 48 bits still uniquely identifies in practice. Privacy nuance.

### L9. `progressPct` rounding: `Math.min(100, ...)`

**File**: `src/controllers/reportStatsController.ts:110`. If `totalSubmitted > TARGET_N`, caps at 100. Correct. But operators might want to see overshoot — consider removing cap once target is hit.

### L10. `reportStatsController` caches under a FIXED key

**File**: `src/controllers/reportStatsController.ts:16`. If someone adds a query-string variant (e.g., `?days=7`), they'd collide with the default 30-day cache. Currently no parameter accepted — safe, but fragile.

---

## Supply chain & npm publish

- SDK `@satrank/sdk` is published on npm. Token management / 2FA status is out-of-band — operator-specific.
- **Typosquatting surface**: `@satrank/sdk` is the only scope-owned name. Non-scope variants (`satrank`, `sat-rank-sdk`, `satrank-client`) are **not** registered by SatRank — anyone could publish malicious look-alikes. **Recommendation**: pre-register the obvious variants as empty packages pointing to `@satrank/sdk` README.
- Package contains no postinstall scripts (verified by inspecting the installed tarball would be needed — worth an explicit `npm pack && tar tf` pre-publish step).

---

## Regression check on fundamentals

| Area | Status | Notes |
|---|---|---|
| SSRF | ⚠️ REGRESSED | 100.64/10 CGN range unblocked (H4). IPv6 AAAA partially ignored. |
| SQL injection | ✅ | All repositories use parameterized statements; dynamic `WHERE` builders use bind params. LIKE wildcards unescaped but parameter-bound (expected search behavior). |
| Rate limiting | ⚠️ REGRESSED | `/metrics` endpoints (API + crawler) excluded. /api/stats/reports rate-limited at discovery tier (10/min) — OK. |
| Deposit race | ✅ | `checkAndInsert` wrapped in tx; L402 balance decrement is SQL-atomic. |
| Auth bypass | ✅ | apertureGateAuth path B / C correctly enforced. `/api/report` auth widened (Action from prior session) — reviewed, correct. |
| Log PII | ⚠️ MINOR | Stack traces include internal paths (M10). Hash truncation consistent. |
| Secrets | ✅ | .env.production is chmod 600 root:root. No secret in repo or logs. |

---

## Prioritized remediation order

1. **C1** — wire `express.json({ verify })` to capture rawBody. **30 min.**
2. **C2** — replace `===`/`!==` with `safeEqual` in both `/metrics` sites. **10 min.**
3. **H6 / M6** — add rate limit + strip query string on `/metrics`. **15 min.**
4. **C3** — rewrite guard to compare short-window deltas. Requires sampling design. **2h.**
5. **C4** — remove `.slice(0, 16)` in watchlist cache key. **1 min, zero risk.**
6. **H1 / H2** — bound semaphore queue + one-shot release. **30 min.**
7. **H3** — canonicalize `u` tag to a fixed host. **15 min.**
8. **H4** — add 100.64/10 + AAAA resolve. **30 min.**
9. **H5** — combine `check_count` with score×uptime in default sort. **30 min.**
10. **H7** — API-key-gate the `bonus.*` fields. **15 min.**
11. **M11 / M12** — `npm audit fix` + validate. **30 min.**
12. The rest as capacity permits.

Total CRITICAL + HIGH remediation: **half a day of focused work**. None of these are blocking current production behavior since Tier 2 is flag-off and the attacker-observable surface is small — but activating Tier 2 without C1–C4 fixed would be genuinely dangerous.
