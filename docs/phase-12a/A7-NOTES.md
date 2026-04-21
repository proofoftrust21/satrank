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

## L402_BYPASS scope extended (A5 prep)

On first staging smoke (5 RPS / 30 s on `/api/health`), every request got
HTTP 429 because:

- `apiRateLimit` defaults to 100 req/min/IP (`RATE_LIMIT_MAX=100`,
  `RATE_LIMIT_WINDOW_MS=60000` — zod defaults).
- `discoveryRateLimit` is hard-coded to **10 req/min/IP**
  (`src/app.ts:514`).
- `versionRateLimit` is hard-coded to 60 req/min/IP.
- `metricsRateLimit` is hard-coded to 30 req/min/IP.

Every k6 VU in the bench shares one source IP (the staging VM itself),
so these ceilings make the bench measure the rate limiter and not the
server.

**Change:** added `skip: () => config.L402_BYPASS` to all four limiters
in `src/app.ts`. Fail-safe remains the L402_BYPASS double-gate
(REFUSED if `NODE_ENV=production` + `L402_BYPASS=true`), so this cannot
be activated in prod.

Alternatives considered:
- Expose `RATE_LIMIT_*` env knobs for every limiter : larger config
  surface, same runtime effect.
- Trust-proxy + `X-Forwarded-For` spoof : would bypass the per-IP key
  generator but distort the observed 429 telemetry. Rejected.

A5 palier runs measure server behaviour without the limiter in the
critical path; prod path keeps the limiter intact.

## Staging DB clone ownership — out-of-band fix

The prod DB clone landed at `/var/lib/satrank/satrank.db` during A0
owned by `root:root`. The staging api container runs as
`satrank` (UID 1001, `Dockerfile` line ~26), and better-sqlite3's
`PRAGMA journal_mode = WAL` needs write access to the DB file →
"attempt to write a readonly database" crash loop on first start.

Fix applied on the staging VM (not tracked in git — ephemeral bench
artifact):

```
chown -R 1001:1001 /var/lib/satrank/
```

Document in the bench runbook so the A0 script for future reruns does
this at clone time instead of post-hoc.

## A5 methodology adjustment (mid-run, 2026-04-21 ~10:12Z)

Initial compressed sweep launched with `WARMUP=30s DURATION=2m REST=30s`
across a uniform 4-palier matrix `{1, 10, 100, 500} rps` for every
endpoint. After `health` (4 paliers, all passed) and `top @ 1`, `top @ 10`,
Romain asked to :

1. Raise sustained to **3 min** per palier (vs 2 min) — "suffisant pour
   identifier bottlenecks par ordre de grandeur; recalibration fine des
   seuils à faire en Phase 12B si nécessaire."
2. Add a 30 %-error early-abort. Implemented instead as an **inter-palier
   /api/health probe** that cascades-skip remaining paliers for the
   same endpoint if the api is down. Simpler than in-flight k6 monitoring
   and catches the "container died under load" case.
3. Reduce the palier matrix per endpoint :
   - `/api/agents/top`   : 4 paliers `{1, 10, 100, 1000}` (heavy DB scan, instructive)
   - `/api/intent`       : 4 paliers `{1, 10, 100, 1000}` (core POST path)
   - `/api/agent/:hash/verdict` : 2 paliers `{10, 1000}` (redundant lookup)
   - `/api/operator/:id` : 2 paliers `{10, 1000}` (redundant lookup)
   - `/api/services`     : 2 paliers `{10, 1000}` (not in Romain's list but scaled similarly)
   - `/api/health`       : already done with the OLD 2-min params (kept as-is)
4. Push the top palier from 500 → **1000 rps** per the original Phase 12A
   plan since the 2-CPU cpx32 can push through cached /agents/top
   reasonably and saturation data is the whole point.

**Dropped from the bench** (with rationale) :

- `/api/probe` : requires live LND. Staging clone has LND disabled
  (`lndStatus: disabled` in `/api/health`), so there is no way to
  exercise a probe end-to-end. Not benchable on staging.
- `/api/deposit` : same — needs LND to generate a BOLT11 invoice.
- `/api/operator/register` : requires a per-request NIP-98
  Authorization header (Nostr-signed event). Generating those at
  1000 rps would need a pre-signed replay pool; out of scope for the
  time budget. Skipped with a note in A7; consider a pre-generated
  fixture if a follow-up run is needed.

**Sustained-at-3-min caveat** : the p99 percentile has a larger
variance at 3 min than at 10 min (fewer tail samples). For an
order-of-magnitude comparison between paliers this is sufficient; for
SLA-grade thresholds a 10-min sustained run would be needed. The
pre-adjustment paliers (`health` 4/4 + `top @ 1`, `top @ 10`) used a
still-smaller 2-min sustained — noted in A7 results table.

**Early-abort design note** : in-palier abort would require wiring k6
metric polling or parsing `--out csv=` in real time. Deferred :
mid-palier failures already surface via the inter-palier health probe
cascade, and the 3-min cap on runtime already bounds the worst case.

## Open questions to address in A7

- [ ] How much of prod's baseline can we infer from nginx logs alone?
      Likely: RPS + coarse `$request_time` + status class. Missing:
      internal state (cache hits, LND inflight, DB query p95).
- [ ] How well does staging `PRAGMA integrity_check: ok` + row-counts
      reproduce prod's production behaviour? Concern: missing
      WAL-at-clone means staging restarts from a fresh WAL, might hide
      issues that only show under WAL bloat.
