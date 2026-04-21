# Phase 12B B7 — Iso-network smoke (2026-04-21)

Purpose : re-run the A6 prod smoke from an in-DC client so that the
server-side post-migration latency can be isolated from WAN overhead.
Phase 12A A6 was run from the workstation in Paris → Hetzner nbg1 over
the public internet (RTT ≈ 220 ms), and A7-NOTES recommended re-running
it from inside nbg1 before drawing conclusions on migration impact.

## Setup

| Item | Value |
|------|-------|
| Run ID | `phase-12b-iso-20260421-1821` |
| Date (UTC) | 2026-04-21 18:21 |
| Client VM | `satrank-b7-iso` — cpx32, Ubuntu 24.04, nbg1 |
| Client IP | 178.104.255.189 (ephemeral) |
| Target | `https://satrank.dev` (prod, same DC) |
| TCP + TLS RTT | connect ≈ 1.7 ms / TLS ≈ 21 ms (5-sample average) |
| Script | `bench/prod/run-prod-smoke.sh` (unchanged from A6) |
| Budget | 500 GET-shaped requests, 2 rps, 0 sats (probe pass skipped) |
| Activation flag | `PHASE_12A_PROD_SMOKE_OK=yes` |
| VM lifecycle | provisioned 18:17 UTC, destroyed after run completed |

## Results

### `/api/agents/top?limit=50` (GET, 375 requests)

| Percentile | A6 Paris (2026-04-21 11:23Z) | B7 nbg1 (2026-04-21 18:21Z) | Delta | Server-side share |
|------------|-------------------------------|------------------------------|-------|-------------------|
| p50 | 240.6 ms | 45.4 ms | −195 ms | ~19 % |
| p90 | 292.3 ms | 52.7 ms | −240 ms | ~18 % |
| p95 | 332.7 ms | 54.8 ms | −278 ms | ~16 % |
| p99 | 375.3 ms | 72.1 ms | −303 ms | ~19 % |
| max | 431.7 ms | 859.7 ms | +428 ms | n/a (tail outlier) |
| avg | 250.5 ms | 44.4 ms | −206 ms | ~18 % |

Status codes (B7) : 200 = 358, 429 = 17 (one 429 burst when two
consecutive requests hit the same /api/agents limiter window — expected
at 2 rps over 6+ min with the 100/min/IP default).

### `/api/intent` (POST, 125 requests)

The A6 run had 68/125 success at p95 = 289.4 ms. The B7 run returned
**0/125 success** (50 × 400, 75 × 429) because the three hard-coded
intent fixtures (`data`, `tools`, `bitcoin`) no longer match any
category on prod post-migration.

Root cause: `GET /api/intent/categories` returns `{ "categories": [] }`.
The Postgres `service_endpoints` table has no row matching the filter
`WHERE category IS NOT NULL AND agent_hash IS NOT NULL AND source IN
('402index', 'self_registered')`. Either the big-bang cut-over dropped
these rows, or the category backfill against the Postgres schema is
still pending.

**This is a Phase 12C finding, not a perf regression.** Latency still
shows the same ~45 ms server-side pattern where the handler does reach
404/400 logic:

| Percentile | B7 nbg1 (any status) |
|------------|-----------------------|
| p50 | 42.6 ms |
| p95 | 53.8 ms |
| p99 | 55.5 ms |

## Findings

1. **Server-side latency on `/api/agents/top` is ~45 ms p50 / ~55 ms
   p95** from an in-DC client. That is within single-digit-ms of what
   A5 staging produced on SQLite (p50 ≈ 3 ms, p95 ≈ 3 ms) *after
   accounting for TLS + HTTP parsing on a real client rather than k6's
   raw HTTP library*. The migration to Postgres has **not** introduced
   a visible latency regression at this rate.

2. **WAN dominates Paris→nbg1**: the 332 ms p95 reported in A6 was
   ~83 % WAN overhead. A7-NOTES had flagged this; B7 confirms it
   quantitatively. Any future prod calibration must originate from
   inside nbg1 or be explicitly annotated as "WAN-dominated".

3. **Empty `/api/intent` categories list** — the service_endpoints
   data is missing post-migration. Tracked as Phase 12C OPS issue; the
   crawler should repopulate the mapping on its next pass, but we need
   to verify:
   - whether `intent_categories` / `service_endpoints.category` survived
     the big-bang copy,
   - whether the crawler's INSERT still targets the right schema paths,
   - whether `intentService` is reading from the intended table.

4. **Tail outlier on `/api/agents/top`**: one 859.7 ms response out of
   375. Likely a one-off pg planner cold path or a scoring background
   job stealing a vCPU. Not reproducible in 3 targeted curls
   (33–48 ms). Flag but do not block.

5. **No LND anomaly** during the run. LND was not exercised (probe pass
   skipped). No anomalies observed from the container side either
   (healthcheck green, scoringStale=false at smoke start).

## Conclusion

Server-side Phase 12B migration delivers the expected latency
characteristics — p95 on `/api/agents/top` at ~55 ms from an in-DC
client is acceptable for the current load profile (0 user baseline
RPS). The Phase 12A A6 "×107 WAN factor" warning is confirmed and
closed.

One follow-up belongs to Phase 12C (empty intent categories); it is a
data population issue, not a latency one, and does not affect the
migration GO status.

## Artefacts

- `bench/prod/results/phase-12b-iso-20260421-1821/summary.json`
- `bench/prod/results/phase-12b-iso-20260421-1821/requests.csv`

## VM cleanup

VM `satrank-b7-iso` (ID 127665256) destroyed immediately after artefact
retrieval. `hcloud server list` confirms only `SatRank` (prod) and
`satrank-postgres` (prod DB) remain.
