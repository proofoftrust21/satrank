# Phase 12A A7 — Report draft notes

Raw findings accumulated during A0→A6. Absorbed into
`docs/PHASE-12A-BENCHMARK-REPORT-2026-04-21.md` at A7.

## SSOT drift vs Briefing V14

Observed on the cloned prod DB (2026-04-21):

| Metric         | Briefing V14 | Actual prod | Delta |
|----------------|--------------|-------------|-------|
| agents         | 14 002       | 18 297      | +30%  |
| probe_results  | (not listed) | 2 108 231   | n/a   |
| service_endpoints | (not listed) | 106    | n/a   |
| schema version | v41          | v29 + phase 7–9 migrations (operator_*, streaming_posteriors, report_bonus_log, preimage_pool, etc.) | v41 appears to be a forward-looking label, not the actual schema |

**Recommendation:** maintain a single source of truth for the state
briefing (SQLite row counts, schema version, container image tags)
generated from prod on demand instead of hand-authored. Suggest a
`make state-snapshot` target that dumps `docs/STATE-SNAPSHOT.md`.

## Methodology limit — staging compute vs prod compute

Prod runs bitcoind + LND as co-tenants (systemd-managed) alongside the
API + crawler containers. Staging runs only the API + crawler.

- Compute parity: confirmed (both cpx32, 4 vCPU / 8 GB RAM).
- Disk asymmetry (staging 150 GB vs prod 80 GB + external volumes):
  no effect on API workload.
- Expected bias: staging rupture thresholds will be **~10–15 %
  optimistic** vs prod. Document this when reporting palier ceilings.

Mitigation: the A6 prod smoke test at iso-charge re-calibrates the
staging numbers against a single-point prod observation.

## Scope change on A1 — prom-client already instrumented

The original Phase 12A prompt anticipated adding prom-client middleware
behind `METRICS_ENABLED` env gate for staging-only instrumentation. On
reading the code, `prom-client` is already an active prod dependency
(`package.json:58`) with ~50 custom metrics wired in
`src/middleware/metrics.ts` and `/metrics` exposed at `src/app.ts:408`.

Introducing a new gate would have been a prod code modification and
would have broken the current prod dashboards that rely on the
endpoint being live. **Dropped** items 17–20 of the validated file
list. Stack consumes existing instrumentation as-is.

## Latent security finding — /metrics localhost bypass

**Not remediated in Phase 12A.** Flagged for future security audit.

`src/app.ts:408-416` — the `/metrics` endpoint checks
`req.ip === '127.0.0.1' || '::1' || '::ffff:127.0.0.1'` and
**bypasses the `X-API-Key` check** when true. Same pattern exists in
several places.

Concerns:
1. IP-based auth is weak: an attacker with SSRF, a proxy hop with
   `trust proxy` miscount, or a CNI/overlay networking bug can forge
   the localhost appearance.
2. `req.ip` depends on `app.set('trust proxy', 1)` which we trust.
   Add one more proxy hop (CDN, WAF) without bumping the count →
   every request appears to come from 127.0.0.1.
3. Not a Phase 12A problem — flagging for the next security audit
   cycle. Recommended fix: require `X-API-Key` even on localhost
   (constant-time compare is cheap) and expose an explicitly different
   path like `/metrics-internal` for operator consumption if the
   localhost bypass has an operational reason that isn't documented.

## A1 topology decisions (final)

After iteration with Romain:
- SSH tunnel prod → staging **REFUSED** (persistent attack surface,
  low value since baseline RPS ≈ 0).
- Prod promtail **APPROVED** — one authorized daemon addition, bind
  mount `/var/log/nginx:ro` + push to staging Loki.
- Staging stack: full observability locally, no cross-host scraping.
- Prod observability via: (a) nginx access logs through promtail,
  (b) A6 smoke test (iso-charge replay for calibration).

## Open questions to address in A7

- [ ] How much of prod's baseline can we infer from nginx logs alone?
      Likely: RPS + coarse `$request_time` + status class. Missing:
      internal state (cache hits, LND inflight, DB query p95).
- [ ] How well does staging `PRAGMA integrity_check: ok` + row-counts
      reproduce prod's production behaviour? Concern: missing
      WAL-at-clone means staging restarts from a fresh WAL, might hide
      issues that only show under WAL bloat.
