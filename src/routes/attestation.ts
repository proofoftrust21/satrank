// Attestation routes — retrieval and submission
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AttestationController } from '../controllers/attestationController';
import { apiKeyAuth, apertureGateAuth } from '../middleware/auth';

// Stricter rate limit for write operations (10 req/min per IP)
const writeRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many write requests, please try again later' } },
});

export function createAttestationRoutes(controller: AttestationController): Router {
  const router = Router();

  router.get('/agent/:publicKeyHash/attestations', apertureGateAuth, controller.getBySubject);
  router.post('/attestations', writeRateLimit, apiKeyAuth, controller.create);
  // Temporary alias — remove after SDK clients migrate
  router.post('/attestation', writeRateLimit, apiKeyAuth, controller.create);

  return router;
}
