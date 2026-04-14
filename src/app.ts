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
import { metricsMiddleware, metricsRegistry, agentsTotal, channelsTotal } from './middleware/metrics';

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
import { createBalanceAuth } from './middleware/balanceAuth';
import { createReportAuth } from './middleware/auth';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';

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
import { set as cacheSet, getStale as cacheGetStale } from './cache/memoryCache';

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
  const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService, probeRepo);
  const riskService = new RiskService();

  // LND graph client — shared between auto-indexation, pathfinding, and verdict
  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });

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

  const serviceEndpointRepo = new ServiceEndpointRepository(db);
  const decideService = new DecideService({
    agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService,
    probeRepo, lndClient: lndClient.isConfigured() ? lndClient : undefined, survivalService,
    serviceEndpointRepo,
  });
  const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db);

  const agentController = new AgentController(agentService, agentRepo, snapshotRepo, trendService, verdictService, autoIndexService);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(decideService, reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService, verdictService, serviceEndpointRepo, db);
  const pingController = new PingController(lndClient.isConfigured() ? lndClient : undefined, agentRepo, probeRepo);

  // Cache warm-up — fills the stats and leaderboard caches before the first
  // request lands, so the cold-start SQL rebuild (~1-2s on /api/stats) never
  // hits a real user. Failures are logged but non-fatal: the endpoints will
  // rebuild on demand if the warm-up SQL fails for any reason.
  warmUpCaches(statsService, agentController);

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
      },
    },
  }));
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: '10kb' }));

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

  // Prometheus metrics endpoint — restricted to localhost/internal
  app.get('/metrics', (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      next();
    } else {
      res.status(403).end('Forbidden');
    }
  }, async (_req, res) => {
    try {
      const stats = statsService.getNetworkStats();
      agentsTotal.set(stats.totalAgents);
      channelsTotal.set(stats.totalChannels);

      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch {
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
  api.use(createV2Routes(v2Controller, balanceAuth, reportAuth));      // decide, report, profile
  api.use(createPingRoutes(pingController));                           // ping/:pubkey (free, own rate limit)
  api.use(createAgentRoutes(agentController, balanceAuth));            // agent/:hash, verdict, top, search, movers
  api.use(createAttestationRoutes(attestationController, balanceAuth));// attestations (GET paid, POST free)
  api.use(createHealthRoutes(healthController));          // health, stats, version
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
function warmUpCaches(statsService: StatsService, agentController: AgentController): void {
  const start = Date.now();
  try {
    statsService.getNetworkStats();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: getNetworkStats failed');
  }

  // Prime the leaderboard key the landing page actually hits. The controller's
  // getOrCompute wrapper re-uses this exact cache key, so a single synchronous
  // build here is enough to cover the homepage first load. 5-min TTL matches the
  // stats cache and the TOP_CACHE_TTL_MS constant in agentController.
  try {
    const response = agentController.buildTopResponse(10, 0, 'score');
    cacheSet('agents:top:10:0:score', response, 5 * 60_000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: buildTopResponse failed');
  }

  logger.info({ durationMs: Date.now() - start }, 'Cache warm-up complete');
}
