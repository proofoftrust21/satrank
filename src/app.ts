// Express application setup — dependency injection
import express, { Router } from 'express';
import path from 'path';
import { readFileSync } from 'node:fs';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, featureFlags } from './config';
import { DEFAULT_NOSTR_RELAYS } from './nostr/relays';
import { getPool } from './database/connection';
import { requestIdMiddleware } from './middleware/requestId';
import { requestTimeout } from './middleware/timeout';
import { errorHandler } from './middleware/errorHandler';
import { metricsMiddleware, metricsRegistry, agentsTotal, channelsTotal, operatorsTotal, rateLimitHits } from './middleware/metrics';
import { createProbeRateLimit } from './middleware/probeRateLimit';

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
import { ReportService } from './services/reportService';
import { ReportBonusService } from './services/reportBonusService';
import { LndInvoiceService } from './services/lndInvoiceService';
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
import { ProbeController } from './controllers/probeController';
import { ServiceController } from './controllers/serviceController';
import { IntentController } from './controllers/intentController';
import { IntentService } from './services/intentService';
import { ServiceRegisterController } from './controllers/serviceRegisterController';
import { ServiceRegisterLogRepository } from './repositories/serviceRegisterLogRepository';
import { OperatorController } from './controllers/operatorController';
import { OperatorService } from './services/operatorService';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from './repositories/operatorRepository';
import { EndpointController } from './controllers/endpointController';
import { WatchlistController } from './controllers/watchlistController';
import { ReportStatsController } from './controllers/reportStatsController';
import { BayesianScoringService } from './services/bayesianScoringService';
import { BayesianVerdictService } from './services/bayesianVerdictService';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from './repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from './repositories/dailyBucketsRepository';
import { RegistryCrawler } from './crawler/registryCrawler';
import { createBalanceAuth } from './middleware/balanceAuth';
import { createL402Native } from './middleware/l402Native';
import { OracleBudgetService } from './services/oracleBudgetService';
import { TrustAssertionRepository } from './repositories/trustAssertionRepository';
import { OraclePeerRepository } from './repositories/oracleFederationRepository';
import { PeerCalibrationRepository } from './repositories/peerCalibrationRepository';
import { createReportAuth, safeEqual } from './middleware/auth';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';
import { EndpointStagePosteriorsRepository } from './repositories/endpointStagePosteriorsRepository';
import { PreimagePoolRepository } from './repositories/preimagePoolRepository';

// Routes
import { createAgentRoutes } from './routes/agent';
import { createAttestationRoutes } from './routes/attestation';
import { createHealthRoutes } from './routes/health';
import { createV2Routes } from './routes/v2';
import { createPingRoutes } from './routes/ping';

// OpenAPI spec
import { openapiSpec } from './openapi';

// Infra
import { logger } from './logger';
import { setFresh as cacheSetFresh, getStale as cacheGetStale } from './cache/memoryCache';
import { TOP_SORT_AXES, TOP_WARMUP_LIMITS, CRITICAL_CACHE_TTL_MS } from './services/statsService';
import { isFreshRequest } from './utils/freshFlag';
import { DualWriteLogger } from './utils/dualWriteLogger';
import { safeJsonForScript } from './utils/safeJsonForScript';

export function createApp() {
  const app = express();

  // Phase 12B — pg Pool. Migrations are applied once at boot in src/index.ts
  // before createApp(); creating the app is a pure synchronous wiring step.
  const pool = getPool();

  // Dependency injection
  const agentRepo = new AgentRepository(pool);
  const txRepo = new TransactionRepository(pool);
  const attestationRepo = new AttestationRepository(pool);
  const snapshotRepo = new SnapshotRepository(pool);
  const probeRepo = new ProbeRepository(pool);
  const channelSnapshotRepo = new ChannelSnapshotRepository(pool);
  const feeSnapshotRepo = new FeeSnapshotRepository(pool);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, pool, probeRepo, channelSnapshotRepo, feeSnapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, pool);
  const serviceEndpointRepo = new ServiceEndpointRepository(pool);
  const endpointStagePosteriorsRepo = new EndpointStagePosteriorsRepository(pool);
  const preimagePoolRepo = new PreimagePoolRepository(pool);
  const riskService = new RiskService();

  // LND graph client — shared between auto-indexation, pathfinding, verdict,
  // and Phase 9 /api/probe (which needs the admin macaroon for payInvoice).
  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
    adminMacaroonPath: config.LND_ADMIN_MACAROON_PATH,
  });

  // statsService needs lndClient for the /api/health LND reachability check;
  // pass only when the client is actually configured so a missing macaroon
  // leaves lndStatus = 'disabled' rather than 'unknown' forever.
  const statsService = new StatsService(
    agentRepo, txRepo, attestationRepo, snapshotRepo, pool, trendService,
    probeRepo, serviceEndpointRepo,
    lndClient.isConfigured() ? lndClient : undefined,
  );

  // Phase 3 : Bayesian scoring stack — built before VerdictService so it can
  // be injected. BayesianVerdictService is a read-side composer that owns the
  // canonical Bayesian shape consumed across all public endpoints.
  const endpointStreamingRepo = new EndpointStreamingPosteriorRepository(pool);
  const serviceStreamingRepo = new ServiceStreamingPosteriorRepository(pool);
  const operatorStreamingRepo = new OperatorStreamingPosteriorRepository(pool);
  const nodeStreamingRepo = new NodeStreamingPosteriorRepository(pool);
  const routeStreamingRepo = new RouteStreamingPosteriorRepository(pool);
  const endpointBucketsRepo = new EndpointDailyBucketsRepository(pool);
  const serviceBucketsRepo = new ServiceDailyBucketsRepository(pool);
  const operatorBucketsRepo = new OperatorDailyBucketsRepository(pool);
  const nodeBucketsRepo = new NodeDailyBucketsRepository(pool);
  const routeBucketsRepo = new RouteDailyBucketsRepository(pool);
  const bayesianScoringService = new BayesianScoringService(
    endpointStreamingRepo, serviceStreamingRepo, operatorStreamingRepo, nodeStreamingRepo, routeStreamingRepo,
    endpointBucketsRepo, serviceBucketsRepo, operatorBucketsRepo, nodeBucketsRepo, routeBucketsRepo,
  );
  const bayesianVerdictService = new BayesianVerdictService(
    bayesianScoringService, endpointStreamingRepo, endpointBucketsRepo, snapshotRepo, serviceEndpointRepo,
  );

  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);

  // Phase 7 — operator abstraction construit en amont pour permettre à
  // VerdictService d'exposer operator_id (C11) et l'advisory OPERATOR_UNVERIFIED
  // (C12). OperatorController est instancié plus bas (dépend de agentRepo).
  const operatorRepo = new OperatorRepository(pool);
  const operatorIdentityRepo = new OperatorIdentityRepository(pool);
  const operatorOwnershipRepo = new OperatorOwnershipRepository(pool);
  const operatorService = new OperatorService(
    operatorRepo,
    operatorIdentityRepo,
    operatorOwnershipRepo,
    endpointStreamingRepo,
    nodeStreamingRepo,
    serviceStreamingRepo,
  );

  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, bayesianVerdictService, probeRepo, lndClient.isConfigured() ? lndClient : undefined, operatorService);
  const survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
  const channelFlowService = new ChannelFlowService(channelSnapshotRepo);
  const feeVolatilityService = new FeeVolatilityService(feeSnapshotRepo, agentRepo);

  const lndGraphCrawler = lndClient.isConfigured()
    ? new LndGraphCrawler(lndClient, agentRepo, channelSnapshotRepo, feeSnapshotRepo)
    : null;
  const autoIndexService = new AutoIndexService(
    lndGraphCrawler, agentRepo, scoringService, config.AUTO_INDEX_MAX_PER_MINUTE,
    bayesianVerdictService,
  );

  // Phase 1 shadow-mode: construct the NDJSON logger only when dry_run is
  // active (mirrors the crawler process — silent contract in off/active, no
  // filesystem setup when not needed). Shared across reportService + future
  // in-process writers if any.
  const dualWriteLogger = config.TRANSACTIONS_DUAL_WRITE_MODE === 'dry_run'
    ? new DualWriteLogger(config.TRANSACTIONS_DRY_RUN_LOG_PATH)
    : undefined;
  const reportService = new ReportService(
    attestationRepo, agentRepo, txRepo, scoringService, pool,
    config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
    bayesianScoringService,
  );

  // Tier 2 report bonus — gated by REPORT_BONUS_ENABLED env (off by default).
  // Constructing the service has no side effects when disabled; the guard
  // watcher is only started when the flag is true at boot.
  const reportBonusRepo = new ReportBonusRepository(pool);
  // Phase 12B — DB_PATH was removed with SQLite; npub-age cache is a plain
  // file under ./data, same directory convention as the old sqlite file.
  const npubAgeCachePath = path.join(process.cwd(), 'data', 'nostr-pubkey-ages.json');
  const npubAgeCache = new NpubAgeCache(npubAgeCachePath);
  npubAgeCache.reload();
  // Hourly reload so Stream B file updates propagate without process restart (audit M5).
  npubAgeCache.startAutoReload();
  const reportBonusService = new ReportBonusService(pool, reportBonusRepo, scoringService, npubAgeCache, {
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

  const agentController = new AgentController(agentService, agentRepo, verdictService, autoIndexService, pool);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService, pool, reportBonusService, preimagePoolRepo);
  const pingController = new PingController(lndClient.isConfigured() ? lndClient : undefined, agentRepo, probeRepo);
  const lndInvoiceService = new LndInvoiceService({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_INVOICE_MACAROON_PATH,
  });
  const depositController = new DepositController(pool, lndInvoiceService);
  const probeController = new ProbeController(pool, lndClient, {
    txRepo,
    bayesian: bayesianScoringService,
    serviceEndpointRepo,
    agentRepo,
    dualWriteMode: config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
  });
  const serviceController = new ServiceController(serviceEndpointRepo, agentRepo, agentService, bayesianVerdictService);
  const intentService = new IntentService({
    serviceEndpointRepo,
    agentRepo,
    agentService,
    bayesianVerdictService,
    trendService,
    probeRepo,
    operatorService,
    endpointStagePosteriorsRepo,
  });
  const intentController = new IntentController(intentService);
  const endpointController = new EndpointController(bayesianVerdictService, serviceEndpointRepo, agentRepo, operatorService);
  const watchlistController = new WatchlistController(agentRepo, snapshotRepo, agentService);
  const reportStatsController = new ReportStatsController(pool, reportBonusRepo, () => reportBonusService.isEnabled());

  // Self-registration — uses LND BOLT11 decoder if available
  const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
    ? (invoice: string) => lndClient.decodePayReq!(invoice)
    : undefined;
  const registryCrawler = decodeBolt11 ? new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo) : null;
  const serviceRegisterLogRepo = new ServiceRegisterLogRepository(pool);
  const serviceRegisterController = new ServiceRegisterController({
    registryCrawler,
    serviceEndpointRepo,
    registerLogRepo: serviceRegisterLogRepo,
    operatorService,
  });

  // Phase 7 — controller pour /api/operator(s) endpoints. operatorService est
  // construit plus haut (avant VerdictService pour les besoins C11/C12).
  const operatorController = new OperatorController({
    operatorService,
    operatorRepo,
    serviceEndpointRepo,
    agentRepo,
  });

  // Cache warm-up — fills the stats and leaderboard caches before the first
  // request lands, so the cold-start SQL rebuild (~1-2s on /api/stats) never
  // hits a real user. Failures are logged but non-fatal: the endpoints will
  // rebuild on demand if the warm-up SQL fails for any reason.
  // Phase 12B — fire-and-forget since createApp() stays sync; a promise
  // rejection here is already swallowed inside runWarmUp's per-call try/catch.
  void warmUpCaches(statsService, agentController, trendService);

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
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // Lock <base> and <form action> to same-origin to block base-tag hijacking
        // and form-relay exfiltration if a DOM-XSS sneaks past scriptSrc 'self'.
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  // Permissions-Policy: deny powerful browser features the site does not use.
  // Helmet 8 has no built-in middleware for this header yet, so we set it
  // directly. All entries use `()` which means "disabled for all origins".
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), ' +
      'camera=(), cross-origin-isolated=(), display-capture=(), ' +
      'document-domain=(), encrypted-media=(), fullscreen=(), geolocation=(), ' +
      'gyroscope=(), interest-cohort=(), keyboard-map=(), magnetometer=(), ' +
      'microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
      'publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), ' +
      'usb=(), web-share=(), xr-spatial-tracking=()'
    );
    next();
  });
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

  // SSR boot: inject cached stats into index.html so the hero/stats block
  // renders at first paint, zero API fetch needed. The template is read once
  // at startup (immutable inside the Docker image).
  const publicDir = path.join(__dirname, '..', 'public');
  const indexTemplate = readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  app.get('/', (_req, res) => {
    const stats = cacheGetStale<Record<string, unknown>>('stats:network');
    const boot = { stats: stats ?? null };
    const safeJson = safeJsonForScript(boot);
    const script = `<script>window.__SATRANK_BOOT__=${safeJson}</script>`;
    res.type('html').send(indexTemplate.replace('</head>', script + '\n</head>'));
  });

  // Static assets (CSS, JS, images, etc.)
  app.use(express.static(publicDir));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: publicDir }));
  // /docs : quickstart + API reference humain. Distinct de /api/docs (Swagger UI)
  // qui sert l'exploration interactive de l'OpenAPI 3.1.
  app.get('/docs', (_req, res) => res.sendFile('docs.html', { root: publicDir }));

  // Prometheus metrics endpoint — X-API-Key auth always required.
  // Phase 12B B6.2 : the historical localhost bypass was removed — IP-based
  // auth is weak when `trust proxy` is miscounted (CDN hop added, CNI/overlay
  // quirks), and a constant-time API-key compare is cheap enough to apply on
  // every scrape. L402_BYPASS keeps the endpoint open on the staging/bench
  // plane (fail-safed against prod by the boot guard in config.ts).
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
    skip: () => config.L402_BYPASS,
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'metrics' });
      res.status(options.statusCode).end('Too many metrics requests');
    },
  });
  app.get('/metrics', metricsRateLimit, (req, res, next) => {
    // Phase 12A A3 — staging/bench : L402_BYPASS=true opens /metrics so the
    // docker-bridge Prometheus can scrape without an API key. Fail-safed
    // against production by the startup guard in config.ts.
    if (config.L402_BYPASS) return next();
    // Require X-API-Key — constant-time compare to avoid timing leak that
    // would let an attacker brute-force the key one byte at a time.
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (safeEqual(apiKey, config.API_KEY)) return next();
    res.status(403).end('Forbidden — X-API-Key required');
  }, async (_req, res) => {
    try {
      const stats = await statsService.getNetworkStats();
      agentsTotal.set(stats.totalAgents);
      channelsTotal.set(stats.totalChannels);

      // Phase 7 C13 — operatorsTotal gauge refresh : countByStatus() est
      // indexé, une requête agrège les 3 buckets.
      const operatorCounts = await operatorRepo.countByStatus();
      operatorsTotal.set({ status: 'verified' }, operatorCounts.verified);
      operatorsTotal.set({ status: 'pending' }, operatorCounts.pending);
      operatorsTotal.set({ status: 'rejected' }, operatorCounts.rejected);

      // Refresh cache freshness gauges at scrape time
      const { getFreshnessReport } = await import('./cache/memoryCache');
      const {
        cacheAgeSeconds,
        cacheRefreshFailures,
        refreshEventLoopGauges,
        refreshCacheRatio,
      } = await import('./middleware/metrics');
      for (const r of getFreshnessReport()) {
        cacheAgeSeconds.set({ key: r.key }, r.ageSec);
        cacheRefreshFailures.set({ key: r.key }, r.consecutiveFailures);
      }

      // Phase 12B B6.3 — snapshot event-loop percentiles + cache hit ratio
      // aligned with the scrape so PromQL sees a coherent view.
      refreshEventLoopGauges();
      await refreshCacheRatio();

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
    skip: () => config.L402_BYPASS,
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
  const balanceAuth = createBalanceAuth(pool, { bypass: config.L402_BYPASS });
  const reportAuth = createReportAuth(pool);

  // Phase 6.4 — self-funding loop tracker. Logge chaque paid L402 call
  // dans oracle_revenue_log + chaque paid probe spending. Source of truth
  // pour /api/oracle/budget.
  const oracleBudgetService = new OracleBudgetService(pool);

  // L402 native gate — all paid endpoints go through createL402Native.
  // Pricing Mix A+D (2026-04-26): /agent/:publicKeyHash and its sub-routes
  // moved to free discovery, so they are no longer in the pricingMap.
  // POST /intent here is the *fresh* path only — the conditional middleware
  // below short-circuits paidGate when ?fresh=true is absent.
  const paidGate = createL402Native({
    secret: Buffer.from(config.L402_MACAROON_SECRET ?? '', 'hex'),
    lndInvoice: lndInvoiceService,
    pool,
    priceSats: config.L402_DEFAULT_PRICE_SATS,
    ttlSeconds: 30 * 24 * 60 * 60,
    expirySeconds: config.L402_INVOICE_EXPIRY_SECONDS,
    pricingMap: {
      '/probe': 5,
      '/verdicts': 1,
      '/profile/:id': 1,
      '/intent': 2,
    },
    operatorSecret: config.OPERATOR_BYPASS_SECRET,
    onPaidCallSettled: async (route, priceSats, paymentHash) => {
      // Mappe la route au source label du revenue log.
      const sourceMap: Record<string, 'fresh_query' | 'probe_query' | 'verdict_query' | 'profile_query' | 'other'> = {
        '/intent': 'fresh_query',
        '/probe': 'probe_query',
        '/verdicts': 'verdict_query',
        '/profile/:id': 'profile_query',
      };
      const source = sourceMap[route] ?? 'other';
      // Security H1 — payment_hash passé en dédup-key explicite : INSERT
      // ON CONFLICT DO NOTHING empêche le double-revenue si 2 requêtes
      // first-use simultanées passent par le callback avant que
      // token_balance auto-crée le row.
      await oracleBudgetService.logRevenue(
        source,
        priceSats,
        { route },
        paymentHash,
      );
    },
  });

  api.use(createV2Routes(v2Controller, balanceAuth, reportAuth, depositController, paidGate)); // report, deposit, profile (decide/best-route are 410 Gone)
  // Phase 9 C6 — POST /api/probe. Paid endpoint (5 credits per call): the
  // balanceAuth middleware takes 1 credit upstream, probeController debits
  // the remaining 4 atomically. Gated by the L402 native middleware like
  // the other paid routes.
  // Phase 9 C8 — two rate limiters in front of balanceAuth so rejections
  // never consume credits. See src/middleware/probeRateLimit.ts for ordering
  // rationale.
  const probeLimits = createProbeRateLimit({
    perTokenPerHour: config.PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR,
    globalPerHour: config.PROBE_RATE_LIMIT_GLOBAL_PER_HOUR,
  });
  api.post('/probe', paidGate, probeLimits.perToken, probeLimits.global, balanceAuth, probeController.probe);
  api.use(createPingRoutes(pingController));                           // ping/:pubkey (free, own rate limit)
  // Dedicated tight limiter on /api/version — the response is a thin build-info
  // document with commit hash + build time, so probing it at rate for
  // deploy-detection has no legitimate use. 60/min/IP keeps monitoring happy
  // while closing the high-volume fingerprinting vector.
  const versionRateLimit = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    skip: () => config.L402_BYPASS,
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
    skip: () => config.L402_BYPASS,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many discovery requests, please try again later' } },
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'discovery' });
      res.status(options.statusCode).json(options.message);
    },
  });
  api.get('/services', discoveryRateLimit, serviceController.search);
  api.get('/services/best', discoveryRateLimit, serviceController.best);
  api.get('/services/categories', discoveryRateLimit, serviceController.categories);
  // Phase 5 — alias under the /services namespace. Sim 3 agents instinctively
  // hit /api/services/:hash with the endpoint_hash returned by /api/intent
  // and got 404; the canonical route is /api/endpoint/:url_hash, but exposing
  // both makes the discovery flow forgiving without a doc lookup.
  api.get('/services/:url_hash', discoveryRateLimit, endpointController.show);

  // Pricing Mix A+D (2026-04-26) — agent + attestation reads moved to free
  // discovery. createAgentRoutes still receives paidGate/balanceAuth because
  // POST /verdicts (batch) stays paid; the GET /agent/* routes ignore them
  // and use discoveryRateLimit instead.
  api.use(createAgentRoutes(agentController, balanceAuth, paidGate, discoveryRateLimit));
  api.use(createAttestationRoutes(attestationController, balanceAuth, paidGate, discoveryRateLimit));

  // /api/intent — Mix A+D conditional gate. Default path = free directory
  // read with staleness disclaimer. ?fresh=true (or { fresh: true } in body)
  // → paidGate + balanceAuth so the resolver can run a synchronous probe of
  // the top-N candidates and guarantee last_probe_age_sec < freshness window.
  // The route path is `/intent`; pricingMap['/intent'] = 2 sats engages only
  // when the wrapper invokes paidGate (not on free calls).
  const conditionalIntentPaidGate: import('express').RequestHandler = (req, res, next) => {
    const wantsFresh = isFreshRequest(req);
    if (!wantsFresh) return next();
    paidGate(req, res, (err: unknown) => {
      if (err) return next(err);
      if (res.headersSent) return; // paidGate emitted 402/401/etc.
      balanceAuth(req, res, next);
    });
  };
  api.post('/intent', discoveryRateLimit, conditionalIntentPaidGate, intentController.resolve);
  api.get('/intent/categories', discoveryRateLimit, intentController.categories);
  api.post('/services/register', discoveryRateLimit, serviceRegisterController.register);
  api.patch('/services/register', discoveryRateLimit, serviceRegisterController.update);
  api.delete('/services/register', discoveryRateLimit, serviceRegisterController.remove);
  // Phase 7 — operator registration (NIP-98 gated, rate-limited avec discovery
  // car endpoint à effort de preuve côté claimant — pas de quota L402).
  api.post('/operator/register', discoveryRateLimit, operatorController.register);
  api.get('/operators', discoveryRateLimit, operatorController.list);
  api.get('/operator/:id', discoveryRateLimit, operatorController.show);
  api.get('/endpoint/:url_hash', discoveryRateLimit, endpointController.show);
  api.get('/watchlist', discoveryRateLimit, watchlistController.getChanges);
  // /api/stats/reports — 30-day report-adoption dashboard. Cached 5 min, free.
  api.get('/stats/reports', discoveryRateLimit, reportStatsController.getStats);
  // Phase 6.4 — /api/oracle/budget : public observability du self-funding
  // loop. Lifetime + 30d + 7d revenue/spending + balance + coverage_ratio.
  // Free, rate-limited via discoveryRateLimit. Permet aux agents/auditors
  // de vérifier que l'oracle est durablement financé.
  api.get('/oracle/budget', discoveryRateLimit, async (_req, res, next) => {
    try {
      const snapshot = await oracleBudgetService.getBudgetMultiWindow();
      res.json({ data: snapshot });
    } catch (err) {
      next(err);
    }
  });

  // Phase 6.3 — /api/oracle/assertion/:url_hash : metadata de la kind 30782
  // trust assertion publiée par l'oracle pour un endpoint donné. Permet
  // aux operators de retrouver l'event_id à embarquer dans leur BOLT12
  // offer (TLV custom) et aux agents de fetch directement depuis les
  // relays sans passer par /api/intent.
  //
  // Hint BOLT12 TLV : convention proposée
  //   type 65537 → event_id (32 bytes raw, hex on the wire)
  //   type 65538 → oracle_pubkey (32 bytes raw)
  // Le BOLT12 builder côté operator (FewSats, Alby toolkit, etc.) lit ces
  // valeurs et les ajoute aux TLV custom. Pas de standard IETF —
  // proposition à valider avec les écosystèmes.
  const trustAssertionRepoApi = new TrustAssertionRepository(pool);
  // Phase 7.1 — /api/oracle/peers : list des autres oracles SatRank-
  // compatible découverts via les kind 30784 ingérés sur les relays.
  // Format inclut oracle_pubkey, lnd_pubkey, catalogue_size, latest
  // calibration/assertion event ids, last_seen — l'agent SDK filtre
  // côté client par calibration_error / age / catalogue_size selon ses
  // critères. Pas de filtering trust côté serveur (sovereignty).
  const oraclePeerRepoApi = new OraclePeerRepository(pool);
  api.get('/oracle/peers', discoveryRateLimit, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50), 200);
      const peers = await oraclePeerRepoApi.list(limit);
      const nowSec = Math.floor(Date.now() / 1000);
      res.json({
        data: {
          peers: peers.map((p) => ({
            oracle_pubkey: p.oracle_pubkey,
            lnd_pubkey: p.lnd_pubkey,
            catalogue_size: p.catalogue_size,
            calibration_event_id: p.calibration_event_id,
            last_assertion_event_id: p.last_assertion_event_id,
            contact: p.contact,
            onboarding_url: p.onboarding_url,
            last_seen: p.last_seen,
            first_seen: p.first_seen,
            age_sec: nowSec - p.first_seen,
            stale_sec: nowSec - p.last_seen,
            latest_announcement_event_id: p.latest_announcement_event_id,
          })),
          count: peers.length,
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Phase 9.1 — /api/oracle/peers/:pubkey/calibrations : historique des
  // kind 30783 calibration events publiés par un peer SatRank-compatible.
  // Permet aux clients de vérifier la calibration history d'un peer
  // avant de l'inclure dans une aggregation. Cross-oracle meta-confidence.
  const peerCalibrationRepoApi = new PeerCalibrationRepository(pool);
  api.get('/oracle/peers/:pubkey/calibrations', discoveryRateLimit, async (req, res, next) => {
    try {
      const pubkey = String(req.params.pubkey);
      if (!/^[a-f0-9]{64}$/.test(pubkey)) {
        return res.status(400).json({ error: { code: 'INVALID_PUBKEY', message: 'pubkey must be a 64-char hex Schnorr key' } });
      }
      const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20), 100);
      const calibrations = await peerCalibrationRepoApi.listByPeer(pubkey, limit);
      res.json({
        data: {
          peer_pubkey: pubkey,
          calibrations: calibrations.map((c) => ({
            event_id: c.event_id,
            window_start: c.window_start,
            window_end: c.window_end,
            window_days: Math.round((c.window_end - c.window_start) / 86400),
            delta_mean: c.delta_mean,
            delta_median: c.delta_median,
            delta_p95: c.delta_p95,
            n_endpoints: c.n_endpoints,
            n_outcomes: c.n_outcomes,
            observed_at: c.observed_at,
          })),
          count: calibrations.length,
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/oracle/assertion/:url_hash', discoveryRateLimit, async (req, res, next) => {
    try {
      const urlHash = String(req.params.url_hash);
      if (!/^[a-f0-9]{64}$/.test(urlHash)) {
        return res.status(400).json({ error: { code: 'INVALID_URL_HASH', message: 'url_hash must be a 64-char hex SHA256' } });
      }
      const record = await trustAssertionRepoApi.findByUrlHash(urlHash);
      if (!record) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No trust assertion published yet for this endpoint. Wait for the next cron tick (≤ 7 days) or check that the endpoint has meaningful stage posteriors.' } });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresInSec = record.valid_until - nowSec;
      res.json({
        data: {
          endpoint_url_hash: record.endpoint_url_hash,
          kind: 30782,
          event_id: record.event_id,
          oracle_pubkey: record.oracle_pubkey,
          valid_until: record.valid_until,
          expires_in_sec: expiresInSec,
          expired: expiresInSec < 0,
          p_e2e: record.p_e2e,
          meaningful_stages_count: record.meaningful_stages_count,
          calibration_proof_event_id: record.calibration_proof_event_id,
          published_at: record.published_at,
          relays: record.relays,
          bolt12_tlv_hint: {
            note: 'Proposed convention for embedding the trust assertion in a BOLT12 offer. Type IDs not yet IETF-standardized — operators should track future BLIPs.',
            type_event_id: 65537,
            type_oracle_pubkey: 65538,
            event_id_hex: record.event_id,
            oracle_pubkey_hex: record.oracle_pubkey,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });
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

/** Populate the hot caches so the first visitor skips the cold-start cost.
 *  After this runs once, getOrCompute serves everything instantly and refreshes
 *  in the background. All calls are wrapped so a warm-up failure never blocks
 *  startup — Phase 12B: async now that stats/top queries go through pg. */
async function warmUpCaches(
  statsService: StatsService,
  agentController: AgentController,
  trendService: TrendService,
): Promise<void> {
  await runWarmUp(statsService, agentController, trendService, /* initial= */ true);

  // Sim #5 #11: SWR only refreshes on demand — if no traffic hits /api/stats for
  // longer than the TTL, the freshness gauge reports huge staleness (observed
  // 6366s) even though the data would rebuild cheaply. A periodic refresh
  // inside the TTL window keeps the cache warm regardless of traffic.
  const REFRESH_INTERVAL_MS = 4 * 60_000; // just inside the 5-min TTL
  const timer = setInterval(
    () => { void runWarmUp(statsService, agentController, trendService, false); },
    REFRESH_INTERVAL_MS,
  );
  // Don't block process exit for tests / graceful shutdown.
  timer.unref();
}

async function runWarmUp(
  statsService: StatsService,
  agentController: AgentController,
  trendService: TrendService,
  initial: boolean,
): Promise<void> {
  const start = Date.now();
  try {
    await statsService.getNetworkStats();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: getNetworkStats failed');
  }

  // Refresh every (limit × sort_by) combo the health check monitors as critical.
  // The list lives in statsService so a key cannot be declared critical without
  // being warmed — warm-up and CRITICAL_CACHE_KEYS share a single source of truth.
  for (const limit of TOP_WARMUP_LIMITS) {
    for (const sortBy of TOP_SORT_AXES) {
      try {
        const response = await agentController.buildTopResponse(limit, 0, sortBy);
        cacheSetFresh(`agents:top:${limit}:0:${sortBy}`, response, CRITICAL_CACHE_TTL_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg, limit, sortBy }, 'Cache warm-up: buildTopResponse failed');
      }
    }
  }
  // Movers cache is served from the controller (empty envelope in Phase 3)
  // — no warm-up needed until Commit 8 lands posterior deltas.
  void trendService;

  if (initial) {
    logger.info({ durationMs: Date.now() - start }, 'Cache warm-up complete');
  } else {
    logger.debug({ durationMs: Date.now() - start }, 'Cache periodic refresh complete');
  }
}
