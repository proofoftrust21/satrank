// Ping route — real-time reachability check (free, rate-limited)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { PingController } from '../controllers/pingController';
import { rateLimitHits } from '../middleware/metrics';

const pingRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many ping requests, please try again later' } },
  handler: (req, res, _next, options) => {
    rateLimitHits.inc({ limiter: 'ping' });
    res.status(options.statusCode).json(options.message);
  },
});

export function createPingRoutes(controller: PingController): Router {
  const router = Router();
  router.get('/ping/:pubkey', pingRateLimit, controller.ping);
  return router;
}
