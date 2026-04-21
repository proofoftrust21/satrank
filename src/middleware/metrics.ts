// Prometheus metrics middleware and registry
import client from 'prom-client';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Request, Response, NextFunction } from 'express';

// Custom registry (avoids polluting default)
export const metricsRegistry = new client.Registry();
metricsRegistry.setDefaultLabels({ app: 'satrank' });

// Collect default Node.js metrics (event loop, memory, GC)
client.collectDefaultMetrics({ register: metricsRegistry });

// --- Application gauges (updated by statsService) ---

export const agentsTotal = new client.Gauge({
  name: 'satrank_agents_total',
  help: 'Total number of indexed agents',
  registers: [metricsRegistry],
});

export const channelsTotal = new client.Gauge({
  name: 'satrank_channels_total',
  help: 'Total Lightning channels across all nodes',
  registers: [metricsRegistry],
});

// --- Request counter ---

export const requestsTotal = new client.Counter({
  name: 'satrank_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

// --- Histograms ---

export const httpRequestDuration = new client.Histogram({
  name: 'satrank_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const scoreComputeDuration = new client.Histogram({
  name: 'satrank_score_compute_duration_seconds',
  help: 'Score computation duration in seconds',
  registers: [metricsRegistry],
});

export const crawlDuration = new client.Histogram({
  name: 'satrank_crawl_duration_seconds',
  help: 'Crawler run duration in seconds',
  labelNames: ['source'] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

// --- Saturation indicators (for 100x scale preparation) ---

/** Cache hit/miss — saturation indicator for memory cache */
export const cacheEvents = new client.Counter({
  name: 'satrank_cache_events_total',
  help: 'Cache operations — hit/miss/evict per namespace',
  labelNames: ['namespace', 'event'] as const,
  registers: [metricsRegistry],
});

/** LND queryRoutes concurrency — high values predict LND saturation */
export const lndInflight = new client.Gauge({
  name: 'satrank_lnd_inflight',
  help: 'Concurrent LND queryRoutes in flight (capped globally)',
  registers: [metricsRegistry],
});

/** LND queryRoutes duration */
export const lndQueryRoutesDuration = new client.Histogram({
  name: 'satrank_lnd_queryroutes_duration_seconds',
  help: 'LND queryRoutes call duration',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/** Cache freshness — age in seconds since last successful compute per key.
 *  High values indicate a background refresh that keeps failing → stale data served silently. */
export const cacheAgeSeconds = new client.Gauge({
  name: 'satrank_cache_age_seconds',
  help: 'Age of cache entry since last successful compute (seconds)',
  labelNames: ['key'] as const,
  registers: [metricsRegistry],
});

/** Count of consecutive refresh failures per key. Alarm when > 3. */
export const cacheRefreshFailures = new client.Gauge({
  name: 'satrank_cache_refresh_failures',
  help: 'Consecutive background refresh failures per cache key',
  labelNames: ['key'] as const,
  registers: [metricsRegistry],
});

/** Counter for calls to removed (410 Gone) legacy endpoints. Tracks how long
 *  consumers keep hitting removed paths so an operator can decide when it's
 *  safe to retire the 410 handler itself. Label is the legacy path. */
export const legacyEndpointCallsTotal = new client.Counter({
  name: 'satrank_legacy_endpoint_calls_total',
  help: 'Calls to removed legacy endpoints that now return 410 Gone',
  labelNames: ['endpoint'] as const,
  registers: [metricsRegistry],
});

/** Repository query duration — detect SQL regressions */
export const dbQueryDuration = new client.Histogram({
  name: 'satrank_db_query_duration_seconds',
  help: 'SQLite query duration per repository method',
  labelNames: ['repo', 'method'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

/** Verdict outcome counter — core business SLI.
 *  A sudden drop in SAFE ratio or spike in UNKNOWN ratio is the earliest
 *  signal of a scoring regression that HTTP-level metrics cannot surface.
 *  `source` labels the call path (decide / verdict / best-route / dvm / mcp)
 *  so a skew on one endpoint can be detected independently of the others. */
export const verdictTotal = new client.Counter({
  name: 'satrank_verdict_total',
  help: 'Verdicts emitted — labelled by outcome and source endpoint',
  labelNames: ['verdict', 'source'] as const,
  registers: [metricsRegistry],
});

// --- Nostr publishing ---

/** Nostr publish counter — per stream (A = lightning-indexed, B = nostr-indexed)
 *  and per outcome (published / skipped / error). Missing samples on a stream
 *  for > 2h is the alert signal: publishing has stopped silently. */
export const nostrPublishTotal = new client.Counter({
  name: 'satrank_nostr_publish_total',
  help: 'Nostr events attempted per stream and outcome',
  labelNames: ['stream', 'result'] as const,
  registers: [metricsRegistry],
});

/** Per-relay ack outcome. Timeouts vs errors vs success help diagnose
 *  which relay is the weak link in a degraded publish cycle. */
export const nostrRelayAckTotal = new client.Counter({
  name: 'satrank_nostr_relay_ack_total',
  help: 'Per-relay publish ack outcome',
  labelNames: ['relay', 'result'] as const,
  registers: [metricsRegistry],
});

/** Publish-cycle duration per stream. Regressions here signal relay
 *  saturation or a throttling change. */
export const nostrPublishDuration = new client.Histogram({
  name: 'satrank_nostr_publish_duration_seconds',
  help: 'Nostr publish cycle duration per stream',
  labelNames: ['stream'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
  registers: [metricsRegistry],
});

/** Unix time of the last successful publish per stream. Exposed so that
 *  a simple `time() - satrank_nostr_last_publish_timestamp{stream="A"} > 7200`
 *  alert catches Stream A / B outages without relying on rate() windows. */
export const nostrLastPublishTimestamp = new client.Gauge({
  name: 'satrank_nostr_last_publish_timestamp',
  help: 'Unix time of last successful Nostr publish cycle per stream',
  labelNames: ['stream'] as const,
  registers: [metricsRegistry],
});

// --- Rate limiting ---

/** Rate limit hit counter — per limiter.
 *  A sustained spike on the `global` limiter signals DDoS, on `discovery`
 *  signals a misbehaving crawler, on `deposit` signals a bug in a client. */
export const rateLimitHits = new client.Counter({
  name: 'satrank_rate_limit_hits_total',
  help: 'HTTP 429 rate-limit rejections per limiter',
  labelNames: ['limiter'] as const,
  registers: [metricsRegistry],
});

// --- LND health ---

/** LND reachability: 1 = reachable, 0 = last probe failed. Age in seconds
 *  since the last successful probe is available via `satrank_lnd_last_probe_age_seconds`. */
export const lndReachable = new client.Gauge({
  name: 'satrank_lnd_reachable',
  help: 'LND reachability flag (1 = up, 0 = down per last probe)',
  registers: [metricsRegistry],
});

// --- Circuit breaker ---

/** Circuit breaker state gauge. 0 = closed, 1 = half-open, 2 = open.
 *  Wired from utils/circuitBreaker on transition. */
export const circuitBreakerState = new client.Gauge({
  name: 'satrank_circuit_breaker_state',
  help: 'Circuit breaker state — 0 closed, 1 half-open, 2 open',
  labelNames: ['breaker'] as const,
  registers: [metricsRegistry],
});

/** Deposit flow phase counter. Lets us see the funnel:
 *  invoice_created → verify_pending → verify_success_fresh, plus the
 *  replay/error paths (verify_success_cached, verify_not_found). */
export const depositPhaseTotal = new client.Counter({
  name: 'satrank_deposit_phase_total',
  help: 'Deposit flow phases — invoice_created, verify_success_fresh, verify_success_cached, verify_pending, verify_not_found',
  labelNames: ['phase'] as const,
  registers: [metricsRegistry],
});

/** Watchlist cycle output — how many agents reported as changed per call
 *  (by direction). Useful to detect a threshold calibration regression that
 *  suddenly produces zero or too many events. */
export const watchlistChanges = new client.Counter({
  name: 'satrank_watchlist_changes_total',
  help: 'Agents whose scores crossed the watchlist thresholds, labelled by direction',
  labelNames: ['direction'] as const,
  registers: [metricsRegistry],
});

// --- Reports (monitoring the Tier 1 badge + Tier 2 bonus) ---

/** Report submissions counter. `verified` label = "1" when preimage matched,
 *  "0" otherwise. `outcome` reflects the user's declared outcome. Enables the
 *  30-day dashboard: `increase(satrank_report_submitted_total[30d])`. */
export const reportSubmittedTotal = new client.Counter({
  name: 'satrank_report_submitted_total',
  help: 'Reports submitted via /api/report, by verified flag and outcome',
  labelNames: ['verified', 'outcome'] as const,
  registers: [metricsRegistry],
});

/** Unique reporters seen per day — rough proxy via a counter that we
 *  increment only when a reporter submits their FIRST report of the day.
 *  Over a 30d window, `sum(increase(satrank_report_unique_reporters[30d]))`
 *  approximates distinct reporter count (with minor double-count if the same
 *  reporter spans day boundaries without reporting on both sides). */
export const reportUniqueReportersDaily = new client.Counter({
  name: 'satrank_report_unique_reporters_daily_total',
  help: 'Increments on a reporters first report of the UTC day',
  registers: [metricsRegistry],
});

// --- Tier 2 report bonus (flag-gated) ---

/** Whether Tier 2 economic bonus is currently active in this process. 1=on, 0=off.
 *  Reflects both the boot-time env flag AND the auto-rollback state. */
export const reportBonusEnabledGauge = new client.Gauge({
  name: 'satrank_report_bonus_enabled',
  help: 'Report bonus is active: 1 = enabled, 0 = disabled (env off or auto-rollback)',
  registers: [metricsRegistry],
});

/** Total bonus events (each = one 10-report threshold crossed that paid out). */
export const reportBonusTotal = new client.Counter({
  name: 'satrank_report_bonus_total',
  help: 'Number of bonus credits granted (each is a 10-threshold crossing)',
  registers: [metricsRegistry],
});

/** Sats paid out to reporters. Summed for revenue-impact monitoring. */
export const reportBonusPayoutSatsTotal = new client.Counter({
  name: 'satrank_report_bonus_payout_sats_total',
  help: 'Sats credited to reporter L402 balances via the bonus mechanism',
  registers: [metricsRegistry],
});

/** Eligibility gate that accepted the report. `score` = reporter has SatRank
 *  score ≥ threshold, `nip98` = valid NIP-98 sig with aged npub, `none` =
 *  neither (ineligible, no bonus). Lets us see which gate is carrying load. */
export const reportBonusGateTotal = new client.Counter({
  name: 'satrank_report_bonus_gate_total',
  help: 'Report eligibility gate outcome per submission',
  labelNames: ['gate'] as const,
  registers: [metricsRegistry],
});

/** Auto-rollback trip count. A non-zero value means the guard ever fired;
 *  combined with `satrank_report_bonus_enabled == 0`, this distinguishes
 *  "operator turned it off" from "auto-rollback triggered". */
export const reportBonusRollbackTotal = new client.Counter({
  name: 'satrank_report_bonus_rollback_total',
  help: 'Times the auto-rollback guard has disabled the bonus',
  registers: [metricsRegistry],
});

// --- Phase 8 : multi-kind Nostr publishing ---

/** Compteur par kind publié + résultat (success/failure). Couvre les 4 kinds
 *  (30382/30383/30384/20900/5). Un label `result=no_ack` signale un publish
 *  qui n'a reçu aucun ack de relai. Le drop soudain d'un kind = soit plus
 *  d'entités éligibles côté business, soit régression du scheduler. */
export const multiKindEventsPublishedTotal = new client.Counter({
  name: 'satrank_nostr_events_published_total',
  help: 'Events Nostr publiés (Phase 8 multi-kind) par kind et résultat',
  labelNames: ['kind', 'result'] as const,
  registers: [metricsRegistry],
});

/** Compteur de flashes kind 20900 par type d'entité. Labels : type ∈
 *  {node, endpoint, service}. Un spike signale un événement de marché
 *  (un endpoint qui flip SAFE→RISKY = alerte utilisateur). */
export const multiKindFlashesTotal = new client.Counter({
  name: 'satrank_nostr_flashes_total',
  help: 'Flashes kind 20900 émis par type d\'entité',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

/** Compteur de skip par raison : `no_change` (shouldRepublish=false),
 *  `hash_identical` (template byte-équivalent au cache). Ratio
 *  `skipped/scanned` = efficacité du delta filter. */
export const multiKindRepublishSkippedTotal = new client.Counter({
  name: 'satrank_nostr_republish_skipped_total',
  help: 'Entités scannées mais non republiées (par raison)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

/** Compteur d'erreurs de publish au niveau relai. Permet d'identifier le
 *  relai qui drag (ex. nos.lol timeout systématique) et de le retirer de
 *  la liste sans attendre une post-mortem. `result` ∈ {timeout, error}. */
export const multiKindRelayErrorsTotal = new client.Counter({
  name: 'satrank_nostr_relay_errors_total',
  help: 'Erreurs publish par relai Nostr (Phase 8)',
  labelNames: ['relay', 'result'] as const,
  registers: [metricsRegistry],
});

/** Histogramme de latence par publish (signing + broadcast). Exposé par
 *  kind pour distinguer le coût d'un 30383 enrichi (tags price/category)
 *  d'un 20900 minimal. Utile pour détecter un relai qui ralentit la P99. */
export const multiKindPublishDuration = new client.Histogram({
  name: 'satrank_nostr_multi_kind_publish_duration_seconds',
  help: 'Durée publish Nostr multi-kind (sign + broadcast) en secondes',
  labelNames: ['kind'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// --- Phase 7 : operators abstraction ---

/** Total d'operators par statut. Refreshé au scrape (comme agentsTotal) via
 *  operatorRepo.countByStatus(). Alerting : passage brutal à 0 sur 'verified'
 *  = régression (la règle 2/3 échoue soudainement) ; croissance monotone sur
 *  'rejected' = inflow de claims frauduleux qu'il faut inspecter. */
export const operatorsTotal = new client.Gauge({
  name: 'satrank_operators_total',
  help: 'Total operators indexés par statut (verified/pending/rejected)',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/** Chaque tentative de vérification d'identité. type ∈ {ln_pubkey, nip05, dns} ;
 *  result ∈ {success, failure}. Permet de voir quel vecteur cryptographique
 *  est le plus fragile (ex. DNS propagation qui timeout) et de détecter un
 *  relai Nostr défaillant si nip05 failure spike isolément. */
export const operatorVerificationsTotal = new client.Counter({
  name: 'satrank_operator_verifications_total',
  help: 'Identités operators vérifiées — par type (ln_pubkey/nip05/dns) et résultat (success/failure)',
  labelNames: ['type', 'result'] as const,
  registers: [metricsRegistry],
});

/** Chaque ownership claim (≠ vérification — claim revendique juste la ressource).
 *  Labels : resource_type ∈ {node, endpoint, service}. Ratio claims/verifications
 *  par type donne la "dette de vérification" (volume claim vs confirmation
 *  cryptographique). */
export const operatorClaimsTotal = new client.Counter({
  name: 'satrank_operator_claims_total',
  help: 'Ownership claims operators émises — par type de ressource (node/endpoint/service)',
  labelNames: ['resource_type'] as const,
  registers: [metricsRegistry],
});

// --- Phase 9 : /api/probe observability ---

/** Per-probe terminal outcome. Labels:
 *    - success_200           : second fetch returned 200 (the happy path).
 *    - success_non200        : paid and retried, upstream returned ≠200 (e.g., 500).
 *    - bolt11_invalid        : challenge had an unparseable invoice.
 *    - invoice_too_expensive : amount > PROBE_MAX_INVOICE_SATS.
 *    - payment_failed        : LND returned paymentError / empty preimage.
 *    - upstream_not_l402     : first fetch was not a valid L402 challenge.
 *    - upstream_unreachable  : first fetch threw / timed out.
 *    - probe_unavailable     : admin macaroon not configured (503 gate).
 *    - insufficient_credits  : balance_credits < 4 at debit time.
 *    - validation_error      : body/zod rejection or missing L402 header.
 *  A spike on `payment_failed` bracketed with a drop on `success_200` is the
 *  go-to signal that SatRank's routing node is degrading. */
export const probeTotal = new client.Counter({
  name: 'satrank_probe_total',
  help: 'POST /api/probe terminal outcomes',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

/** Cumulative sats SatRank has underwritten via /api/probe. Incremented at
 *  each successful payment, regardless of whether the retry returned 200.
 *  Dashboards use `rate(satrank_probe_sats_paid_total[1h])` to see current
 *  burn and `increase(…[24h])` to cross-check against the LND wallet diff. */
export const probeSatsPaidTotal = new client.Counter({
  name: 'satrank_probe_sats_paid_total',
  help: 'Cumulative sats paid by SatRank on external L402 invoices (probe)',
  registers: [metricsRegistry],
});

/** Bayesian ingestion outcome. Mirror of ProbeController.IngestionOutcome.reason,
 *  so every probe produces exactly one increment here. `ingested` = success path;
 *  other labels indicate why the observation was short-circuited (missing deps,
 *  endpoint not found, duplicate, tx write failed, etc.). */
export const probeIngestionTotal = new client.Counter({
  name: 'satrank_probe_ingestion_total',
  help: 'Outcome of the Bayesian ingestion step in /api/probe',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

/** End-to-end probe duration (fetch + pay + retry). The p99 is the user-facing
 *  latency; a regression suggests an LND slowdown or a flaky target. */
export const probeDuration = new client.Histogram({
  name: 'satrank_probe_duration_seconds',
  help: 'End-to-end /api/probe round-trip duration',
  buckets: [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

/** Invoice size distribution. Lets us see operators raising prices before
 *  complaints arrive, and catches a regression where the bolt11 parser starts
 *  returning wrong amounts. Buckets span the realistic L402 spectrum. */
export const probeInvoiceSats = new client.Histogram({
  name: 'satrank_probe_invoice_sats',
  help: 'Distribution of invoice amounts seen on /api/probe challenges',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

// --- Phase 12B B6.3 : event loop + pg pool + cache ratio ---

/** Event loop lag p50 / p99 in seconds. Sampled every 10 ms via
 *  `perf_hooks.monitorEventLoopDelay` (high-resolution histogram). Call
 *  `refreshEventLoopGauges()` from the /metrics scrape handler to snapshot
 *  the current histogram before it gets reset on the next call. A p99
 *  > 0.1 s sustained signals a blocking CPU path; > 1 s means requests
 *  queue at the HTTP layer. */
export const eventLoopLagP50 = new client.Gauge({
  name: 'satrank_event_loop_lag_p50_seconds',
  help: 'Node event loop lag p50 in seconds (last scrape window)',
  registers: [metricsRegistry],
});
export const eventLoopLagP99 = new client.Gauge({
  name: 'satrank_event_loop_lag_p99_seconds',
  help: 'Node event loop lag p99 in seconds (last scrape window)',
  registers: [metricsRegistry],
});
export const eventLoopLagMax = new client.Gauge({
  name: 'satrank_event_loop_lag_max_seconds',
  help: 'Node event loop lag max in seconds (last scrape window)',
  registers: [metricsRegistry],
});

const eventLoopHistogram = monitorEventLoopDelay({ resolution: 10 });
eventLoopHistogram.enable();

/** Called from the /metrics scrape to publish the latest event-loop-delay
 *  percentiles and reset the rolling histogram for the next window. Kept
 *  separate so the scrape handler stays synchronous. */
export function refreshEventLoopGauges(): void {
  // monitorEventLoopDelay returns nanoseconds; convert to seconds for
  // Prometheus convention (buckets expressed as `_seconds`).
  eventLoopLagP50.set(eventLoopHistogram.percentile(50) / 1e9);
  eventLoopLagP99.set(eventLoopHistogram.percentile(99) / 1e9);
  eventLoopLagMax.set(eventLoopHistogram.max / 1e9);
  eventLoopHistogram.reset();
}

/** Cache hit ratio over the lifetime of the process (hit / (hit + miss)).
 *  Useful as a top-line SLI — a drop below ~0.8 on the stats / agents:top
 *  namespaces indicates thrash or TTL misconfiguration. Updated on every
 *  /metrics scrape via `refreshCacheRatio()` from the accumulated
 *  `cacheEvents` counters; derived (not raw) so PromQL dashboards can
 *  plot it without composing a `rate(…)/rate(…)` expression. */
export const cacheHitRatio = new client.Gauge({
  name: 'satrank_cache_hit_ratio',
  help: 'Process-lifetime cache hit ratio: hit / (hit + miss). -1 if no events yet.',
  registers: [metricsRegistry],
});

/** Pool-level pg query duration — every query routed through `getPool()` /
 *  `getCrawlerPool()` lands here, so the observability does not depend on
 *  repositories opting in (the existing `satrank_db_query_duration_seconds`
 *  is opt-in per repo method). Labels limited to `{pool}` to avoid
 *  high-cardinality (pool-wide SQL text is not safe as a label). */
export const pgPoolQueryDuration = new client.Histogram({
  name: 'satrank_pg_pool_query_duration_seconds',
  help: 'Wall-clock duration of every pg pool.query() call, by pool name',
  labelNames: ['pool'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/** Count of pg errors thrown by pool.query(), by pool. Counters make the
 *  alert shape simple: `increase(satrank_pg_pool_query_errors_total[5m]) > 0`. */
export const pgPoolQueryErrors = new client.Counter({
  name: 'satrank_pg_pool_query_errors_total',
  help: 'pg pool.query() calls that threw, by pool',
  labelNames: ['pool'] as const,
  registers: [metricsRegistry],
});

/** Computes hit / (hit + miss) from the cacheEvents counter and publishes
 *  to the ratio gauge. Called from the scrape handler so PromQL sees a
 *  freshly recomputed value aligned with the rest of the snapshot. */
export async function refreshCacheRatio(): Promise<void> {
  const metric = await cacheEvents.get();
  let hits = 0;
  let misses = 0;
  for (const v of metric.values) {
    const ev = v.labels?.event;
    if (ev === 'hit' || ev === 'stale_hit') hits += v.value;
    else if (ev === 'miss') misses += v.value;
  }
  const total = hits + misses;
  cacheHitRatio.set(total > 0 ? hits / total : -1);
}

// --- HTTP metrics middleware ---

function normalizeRoute(req: Request): string {
  // Use the matched route pattern if available, else a fixed label
  if (req.route) {
    return req.baseUrl + req.route.path;
  }
  // Unmatched routes: fixed label to prevent high-cardinality label explosion
  return 'unmatched';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = normalizeRoute(req);
    const labels = { method: req.method, route, status: String(res.statusCode) };

    requestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });

  next();
}
