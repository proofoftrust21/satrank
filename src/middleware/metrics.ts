// Prometheus metrics middleware and registry
import client from 'prom-client';
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
