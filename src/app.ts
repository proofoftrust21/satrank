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
import { createReportAuth, apertureGateAuth, safeEqual } from './middleware/auth';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';
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
import { DualWriteLogger } from './utils/dualWriteLogger';
import { safeJsonForScript } from './utils/safeJsonForScript';

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
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const serviceEndpointRepo = new ServiceEndpointRepository(db);
  const preimagePoolRepo = new PreimagePoolRepository(db);
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
    agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService,
    probeRepo, serviceEndpointRepo,
    lndClient.isConfigured() ? lndClient : undefined,
  );

  // Phase 3 : Bayesian scoring stack — built before VerdictService so it can
  // be injected. BayesianVerdictService is a read-side composer that owns the
  // canonical Bayesian shape consumed across all public endpoints.
  const endpointStreamingRepo = new EndpointStreamingPosteriorRepository(db);
  const serviceStreamingRepo = new ServiceStreamingPosteriorRepository(db);
  const operatorStreamingRepo = new OperatorStreamingPosteriorRepository(db);
  const nodeStreamingRepo = new NodeStreamingPosteriorRepository(db);
  const routeStreamingRepo = new RouteStreamingPosteriorRepository(db);
  const endpointBucketsRepo = new EndpointDailyBucketsRepository(db);
  const serviceBucketsRepo = new ServiceDailyBucketsRepository(db);
  const operatorBucketsRepo = new OperatorDailyBucketsRepository(db);
  const nodeBucketsRepo = new NodeDailyBucketsRepository(db);
  const routeBucketsRepo = new RouteDailyBucketsRepository(db);
  const bayesianScoringService = new BayesianScoringService(
    endpointStreamingRepo, serviceStreamingRepo, operatorStreamingRepo, nodeStreamingRepo, routeStreamingRepo,
    endpointBucketsRepo, serviceBucketsRepo, operatorBucketsRepo, nodeBucketsRepo, routeBucketsRepo,
  );
  const bayesianVerdictService = new BayesianVerdictService(
    db, bayesianScoringService, endpointStreamingRepo, endpointBucketsRepo, snapshotRepo,
  );

  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);

  // Phase 7 — operator abstraction construit en amont pour permettre à
  // VerdictService d'exposer operator_id (C11) et l'advisory OPERATOR_UNVERIFIED
  // (C12). OperatorController est instancié plus bas (dépend de agentRepo).
  const operatorRepo = new OperatorRepository(db);
  const operatorIdentityRepo = new OperatorIdentityRepository(db);
  const operatorOwnershipRepo = new OperatorOwnershipRepository(db);
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
    attestationRepo, agentRepo, txRepo, scoringService, db,
    config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
    bayesianScoringService,
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

  const agentController = new AgentController(agentService, agentRepo, verdictService, autoIndexService, db);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService, db, reportBonusService, preimagePoolRepo);
  const pingController = new PingController(lndClient.isConfigured() ? lndClient : undefined, agentRepo, probeRepo);
  const depositController = new DepositController(db);
  const probeController = new ProbeController(db, lndClient, {
    txRepo,
    bayesian: bayesianScoringService,
    serviceEndpointRepo,
    agentRepo,
    dualWriteMode: config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
  });
  const serviceController = new ServiceController(serviceEndpointRepo, agentRepo, agentService);
  const intentService = new IntentService({
    serviceEndpointRepo,
    agentRepo,
    agentService,
    trendService,
    probeRepo,
    operatorService,
  });
  const intentController = new IntentController(intentService);
  const endpointController = new EndpointController(bayesianVerdictService, serviceEndpointRepo, agentRepo, operatorService);
  const watchlistController = new WatchlistController(agentRepo, snapshotRepo, agentService);
  const reportStatsController = new ReportStatsController(db, reportBonusRepo, () => reportBonusService.isEnabled());

  // Self-registration — uses LND BOLT11 decoder if available
  const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
    ? (invoice: string) => lndClient.decodePayReq!(invoice).then(r => r ? { destination: r.destination, num_satoshis: undefined } : null)
    : undefined;
  const registryCrawler = decodeBolt11 ? new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo) : null;
  const serviceRegisterController = new ServiceRegisterController(registryCrawler);

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
    const safeJson = safeJsonForScript(boot);
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

      // Phase 7 C13 — operatorsTotal gauge refresh : countByStatus() est
      // indexé, une requête agrège les 3 buckets.
      const operatorCounts = operatorRepo.countByStatus();
      operatorsTotal.set({ status: 'verified' }, operatorCounts.verified);
      operatorsTotal.set({ status: 'pending' }, operatorCounts.pending);
      operatorsTotal.set({ status: 'rejected' }, operatorCounts.rejected);

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
  // Phase 9 C6 — POST /api/probe. Paid endpoint (5 credits per call): the
  // balanceAuth middleware takes 1 credit upstream, probeController debits
  // the remaining 4 atomically. Gated on Aperture like the other paid routes.
  // Phase 9 C8 — two rate limiters in front of balanceAuth so rejections
  // never consume credits. See src/middleware/probeRateLimit.ts for ordering
  // rationale.
  const probeLimits = createProbeRateLimit({
    perTokenPerHour: config.PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR,
    globalPerHour: config.PROBE_RATE_LIMIT_GLOBAL_PER_HOUR,
  });
  api.post('/probe', apertureGateAuth, probeLimits.perToken, probeLimits.global, balanceAuth, probeController.probe);
  api.use(createPingRoutes(pingController));                           // ping/:pubkey (free, own rate limit)
  api.use(createAgentRoutes(agentController, balanceAuth));            // agent/:hash, verdict, top, search, movers
  api.use(createAttestationRoutes(attestationController, balanceAuth));// attestations (GET paid, POST free)
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
  // Phase 5 — /api/intent structuré (neutral discovery, same rate class as /services)
  api.post('/intent', discoveryRateLimit, intentController.resolve);
  api.get('/intent/categories', discoveryRateLimit, intentController.categories);
  api.post('/services/register', discoveryRateLimit, serviceRegisterController.register);
  // Phase 7 — operator registration (NIP-98 gated, rate-limited avec discovery
  // car endpoint à effort de preuve côté claimant — pas de quota L402).
  api.post('/operator/register', discoveryRateLimit, operatorController.register);
  api.get('/operators', discoveryRateLimit, operatorController.list);
  api.get('/operator/:id', discoveryRateLimit, operatorController.show);
  api.get('/endpoint/:url_hash', discoveryRateLimit, endpointController.show);
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

  // Refresh every (limit × sort_by) combo the health check monitors as critical.
  // The list lives in statsService so a key cannot be declared critical without
  // being warmed — warm-up and CRITICAL_CACHE_KEYS share a single source of truth.
  for (const limit of TOP_WARMUP_LIMITS) {
    for (const sortBy of TOP_SORT_AXES) {
      try {
        const response = agentController.buildTopResponse(limit, 0, sortBy);
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
