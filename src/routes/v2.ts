// Decision routes — decide, report, deposit, profile
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { V2Controller } from '../controllers/v2Controller';
import type { DepositController } from '../controllers/depositController';
import { apiKeyAuth, apertureGateAuth } from '../middleware/auth';
import { rateLimitHits } from '../middleware/metrics';

const reportRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many reports, please try again later' } },
  handler: (req, res, _next, options) => {
    rateLimitHits.inc({ limiter: 'report' });
    res.status(options.statusCode).json(options.message);
  },
});

// Deposit: 3 invoices per IP per minute (prevents invoice spam)
const depositRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? '0.0.0.0',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many deposit requests, please try again later' } },
  handler: (req, res, _next, options) => {
    rateLimitHits.inc({ limiter: 'deposit' });
    res.status(options.statusCode).json(options.message);
  },
});

const noopMiddleware: RequestHandler = (_req, _res, next) => next();

export function createV2Routes(
  controller: V2Controller,
  balanceAuth: RequestHandler = noopMiddleware,
  reportAuth: RequestHandler = apiKeyAuth,
  depositController?: DepositController,
): Router {
  const router = Router();

  router.post('/decide', apertureGateAuth, balanceAuth, controller.decide);
  router.post('/best-route', apertureGateAuth, balanceAuth, controller.bestRoute);
  router.post('/report', reportRateLimit, reportAuth, controller.report);
  router.get('/profile/:id', apertureGateAuth, balanceAuth, controller.profile);

  // Deposit: variable-amount L402 token purchase (bypasses Aperture, free endpoint)
  if (depositController) {
    router.post('/deposit', depositRateLimit, depositController.deposit);
  }

  return router;
}
