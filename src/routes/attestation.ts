// Attestation routes — retrieval and submission
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { AttestationController } from '../controllers/attestationController';
import { apiKeyAuth } from '../middleware/auth';
import { rateLimitHits } from '../middleware/metrics';

// Stricter rate limit for write operations (10 req/min per IP)
const writeRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many write requests, please try again later' } },
  handler: (req, res, _next, options) => {
    rateLimitHits.inc({ limiter: 'attestation' });
    res.status(options.statusCode).json(options.message);
  },
});

const noopMiddleware: RequestHandler = (_req, _res, next) => next();

// Pricing Mix A+D (2026-04-26): GET attestations is now free directory data —
// reading public attestation history is a discovery operation. POST stays
// behind apiKeyAuth (issuer write path).
export function createAttestationRoutes(
  controller: AttestationController,
  _balanceAuth: RequestHandler = noopMiddleware,
  _paidGate: RequestHandler = noopMiddleware,
  discoveryRateLimit: RequestHandler = noopMiddleware,
): Router {
  const router = Router();

  router.get('/agent/:publicKeyHash/attestations', discoveryRateLimit, controller.getBySubject);
  router.post('/attestations', writeRateLimit, apiKeyAuth, controller.create);

  return router;
}
