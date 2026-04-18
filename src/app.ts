// Express application setup — dependency injection
import express, { Router } from 'express';
import path from 'path';
import { readFileSync } from 'node:fs';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { DEFAULT_NOSTR_RELAYS } from './nostr/relays';
import { getDatabase } from './database/connection';
import { runMigrations } from './database/migrations';
import { requestIdMiddleware } from './middleware/requestId';
import { requestTimeout } from './middleware/timeout';
import { errorHandler } from './middleware/errorHandler';
import { metricsMiddleware, metricsRegistry, agentsTotal, channelsTotal, rateLimitHits } from './middleware/metrics';

// Repositories
import { AgentRepository } from './repositories/agentRepository';
import { TransactionRepository } from './repositories/transactionRepository';
import { AttestationRepository } from './repositories/attestationRepository';
import { SnapshotRepository } from './repositories/snapshotRepository';
import { ProbeRepository } from './repositories/probeRepository';

// Services
import { ScoringService } from './services/scoringService';
import { AgentService } from './services/agentService';
import { AttestationService } from './services/attestationService';
import { StatsService } from './services/statsService';
import { TrendService } from './services/trendService';
import { VerdictService } from './services/verdictService';
import { RiskService } from './services/riskService';
import { DecideService } from './services/decideService';
import { ReportService } from './services/reportService';
import { ReportBonusService } from './services/reportBonusService';
import { ReportBonusRepository } from './repositories/reportBonusRepository';
import { NpubAgeCache } from './nostr/npubAgeCache';
import { SurvivalService } from './services/survivalService';
import { ChannelFlowService } from './services/channelFlowService';
import { FeeVolatilityService } from './services/feeVolatilityService';
import { AutoIndexService } from './services/autoIndexService';
import { ChannelSnapshotRepository } from './repositories/channelSnapshotRepository';
import { FeeSnapshotRepository } from './repositories/feeSnapshotRepository';
import { HttpLndGraphClient } from './crawler/lndGraphClient';
import { LndGraphCrawler } from './crawler/lndGraphCrawler';

// Controllers
import { AgentController } from './controllers/agentController';
import { AttestationController } from './controllers/attestationController';
import { HealthController } from './controllers/healthController';
import { V2Controller } from './controllers/v2Controller';
import { PingController } from './controllers/pingController';
import { DepositController } from './controllers/depositController';
import { ServiceController } from './controllers/serviceController';
import { ServiceRegisterController } from './controllers/serviceRegisterController';
import { WatchlistController } from './controllers/watchlistController';
import { ReportStatsController } from './controllers/reportStatsController';
import { BayesianController } from './controllers/bayesianController';
import { BayesianScoringService } from './services/bayesianScoringService';
import { BayesianVerdictService } from './services/bayesianVerdictService';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from './repositories/aggregatesRepository';
import { RegistryCrawler } from './crawler/registryCrawler';
import { createBalanceAuth } from './middleware/balanceAuth';
import { createReportAuth, safeEqual } from './middleware/auth';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';
import { PreimagePoolRepository } from './repositories/preimagePoolRepository';

// Routes
import { createAgentRoutes } from './routes/agent';
import { createAttestationRoutes } from './routes/attestation';
import { createHealthRoutes } from './routes/health';
import { createV2Routes } from './routes/v2';
import { createPingRoutes } from './routes/ping';
import { createBayesianRoutes } from './routes/bayesian';

// OpenAPI spec
import { openapiSpec } from './openapi';

// Infra
import { logger } from './logger';
import { set as cacheSet, getStale as cacheGetStale } from './cache/memoryCache';
import { DualWriteLogger } from './utils/dualWriteLogger';

export function createApp() {
  const app = express();

  // Database
  const db = getDatabase();
  runMigrations(db);

  // Dependency injection
  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const probeRepo = new ProbeRepository(db);
  const channelSnapshotRepo = new ChannelSnapshotRepository(db);
  const feeSnapshotRepo = new FeeSnapshotRepository(db);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo, channelSnapshotRepo, feeSnapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo, probeRepo);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const serviceEndpointRepo = new ServiceEndpointRepository(db);
  const preimagePoolRepo = new PreimagePoolRepository(db);
  const riskService = new RiskService();

  // LND graph client — shared between auto-indexation, pathfinding, and verdict
  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });

  // statsService needs lndClient for the /api/health LND reachability check;
  // pass only when the client is actually configured so a missing macaroon
  // leaves lndStatus = 'disabled' rather than 'unknown' forever.
  const statsService = new StatsService(
    agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService,
    probeRepo, serviceEndpointRepo,
    lndClient.isConfigured() ? lndClient : undefined,
  );

  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, lndClient.isConfigured() ? lndClient : undefined);
  const survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
  const channelFlowService = new ChannelFlowService(channelSnapshotRepo);
  const feeVolatilityService = new FeeVolatilityService(feeSnapshotRepo, agentRepo);

  const lndGraphCrawler = lndClient.isConfigured()
    ? new LndGraphCrawler(lndClient, agentRepo, channelSnapshotRepo, feeSnapshotRepo)
    : null;
  const autoIndexService = new AutoIndexService(
    lndGraphCrawler, agentRepo, scoringService, config.AUTO_INDEX_MAX_PER_MINUTE,
  );

  const decideService = new DecideService({
    agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService,
    probeRepo, lndClient: lndClient.isConfigured() ? lndClient : undefined, survivalService,
    serviceEndpointRepo,
  });
  // Phase 1 shadow-mode: construct the NDJSON logger only when dry_run is
  // active (mirrors the crawler process — silent contract in off/active, no
  // filesystem setup when not needed). Shared across reportService + future
  // in-process writers if any.
  const dualWriteLogger = config.TRANSACTIONS_DUAL_WRITE_MODE === 'dry_run'
    ? new DualWriteLogger(config.TRANSACTIONS_DRY_RUN_LOG_PATH)
    : undefined;
  const reportService = new ReportService(
    attestationRepo, agentRepo, txRepo, scoringService, db,
    config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
  );

  // Tier 2 report bonus — gated by REPORT_BONUS_ENABLED env (off by default).
  // Constructing the service has no side effects when disabled; the guard
  // watcher is only started when the flag is true at boot.
  const reportBonusRepo = new ReportBonusRepository(db);
  const npubAgeCachePath = path.join(path.dirname(config.DB_PATH), 'nostr-pubkey-ages.json');
  const npubAgeCache = new NpubAgeCache(npubAgeCachePath);
  npubAgeCache.reload();
  // Hourly reload so Stream B file updates propagate without process restart (audit M5).
  npubAgeCache.startAutoReload();
  const reportBonusService = new ReportBonusService(db, reportBonusRepo, scoringService, npubAgeCache, {
    enabledFromEnv: config.REPORT_BONUS_ENABLED,
    threshold: config.REPORT_BONUS_THRESHOLD,
    dailyCap: config.REPORT_BONUS_DAILY_CAP,
    satsPerBonus: config.REPORT_BONUS_SATS,
    minReporterScore: config.REPORT_BONUS_MIN_REPORTER_SCORE,
    minNpubAgeDays: config.REPORT_BONUS_MIN_NPUB_AGE_DAYS,
    rollbackRatio: config.REPORT_BONUS_ROLLBACK_RATIO,
    guardIntervalMs: config.REPORT_BONUS_GUARD_INTERVAL_MS,
  });
  reportBonusService.startGuard();

  const agentController = new AgentController(agentService, agentRepo, snapshotRepo, trendService, verdictService, autoIndexService, db);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(decideService, reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService, verdictService, serviceEndpointRepo, db, reportBonusService, preimagePoolRepo);
  const pingController = new PingController(lndClient.isConfigured() ? lndClient : undefined, agentRepo, probeRepo);
  const depositController = new DepositController(db);
  const serviceController = new ServiceController(serviceEndpointRepo, agentRepo, scoringService);
  const watchlistController = new WatchlistController(agentRepo, snapshotRepo, scoringService);
  const reportStatsController = new ReportStatsController(db, reportBonusRepo, () => reportBonusService.isEnabled());

  // Phase 3 : Bayesian scoring stack
  const endpointAggRepo = new EndpointAggregateRepository(db);
  const serviceAggRepo = new ServiceAggregateRepository(db);
  const operatorAggRepo = new OperatorAggregateRepository(db);
  const nodeAggRepo = new NodeAggregateRepository(db);
  const routeAggRepo = new RouteAggregateRepository(db);
  const bayesianScoringService = new BayesianScoringService(
    endpointAggRepo, serviceAggRepo, operatorAggRepo, nodeAggRepo, routeAggRepo,
  );
  const bayesianVerdictService = new BayesianVerdictService(db, bayesianScoringService);
  const bayesianController = new BayesianController(bayesianVerdictService);

  // Self-registration — uses LND BOLT11 decoder if available
  const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
    ? (invoice: string) => lndClient.decodePayReq!(invoice).then(r => r ? { destination: r.destination, num_satoshis: undefined } : null)
    : undefined;
  const registryCrawler = decodeBolt11 ? new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo) : null;
  const serviceRegisterController = new ServiceRegisterController(registryCrawler);

  // Cache warm-up — fills the stats and leaderboard caches before the first
  // request lands, so the cold-start SQL rebuild (~1-2s on /api/stats) never
  // hits a real user. Failures are logged but non-fatal: the endpoints will
  // rebuild on demand if the warm-up SQL fails for any reason.
  warmUpCaches(statsService, agentController, trendService);

  // Trust first proxy hop (nginx/caddy) so rate limiter sees real client IPs.
  // IMPORTANT: if a CDN (Cloudflare, Fastly) is added in front of nginx, increase to 2.
  // Wrong value = rate limiter keys on proxy IP instead of client IP.
  app.set('trust proxy', 1);

  // Global middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        // The methodology page's live-circuit widget opens WebSocket
        // connections to the 3 canonical Nostr relays from the browser
        // to verify SatRank's NIP-85 events end-to-end. Without these
        // entries, helmet's default `connect-src 'self'` makes the
        // browser block all wss:// connections and the widget reports
        // "0 / 3 relays responded" even when the events are present.
        connectSrc: [
          "'self'",
          'wss://relay.damus.io',
          'wss://nos.lol',
          'wss://relay.primal.net',
        ],
        frameAncestors: ["'none'"],
        // Lock <base> and <form action> to same-origin to block base-tag hijacking
        // and form-relay exfiltration if a DOM-XSS sneaks past scriptSrc 'self'.
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(cors({ origin: config.CORS_ORIGIN }));
  // express.json() parses the body into req.body but does NOT expose the raw
  // bytes. NIP-98 signatures bind to sha256(rawBody) so we capture via the
  // `verify` hook. Without this, the NIP-98 payload tag check was silently
  // bypassed on every request (audit C1) and an attacker could reuse one
  // signed envelope with arbitrary bodies.
  app.use(express.json({
    limit: '10kb',
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      // `buf` is the raw bytes; we copy to isolate from any downstream
      // middleware that may mutate the buffer. Only present when a body
      // was actually sent; GET/HEAD/empty-POST leave it undefined.
      if (buf && buf.length > 0) {
        req.rawBody = Buffer.from(buf);
      }
    },
  }));

  // X-API-Version header on all responses
  app.use((_req, res, next) => {
    res.setHeader('X-API-Version', '1.0');
    next();
  });

  // Prometheus request metrics
  app.use(metricsMiddleware);

  // Reject POST/PUT/PATCH requests without application/json Content-Type
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
      return;
    }
    next();
  });

  app.use(requestIdMiddleware);
  app.use(requestTimeout(30_000));

  // NIP-05 — Nostr identity verification (must be before static middleware)
  app.get('/.well-known/nostr.json', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      names: {
        satrank: '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4',
      },
      relays: {
        '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4': [...DEFAULT_NOSTR_RELAYS],
      },
    });
  });

  // SSR boot: inject cached stats + leaderboard into index.html so the
  // browser renders both sections at first paint, zero API fetch needed.
  // The template is read once at startup (immutable inside the Docker image).
  const publicDir = path.join(__dirname, '..', 'public');
  const indexTemplate = readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  app.get('/', (_req, res) => {
    const stats = cacheGetStale<Record<string, unknown>>('stats:network');
    const top = cacheGetStale<{ data: unknown[] }>('agents:top:10:0:score');
    const boot = { stats: stats ?? null, leaderboard: top ?? null };
    // Escape </script>, <, >, & in JSON to prevent XSS via malicious node
    // aliases (e.g. `</script><script>alert(1)//`) injected via LND gossip.
    const safeJson = JSON.stringify(boot)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');
    const script = `<script>window.__SATRANK_BOOT__=${safeJson}</script>`;
    res.type('html').send(indexTemplate.replace('</head>', script + '\n</head>'));
  });

  // Static assets (CSS, JS, images, etc.)
  app.use(express.static(publicDir));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: publicDir }));

  // Prometheus metrics endpoint — localhost OR X-API-Key auth.
  // Localhost access (docker network, Prometheus sidecar, SSH tunnel): no auth.
  // External access: requires same API_KEY as write endpoints to prevent metric leakage.
  // Dedicated rate limiter — `/metrics` is mounted before the /api rate
  // limiter. Without a limiter here, the API_KEY comparison is brute-forceable
  // at wire speed (audit H6).
  const metricsRateLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: 'Too many metrics requests',
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'metrics' });
      res.status(options.statusCode).end('Too many metrics requests');
    },
  });
  app.get('/metrics', metricsRateLimit, (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLocalhost) return next();
    // External: require API key — constant-time compare to avoid timing leak
    // that would let an attacker brute-force the key one byte at a time.
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (safeEqual(apiKey, config.API_KEY)) return next();
    res.status(403).end('Forbidden — use localhost or X-API-Key');
  }, async (_req, res) => {
    try {
      const stats = statsService.getNetworkStats();
      agentsTotal.set(stats.totalAgents);
      channelsTotal.set(stats.totalChannels);

      // Refresh cache freshness gauges at scrape time
      const { getFreshnessReport } = await import('./cache/memoryCache');
      const { cacheAgeSeconds, cacheRefreshFailures } = await import('./middleware/metrics');
      for (const r of getFreshnessReport()) {
        cacheAgeSeconds.set({ key: r.key }, r.ageSec);
        cacheRefreshFailures.set({ key: r.key }, r.consecutiveFailures);
      }

      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (err: unknown) {
      // Without a log here, a Prometheus scrape failure is invisible — the
      // target just goes DOWN with no diagnostic in the app logs.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Metrics scrape failed');
      res.status(500).end('Internal Server Error');
    }
  });

  // Rate limiter scoped to API routes only (not /metrics, not static)
  const apiRateLimit = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
    // handler fires AFTER the limiter has decided to reject. Counting here
    // gives us a per-limiter 429 count that HTTP status metrics can't
    // distinguish (global vs discovery vs deposit all emit 429).
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'global' });
      res.status(options.statusCode).json(options.message);
    },
  });

  // API routes — single namespace /api/
  const api = Router();
  api.use(apiRateLimit);

  // Tip header — help agents reduce routing fees by opening a direct channel
  if (config.NODE_PUBKEY) {
    api.use((_req, res, next) => {
      res.setHeader('X-SatRank-Tip', `Save on routing fees - open a channel to ${config.NODE_PUBKEY}`);
      next();
    });
  }
  const balanceAuth = createBalanceAuth(db);
  const reportAuth = createReportAuth(db);
  api.use(createV2Routes(v2Controller, balanceAuth, reportAuth, depositController)); // decide, report, deposit, profile
  api.use(createPingRoutes(pingController));                           // ping/:pubkey (free, own rate limit)
  api.use(createAgentRoutes(agentController, balanceAuth));            // agent/:hash, verdict, top, search, movers
  api.use(createAttestationRoutes(attestationController, balanceAuth));// attestations (GET paid, POST free)
  api.use(createBayesianRoutes(bayesianController));                   // bayesian/:target — canonical Phase 3 verdict shape
  // Dedicated tight limiter on /api/version — the response is a thin build-info
  // document with commit hash + build time, so probing it at rate for
  // deploy-detection has no legitimate use. 60/min/IP keeps monitoring happy
  // while closing the high-volume fingerprinting vector.
  const versionRateLimit = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many version requests, please try again later' } },
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'version' });
      res.status(options.statusCode).json(options.message);
    },
  });
  api.use('/version', versionRateLimit);
  api.use(createHealthRoutes(healthController));          // health, stats, version
  // Free discovery/monitoring endpoints — own rate limits (expensive SQL, no L402 gate)
  const discoveryRateLimit = rateLimit({
    windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many discovery requests, please try again later' } },
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'discovery' });
      res.status(options.statusCode).json(options.message);
    },
  });
  api.get('/services', discoveryRateLimit, serviceController.search);
  api.get('/services/best', discoveryRateLimit, serviceController.best);
  api.get('/services/categories', discoveryRateLimit, serviceController.categories);
  api.post('/services/register', discoveryRateLimit, serviceRegisterController.register);
  api.get('/watchlist', discoveryRateLimit, watchlistController.getChanges);
  // /api/stats/reports — 30-day report-adoption dashboard. Cached 5 min, free.
  api.get('/stats/reports', discoveryRateLimit, reportStatsController.getStats);
  api.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  api.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SatRank API Docs</title>
  <link rel="stylesheet" href="/swagger-ui.css">
  <link rel="stylesheet" href="/swagger-custom.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui-bundle.js"></script>
  <script src="/swagger-init.js"></script>
</body>
</html>`);
  });
  app.use('/api', api);

  // Error handler (must be the last middleware)
  app.use(errorHandler);

  return app;
}

/** Synchronously populate the hot caches so the first visitor skips the cold-start cost.
 *  After this runs once, getOrCompute will serve everything instantly and refresh in
 *  the background. All calls are wrapped so a warm-up failure never blocks startup. */
function warmUpCaches(statsService: StatsService, agentController: AgentController, trendService: TrendService): void {
  runWarmUp(statsService, agentController, trendService, /* initial= */ true);

  // Sim #5 #11: SWR only refreshes on demand — if no traffic hits /api/stats for
  // longer than the TTL, the freshness gauge reports huge staleness (observed
  // 6366s) even though the data would rebuild cheaply. A periodic refresh
  // inside the TTL window keeps the cache warm regardless of traffic.
  const REFRESH_INTERVAL_MS = 4 * 60_000; // just inside the 5-min TTL
  const timer = setInterval(
    () => runWarmUp(statsService, agentController, trendService, false),
    REFRESH_INTERVAL_MS,
  );
  // Don't block process exit for tests / graceful shutdown.
  timer.unref();
}

function runWarmUp(
  statsService: StatsService,
  agentController: AgentController,
  trendService: TrendService,
  initial: boolean,
): void {
  const start = Date.now();
  try {
    statsService.getNetworkStats();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: getNetworkStats failed');
  }

  for (const limit of [5, 10, 20]) {
    try {
      const response = agentController.buildTopResponse(limit, 0, 'score');
      cacheSet(`agents:top:${limit}:0:score`, response, 5 * 60_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg, limit }, 'Cache warm-up: buildTopResponse failed');
    }
  }

  try {
    const { up, down } = trendService.getTopMovers(5);
    cacheSet('agents:movers', { data: { gainers: up, losers: down } }, 5 * 60_000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: getTopMovers failed');
  }

  if (initial) {
    logger.info({ durationMs: Date.now() - start }, 'Cache warm-up complete');
  } else {
    logger.debug({ durationMs: Date.now() - start }, 'Cache periodic refresh complete');
  }
}
