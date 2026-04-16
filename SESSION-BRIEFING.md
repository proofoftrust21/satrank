# SatRank — Session Briefing (2026-04-16)

> Handoff document for the next Claude Code instance. This session ran out of context; read this file end-to-end before acting.
> Romain (French founder) makes every product decision — never propose launches, ship dates, or scope changes without explicit ask.

---

## 1. Session outcomes — what was delivered

### 1.1 Scoring audit (SCORING-AUDIT.md) — 3 actions shipped
- **LN+ positive ratings multiplier deprecated**: `lnPlusRatings` no longer applies a post-composite multiplier. Constants kept in `src/config/scoring.ts` marked `@deprecated` to avoid breaking consumers, but multiplier path removed. PageRank now the 100% reputation backbone.
- **Reputation sub-signal instrumentation**: `computeLightningReputationBreakdown(node)` returns `{ score, breakdown }`. `ScoreComponents.reputationBreakdown?: ReputationBreakdown` surfaces `subsignals` with per-slot `{ value, weight, available }`. Slots: pagerank, peerTrust, routingQuality, capacityTrend, feeStability. Dynamic renormalization: when a slot is unavailable (e.g., feeStability=0 for new nodes), weight redistributes across available slots instead of crushing the score to 0.
- **Report adoption strategy D (Tier 1 + Tier 2-dormant)**: Tier 1 shipped live, Tier 2 coded but `REPORT_BONUS_ENABLED=false` by default.

### 1.2 Tier 1 — Reporter badge (live, no economic surface)
- `/api/profile/:id` → `reporterStats: { badge, submitted30d, verified30d, breakdown, trustedThreshold }`.
- Badge ladder (matches `src/controllers/v2Controller.ts`): `reporter` (1+ submitted), `active_reporter` (5+ submitted), `trusted_reporter` (20+ verified reports). Threshold for `trusted_reporter` is `TRUSTED_REPORTER_THRESHOLD = 20` in code.
- No payout, no gaming surface.

### 1.3 Tier 2 — Economic bonus (code complete, flag OFF)
- **Schema v29** — `report_bonus_log(reporter_hash, utc_day, eligible_count, bonuses_credited, total_sats_credited, last_credit_at)` with rollback in `src/database/migrations.ts`.
- **Config** (`src/config.ts`) — 8 new env vars:
  - `REPORT_BONUS_ENABLED=false` (master kill-switch)
  - `REPORT_BONUS_THRESHOLD=10` (reports per bonus)
  - `REPORT_BONUS_DAILY_CAP=3` (max bonuses/day/reporter)
  - `REPORT_BONUS_SATS=1` (sats per bonus)
  - `REPORT_BONUS_MIN_REPORTER_SCORE=30`
  - `REPORT_BONUS_MIN_NPUB_AGE_DAYS=7`
  - `REPORT_BONUS_ROLLBACK_RATIO=1.3` (1h vs 24h baseline)
  - `REPORT_BONUS_GUARD_INTERVAL_MS=300000` (5 min)
  - `PUBLIC_HOST` (used in NIP-98 canonical URL to prevent Host-header spoof)
- **NIP-98** (`src/middleware/nip98.ts`):
  - Asymmetric window: PAST=60s, FUTURE=5s
  - Consolidated public `reason: 'invalid'` + private `detail` (no oracle leak)
  - Static `nostr-tools/pure` import with WebCrypto polyfill at module top
  - Mandatory `req.rawBody` enforcement on POST/PUT/PATCH (C1 fix — `express.json({ verify })` populates it)
- **Npub age cache** (`src/nostr/npubAgeCache.ts`) — `startAutoReload()` hourly, unref'd.
- **Repository** (`src/repositories/reportBonusRepository.ts`) — daily counter ops.
- **Service** (`src/services/reportBonusService.ts`):
  - Windowed auto-rollback guard: 1h window vs 24h baseline, trip if ratio > `REPORT_BONUS_ROLLBACK_RATIO`, MIN_VERDICTS=100 to avoid false trips on low volume.
  - `maybeCredit` short-circuits on `!enabled` before eligibility checks.
  - Canonical URL built from `config.PUBLIC_HOST`, not `req.headers.host`.
- **Dashboard** (`src/controllers/reportStatsController.ts`) — `/api/stats/reports` public summary; `bonus.*` fields gated behind `X-API-Key`.
- **Tests**:
  - `src/tests/reportBonus.test.ts` — 7 tests (gate / threshold / cap / rollback)
  - `src/tests/nip98.test.ts` — 10 tests (C1 rawbody-not-captured, M1/M2 window, reason consolidation)

### 1.4 Observability (OBSERVABILITY-AUDIT.md / OBSERVABILITY-COVERAGE.md / OBSERVABILITY-BACKLOG.md)
- 22+ Prometheus metrics live.
- `/api/stats/reports` dashboard endpoint.
- `X-Request-Id` header propagation through middleware and errors.
- `metricsRateLimit` (30/min) on `/metrics`.
- Crawler exposes `/metrics` on `:9091` (in-memory rate limit + safeEqual + query-string stripping).

### 1.5 Security hardening (SECURITY-AUDIT-2026-04-16-v2.md) — 36 findings, 23 fixed + 9 LOW declined
Phase 1 (quick wins):
- Watchlist cache key: full HMAC-SHA256 digest using `config.API_KEY` (no more 64-bit truncation).
- `/metrics` constant-time compare via `safeEqual` (exported from `src/middleware/auth.ts`).
- API key compare in `src/app.ts` uses `safeEqual(apiKey, config.API_KEY)`.

Phase 2 (SSRF + semaphore):
- `src/utils/ssrf.ts` — `isPrivateIp` extended: CGN 100.64/10, multicast 224-239, reserved 240-255, 255.255.255.255, IPv6 private.
- `resolveAndPin` in `src/services/decideService.ts` — `Promise.all([resolve4, resolve6])`, reject if any returned IP is private.
- `src/utils/semaphore.ts` — `new Semaphore({ max, maxQueue, name })` with `SemaphoreFullError` and one-shot release (`let released = false`).
- `src/crawler/lndGraphClient.ts` — `new Semaphore({ max: 10, maxQueue: 50, name: 'lnd_queryRoutes' })`.

Phase 3 (NIP-98 + prod logging + deposit + invoices):
- NIP-98 rawBody pipeline (see 1.3).
- `src/middleware/errorHandler.ts` — prod logs `{errName, errMessage, requestId}` only, no stack.
- `src/controllers/depositController.ts` — `NaN` guard on `parseInt(invoice.value)` → 502 UPSTREAM_INVALID.
- `src/controllers/serviceController.ts` — `/api/services/best` now `sort: 'uptime'` (not default check_count).

Phase 4 (infra + Nginx + zap):
- `src/utils/tokenQueryLog.ts` — `WeakMap<Database, Statement>` prepared-statement cache.
- `src/nostr/zapMiner.ts` — Minerva CVE documented as non-exploitable (verify-only, no signing).
- `Dockerfile` — `npm ci --omit=dev` marked CRITICAL with audit ref.
- `Makefile` deploy target — `ssh chown -R root:root $(REMOTE_DIR) && chmod 600 .env.production`.
- Nginx (live on prod at `/etc/nginx/sites-enabled/satrank`, backup `/root/nginx-satrank-backup-20260416.conf`):
  - `ssl_protocols TLSv1.2 TLSv1.3;`
  - `ssl_ciphers` explicit strict suite (ECDHE-ECDSA/RSA + GCM/CHACHA20-POLY1305)
  - `ssl_prefer_server_ciphers on;`
  - `ssl_session_cache shared:SSL:10m;`
  - `client_max_body_size 16k; client_body_buffer_size 16k;`

9 LOW findings declined (documented in SECURITY-AUDIT file with rationale).

### 1.6 SDK + typosquat shells
- `@satrank/sdk@0.2.3` published to npm (official).
- `sdk/RELEASE-POLICY.md` shipped (versioning, changelog rules).
- `sdk/typosquat-shells/README.md` documents the defensive namespace-squat strategy.

**Typosquat shells — publication status (npm):**

| Package | Status | Notes |
|---|---|---|
| `satrank` | PUBLISHED 0.0.1 | |
| `satrank-sdk` | PUBLISHED 0.0.1 | |
| `satrank-client` | PUBLISHED 0.0.1 | |
| `sat-rank-sdk` | PUBLISHED 0.0.1 | |
| `sat-rank-client` | PUBLISHED 0.0.1 | |
| `satrank-js` | PUBLISHED 0.0.1 | |
| `satrank-node` | PUBLISHED 0.0.1 | |
| `satrank-core` | PUBLISHED 0.0.1 | |
| `satrank-api` | PUBLISHED 0.0.1 | |
| `satrank-cli` | PUBLISHED 0.0.1 | |
| `satrank-oracle` | PUBLISHED 0.0.1 | |
| `satrank-agent` | PUBLISHED 0.0.1 | |
| `satrnak` | PENDING | rate-limited 429 — retry later |
| `satrrank` | PENDING | rate-limited 429 — retry later |
| `lightning-trust-oracle` | PENDING | rate-limited 429 — retry later |
| `sat-rank` | BLOCKED by npm policy | 403 — npm's own typosquat-protection already protects this name, no action needed |

All published shells share the same payload: `console.warn` deprecation notice + `module.exports = { __deprecated__: true, install: '@satrank/sdk', message }`. `package.json` has `"deprecated"` string field to surface the warning on `npm install`.

---

## 2. Code state (exact)

- **Schema**: v29 (last migration: `report_bonus_log`).
- **Tests**: 561/561 passing.
- **SDK**: `@satrank/sdk@0.2.3` on npm.
- **App version**: 0.1.0 (`package.json`).
- **Branch**: main, no uncommitted churn expected.
- **Tier 2 flag**: `REPORT_BONUS_ENABLED=false` on prod — code paths fully wired but dormant.

### Key new/updated files (this session)
- `src/services/scoringService.ts` — LN+ deprecated, `computeLightningReputationBreakdown`, dynamic renorm.
- `src/types/index.ts` — `ReputationBreakdown`, `ScoreComponents.reputationBreakdown`.
- `src/config/scoring.ts` — LN+ constants `@deprecated`.
- `src/database/migrations.ts` — v29 with rollback.
- `src/config.ts` — 8 new REPORT_BONUS_* + PUBLIC_HOST.
- `src/middleware/nip98.ts` — full rewrite (rawbody, asymmetric window, reason consolidation).
- `src/middleware/auth.ts` — `safeEqual` exported.
- `src/middleware/errorHandler.ts` — prod log scrubbing.
- `src/nostr/npubAgeCache.ts` — auto-reload.
- `src/nostr/zapMiner.ts` — Minerva documentation.
- `src/repositories/reportBonusRepository.ts` — new.
- `src/services/reportBonusService.ts` — new, windowed guard.
- `src/services/decideService.ts` — resolveAndPin dual-stack.
- `src/controllers/reportStatsController.ts` — new, `/api/stats/reports`.
- `src/controllers/depositController.ts` — NaN guard.
- `src/controllers/serviceController.ts` — `sort: 'uptime'`.
- `src/controllers/watchlistController.ts` — full HMAC cache key.
- `src/utils/ssrf.ts` — extended private-IP ranges.
- `src/utils/semaphore.ts` — bounded queue + one-shot release.
- `src/utils/tokenQueryLog.ts` — WeakMap prepared cache.
- `src/crawler/lndGraphClient.ts` — bounded semaphore.
- `src/crawler/metricsServer.ts` — in-memory RL + safeEqual.
- `src/app.ts` — `express.json({ verify })`, dedicated `metricsRateLimit`, bonus service wiring, npub cache auto-reload.
- `Dockerfile` — `npm ci --omit=dev` hardening.
- `Makefile` — deploy target ownership + perms.
- `src/tests/reportBonus.test.ts` — 7 new tests.
- `src/tests/nip98.test.ts` — 10 new tests.

---

## 3. Reference documents (all at repo root unless noted)

| Doc | Purpose |
|---|---|
| `SCORING-AUDIT.md` | Full scoring v26+ post-Option-D audit: distribution, correlations, variance, pathological cases, weight sensitivity, attack robustness, sub-signal instrumentation plan |
| `REPORT-INCENTIVE-DESIGN.md` | Tier 1 badge + Tier 2 bonus design, strategy-D rationale, activation criteria (Day-30 checkpoint) |
| `OBSERVABILITY-AUDIT.md` | Root observability audit findings |
| `OBSERVABILITY-COVERAGE.md` | What's instrumented today (metrics, endpoints, alerts) |
| `OBSERVABILITY-BACKLOG.md` | Remaining observability work |
| `SECURITY-AUDIT-2026-04-16-v2.md` | Full 36-finding audit, phase-by-phase fixes, LOW declinations with rationale |
| `sdk/RELEASE-POLICY.md` | SDK versioning / changelog / deprecation policy |
| `sdk/typosquat-shells/README.md` | Typosquat defense strategy |
| `CLAUDE.md` | Project conventions, scoring weights, architecture, commands |
| `INTEGRATION.md` | Agent integration guide |
| `DEPLOY.md` | Deploy procedure |
| `IMPACT-STATEMENT.md` / `IMPACT-STATEMENT-FULL.md` | WoT-a-thon submission |

---

## 4. In progress — monitor but do not intervene

### 4.1 48-72h empirical scoring validation
- **Script**: `/root/scoring-validation.sh` on prod (178.104.108.108).
- **Panel**: `/root/scoring-validation-panel.csv` — 30 diverse LN nodes.
- **Cron**: `*/30 * * * * /root/scoring-validation.sh` — snapshots every 30 min.
- **Output**: `/root/scoring-validation/snapshots.csv` (append mode).
- **Started**: ~2026-04-16 mid-session.
- **Completes**: 2026-04-18 to 2026-04-19 (48-72h window).
- **Purpose**: Verify reputation sub-signal distributions match model expectations after dynamic renorm; detect any slot systematically collapsing to 0/100.
- **Action on completion**: Read the CSV, compute per-slot variance + availability rate, report to Romain.

### 4.2 Tier 2 Day-30 checkpoint
- **Date**: ~2026-05-16 (30d from 2026-04-16 shipping).
- **Gate**: Read `/api/stats/reports`. If `summary.progressPct < 50` (fewer than 100 of target 200 reports), propose flipping `REPORT_BONUS_ENABLED=true` to Romain.
- **Do NOT flip the flag autonomously** — this is a product decision. Surface the data, wait for Romain's call.
- **Guard is armed**: windowed rollback (1h vs 24h × 1.3, MIN_VERDICTS=100) will auto-disable if abuse detected post-activation.

---

## 5. Pending work — not started, needs Romain's input

### 5.1 Sim agent #5 — **PROMPT NOT YET RECEIVED**
Romain mentioned he was about to send a prompt for "simulation agent #5" (the fifth in a series of adversarial / end-to-end agent simulations against the oracle). Context cut before the prompt arrived. **Do not draft the prompt yourself** — wait for Romain. When he sends it:
- Previous sims were likely end-to-end adversarial: fake agent reputations, report spam, L402 exhaustion, routing attacks, report-bonus abuse (now guarded).
- Sim #5 likely probes one of: cold-start bootstrap, Tier-2-activated economic abuse, cross-relay NIP-98 replay, or dependency-chain attack.
- Expect the sim to produce a report Romain will use to decide whether to activate Tier 2 or patch a newly-found surface.

### 5.2 Cold-start dev (mentioned, not detailed)
Placeholder work item Romain flagged late-session. Likely relates to onboarding new agents before they have history — bootstrap score, provisional tier, decay curve. No design doc yet. **Ask Romain for scope before starting.**

### 5.3 Moat (mentioned, not detailed)
Strategic work on defensibility — probably about data moat (crawler coverage) vs. integration moat (SDK lock-in) vs. cost moat (1 sat/call). No design doc. **Ask Romain before touching.**

### 5.4 Typosquat republish
Retry after npm rate-limit clears (~24h from last 429):
```bash
cd /Users/lochju/satrank/sdk/typosquat-shells/satrnak && npm publish --access public
cd /Users/lochju/satrank/sdk/typosquat-shells/satrrank && npm publish --access public
cd /Users/lochju/satrank/sdk/typosquat-shells/lightning-trust-oracle && npm publish --access public
```

---

## 6. Credentials + state

### 6.1 npm token
- **Still configured** in `~/.npmrc` (token stored locally only — see `~/.npmrc` for the value).
- **Romain should revoke this token manually** via npm UI after the remaining 3 typosquats are published. Do not revoke it yourself — it's Romain's account.
- If retrying the 3 pending publishes, use this token; if it's been revoked, Romain will provide a new one.

### 6.2 L402 balance
- No explicit balance operation in this session. Test token with 100 sats was used earlier in the day for validation probes.
- Check balance via: `curl -H "Authorization: L402 deposit:<preimage>" https://satrank.dev/api/token/balance` — or query `token_balance` on prod SQLite.

### 6.3 Prod infrastructure (recap — see `reference_satrank_infra.md`)
- Local: `/Users/lochju/satrank`
- Prod: `178.104.108.108`
- Deploy: `make deploy` (now chowns root + perms 600)
- Docker: `satrank-api` (Express :3000), `satrank-crawler` (:9091 metrics), fronted by Aperture L402 gate (:8082) and Nginx (hardened TLS).
- `/opt/satrank` chowned `root:root`.
- Scoring validation cron: active on prod, output at `/root/scoring-validation/snapshots.csv`.
- Nginx backup: `/root/nginx-satrank-backup-20260416.conf`.

---

## 7. Guardrails (from memory, reinforced)

- **Never touch LN channels** (open/close/policy) without written confirmation — `feedback_channel_operations.md`.
- **Never rsync from home** — `feedback_safety_rules.md`.
- **Don't touch chainstate symlink**, don't interrupt sync.
- **Deploy autonomously** after build + tests pass — `feedback_deploy_autonomy.md`.
- **Never propose launches / ship dates** — Romain decides — `feedback_decision_authority.md`.
- **Claude Code = implementation**; strategy happens with web Claude — `feedback_role_claude_code.md`.
- **Reports = real txns only**, privacy first, score ≠ success_rate — `feedback_satrank_principles.md`.
- **Verify kills actually killed** (CPU time progression) — `feedback_verify_kill_worked.md`.

---

## 8. First actions for the new session

1. **Ack context loaded**: confirm read of this file, schema v29, 561 tests, SDK 0.2.3.
2. **Do not rerun audits** — all three (scoring, observability, security) are closed and shipped.
3. **Do not flip `REPORT_BONUS_ENABLED`** — wait for Day-30 data + Romain's call.
4. **Wait for Romain's sim #5 prompt**.
5. If asked about scoring validation progress before 2026-04-18: report "cron running, partial data" — do not over-interpret < 48h of snapshots.
6. If 3 remaining typosquats need publishing and ~24h have passed: retry with commands in §5.4.

---

_End of briefing. Trust the code — it's audited. Do not re-explore past decisions unless Romain asks._
