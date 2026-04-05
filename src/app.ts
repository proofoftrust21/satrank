// Express application setup — dependency injection
import express, { Router } from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
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

// Routes
import { createAgentRoutes } from './routes/agent';
import { createAttestationRoutes } from './routes/attestation';
import { createHealthRoutes } from './routes/health';
import { createV2Routes } from './routes/v2';

// OpenAPI spec
import { openapiSpec } from './openapi';

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

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
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
  const channelSnapshotRepo = new ChannelSnapshotRepository(db);
  const feeSnapshotRepo = new FeeSnapshotRepository(db);

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

  const decideService = new DecideService(agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService, probeRepo, lndClient.isConfigured() ? lndClient : undefined, survivalService);
  const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db);

  const agentController = new AgentController(agentService, agentRepo, snapshotRepo, trendService, verdictService, autoIndexService);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(decideService, reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService);

  // Trust first proxy hop (nginx/caddy) so rate limiter sees real client IPs
  app.set('trust proxy', 1);

  // Global middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
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

  // Static landing page
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: path.join(__dirname, '..', 'public') }));

  // Prometheus metrics endpoint — before rate limiter, not L402 gated
  app.get('/metrics', async (_req, res) => {
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

  // API v1 routes
  const v1 = Router();
  v1.use(apiRateLimit);
  v1.use(createAgentRoutes(agentController));
  v1.use(createAttestationRoutes(attestationController));
  v1.use(createHealthRoutes(healthController));
  v1.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  v1.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SatRank API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <link rel="stylesheet" href="/swagger-custom.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="/swagger-init.js"></script>
</body>
</html>`);
  });
  app.use('/api/v1', v1);

  // API v2 routes
  const v2 = Router();
  v2.use(apiRateLimit);
  v2.use(createV2Routes(v2Controller));
  app.use('/api/v2', v2);

  // Version-free routes — clean namespace for agents (/api/decide, /api/agent/:hash, etc.)
  // Maps to the same handlers as v1/v2. Versioned routes remain for backwards compatibility.
  const unified = Router();
  unified.use(apiRateLimit);
  unified.use(createV2Routes(v2Controller));                  // decide, report, profile
  unified.use(createAgentRoutes(agentController));            // agent/:hash, verdict, top, search, movers
  unified.use(createAttestationRoutes(attestationController));// attestations
  unified.use(createHealthRoutes(healthController));          // health, stats, version
  unified.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  unified.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SatRank API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <link rel="stylesheet" href="/swagger-custom.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="/swagger-init.js"></script>
</body>
</html>`);
  });
  app.use('/api', unified);

  // Error handler (must be the last middleware)
  app.use(errorHandler);

  return app;
}
