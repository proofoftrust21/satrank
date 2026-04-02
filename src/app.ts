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

// Repositories
import { AgentRepository } from './repositories/agentRepository';
import { TransactionRepository } from './repositories/transactionRepository';
import { AttestationRepository } from './repositories/attestationRepository';
import { SnapshotRepository } from './repositories/snapshotRepository';

// Services
import { ScoringService } from './services/scoringService';
import { AgentService } from './services/agentService';
import { AttestationService } from './services/attestationService';
import { StatsService } from './services/statsService';

// Controllers
import { AgentController } from './controllers/agentController';
import { AttestationController } from './controllers/attestationController';
import { HealthController } from './controllers/healthController';

// Routes
import { createAgentRoutes } from './routes/agent';
import { createAttestationRoutes } from './routes/attestation';
import { createHealthRoutes } from './routes/health';

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

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
  const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);

  const agentController = new AgentController(agentService, agentRepo, snapshotRepo);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);

  // Trust first proxy hop (nginx/caddy) so rate limiter sees real client IPs
  app.set('trust proxy', 1);

  // Global middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:"],
      },
    },
  }));
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: '10kb' }));
  app.use(requestIdMiddleware);
  app.use(requestTimeout(30_000));
  app.use(rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
  }));

  // Static landing page
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: path.join(__dirname, '..', 'public') }));

  // API v1 routes
  const v1 = Router();
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
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>`);
  });
  app.use('/api/v1', v1);

  // Error handler (must be the last middleware)
  app.use(errorHandler);

  return app;
}
