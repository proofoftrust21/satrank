# Report Adoption — Economic Incentive Design

_Date: 2026-04-16. Status: Tier 1 live. **Tier 2 code shipped but DISABLED by default** (Strategy D: ready to activate via env-var flip, no behavior change until then)._

## Context

Current state: 4 real reports (`/api/report`) from 2 distinct reporters. Target: N ≥ 200 for non-circular scoring calibration. Infrastructure already delivered in the prior session:

- Widened `decide_log` accepts tokens from `/api/decide`, `/api/verdicts`, `/api/agent/:hash/verdict`, `/api/profile`, `/api/best-route` → 61% → 100% of paying tokens eligible.
- SDK `transact()` tolerates report failure.
- Clearer error messages on report auth rejection.
- README section explaining why and how to report.

## Tier 1 — Reporter badge (shipped)

Visibility-only, zero economic surface:

- `/api/profile/:id` now returns `reporterStats: { badge, submitted30d, verified30d, breakdown, trustedThreshold }`.
- Badge tiers derived from the last 30 days:
  - `reporter` — 1+ reports submitted
  - `active_reporter` — 5+ reports submitted
  - `trusted_reporter` — 20+ **preimage-verified** reports submitted

No balance credit, no scoring weight change, no gaming surface. The badge is a reputational nudge for agents who care about how they appear on `/api/profile`.

## Tier 2 — Economic incentive (code shipped, flag OFF)

### Activation model (Strategy D)

All code is in production behind `REPORT_BONUS_ENABLED=false`. Flipping the flag to `true` and restarting the API container activates the bonus. Zero behavior change until then.

### Why not active by default

Any direct balance bonus `≥ 1 sat per report` can be abused: the attacker pays 1 sat for a `/api/decide` query, earns a 1 sat bonus by submitting a fake preimage-verified report, net zero cash cost, and poisons the scoring with noise. Preimage verification is cryptographic (client-supplied random bytes) — it does not prove a real Lightning payment happened.

The defensible designs all require external identity gating. Gating is implemented; abuse-monitoring window still needed before switching on.

### Proposed mechanic (for validation)

**Deferred balance bonus**:
- Every **10 eligible reports** → **+1 sat** credited back to the reporter's L402 token.
- Equivalent: ~10% effective discount on queries for users who naturally report their outcomes.
- Daily cap: 3 bonuses per reporter per UTC day (max 30 eligible reports/day per reporter count toward the bonus).

**Eligibility rules** (all must hold):
1. **Preimage-verified** — `sha256(preimage) === paymentHash`.
2. **Token-bound** — `decide_log` already tracks this; rule remains.
3. **Reporter has real history** — at least ONE of:
   - Reporter agent hash has a SatRank score `≥ 30` (excludes freshly-created sybils), OR
   - Report is signed with a Nostr key via NIP-98, and the key has `≥ 30 days` of relay activity (the existing Stream B zap-mining dataset already caches seen npubs + their first-seen timestamps).
4. **Anti-dedup** — first bonus-eligible report per `(reporter, target, UTC day)` only.

### Attack cost vs reward (at these parameters)

| Actor | Cost per report | Reward per report | Net per report |
|-------|-----------------|-------------------|----------------|
| Legitimate user with score ≥ 30 | 1 sat (decide) | 0.1 sat (bonus/10) | -0.9 sat → 10% discount |
| Sybil without identity | 1 sat (decide) + Nostr age cost | 0 | Pure loss |
| Sybil with aged Nostr key | 1 sat (decide) | 0.1 sat | Same break-even — poisons data but gains nothing |

The floor "attacker gains nothing" holds only because **the bonus is strictly smaller than the query cost**. Pushing the bonus above 0.1 sat/report re-opens the economic arbitrage.

### Data-poisoning attack

Even at break-even cost, a patient attacker could flood. Mitigation:

- Already present: global rate-limit (5 reports/min/reporter) + 1-hour dedup per (reporter, target) + reporter-score weight in scoring.
- Monitor: if `verdictTotal{source="verdict"}` ratio shifts sharply post-enable, roll back.

### Economic modeling

For the first 12 months, assume:

| Scenario | Legit reports / month | Bonus payout |
|----------|-----------------------|--------------|
| Current trajectory (no incentive) | ~10 | 0 |
| With Tier 1 badge only | ~30 | 0 |
| With Tier 2 bonus (10 reports = 1 sat) | ~200 | 20 sats / month |

20 sats/month ($0.01) is a negligible revenue impact, gain is crossing the N ≥ 200 threshold for non-circular scoring calibration.

### Operational readiness checklist for Tier 2 — status

All engineering pieces shipped; activation gated on observation window.

- [x] **NIP-98 signature verification** — `src/middleware/nip98.ts`. Validates kind 27235, 60s freshness, URL + method tags, body SHA-256 in `payload` tag, signature via `nostr-tools/pure.verifyEvent`.
- [x] **Npub-age cache** — `src/nostr/npubAgeCache.ts`. Reads a companion file `nostr-pubkey-ages.json` next to `nostr-mappings.json`. Fails closed when the file is absent (gate rejects NIP-98 path — score gate unaffected). Future Stream B enhancement will populate the file.
- [x] **Daily bonus-count table** — `report_bonus_log(reporter_hash, utc_day, eligible_count, bonuses_credited, total_sats_credited, last_credit_at)`. Migration v29, rollback included.
- [x] **Repository** — `ReportBonusRepository.findToday / incrementEligibleCount / recordBonusCredit / summarySince`. All atomic.
- [x] **Service** — `ReportBonusService` wraps the eligibility gate, the threshold credit, and the auto-rollback guard. Integrated into `v2Controller.report` via `maybeCredit`.
- [x] **Metrics** — `satrank_report_bonus_enabled` (gauge), `satrank_report_bonus_total` (counter), `satrank_report_bonus_payout_sats_total` (counter), `satrank_report_bonus_gate_total{gate}` (counter), `satrank_report_bonus_rollback_total` (counter).
- [x] **Auto-rollback** — `ReportBonusService.startGuard()` runs every `REPORT_BONUS_GUARD_INTERVAL_MS` (default 15 min), compares current SAFE verdict ratio to the baseline captured when the bonus was enabled, and flips the flag off if `ratio > REPORT_BONUS_ROLLBACK_RATIO` (default 1.3).
- [x] **Kill-switch env var** — `REPORT_BONUS_ENABLED=false` by default. Flip to `true` and restart to activate.
- [x] **Tests** — `src/tests/reportBonus.test.ts` covers: disabled default, verified requirement, threshold crossing, daily cap, score gate rejection, missing paymentHash, manual rollback.

### Default parameters (all env-configurable)

| Param | Default | Env var |
|---|---|---|
| Threshold (reports per bonus) | 10 | `REPORT_BONUS_THRESHOLD` |
| Daily cap (bonuses / reporter / UTC day) | 3 | `REPORT_BONUS_DAILY_CAP` |
| Sats per bonus | 1 | `REPORT_BONUS_SATS` |
| Min reporter SatRank score (gate A) | 30 | `REPORT_BONUS_MIN_REPORTER_SCORE` |
| Min npub age (gate B, days) | 30 | `REPORT_BONUS_MIN_NPUB_AGE_DAYS` |
| Auto-rollback ratio | 1.3 | `REPORT_BONUS_ROLLBACK_RATIO` |
| Guard check interval | 15 min | `REPORT_BONUS_GUARD_INTERVAL_MS` |

### Activation procedure

1. Verify the last 30-day metric `increase(satrank_report_submitted_total[30d])` is **below 100** — if organic growth is already strong, skip activation.
2. Set `REPORT_BONUS_ENABLED=true` in `.env.production`.
3. Restart the API container: `docker compose up -d --force-recreate api`.
4. Check `curl localhost:3000/api/stats/reports | jq .data.bonus.enabled` → `true`.
5. Monitor `satrank_report_bonus_enabled` in Prometheus + the error log for auto-rollback events over the first week.

### Recommendation

Run a 30-day observation window on report volume under Tier 1 badge alone. Dashboard endpoint: `GET /api/stats/reports` returns `summary.progressPct` toward the N=200 target. If growth stalls under 100/month, follow the activation procedure above. If growth exceeds 150/month, leave the flag off — the economic incentive isn't needed.
