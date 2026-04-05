// Decision routes — decide, report, profile
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { V2Controller } from '../controllers/v2Controller';
import { apiKeyAuth, apertureGateAuth } from '../middleware/auth';

// M1: IP rate limiter — requires 'trust proxy' on Express app if behind a reverse proxy,
// otherwise req.ip is the proxy's IP and all clients share the same bucket.
const reportRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many reports, please try again later' } },
});

export function createV2Routes(controller: V2Controller): Router {
  const router = Router();

  router.post('/decide', apertureGateAuth, controller.decide);
  router.post('/report', reportRateLimit, apiKeyAuth, controller.report);
  router.get('/profile/:id', apertureGateAuth, controller.profile);

  return router;
}
