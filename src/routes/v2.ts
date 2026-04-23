// Decision routes — report, deposit, profile.
// /decide and /best-route have been removed in Phase 10 (2026-04-20) — see
// `createGoneHandler` below. Use /api/intent instead.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { V2Controller } from '../controllers/v2Controller';
import type { DepositController } from '../controllers/depositController';
import { apiKeyAuth, apertureGateAuth, createReportDispatchAuth } from '../middleware/auth';
import { rateLimitHits } from '../middleware/metrics';
import { createGoneHandler } from '../controllers/legacyGoneController';

// Phase 2 : bump à 20/min/IP. L'ancien 5/min/IP était trop conservatif pour
// cohabiter avec le chemin anonyme (voie 3) sans gêner les clients légitimes.
// Le rate limit par reporter (20/min) de ReportService reste actif pour le
// chemin authentifié ; la garantie one-shot des anonymes vient de consumed_at.
const reportRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
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
  paidGate: RequestHandler = apertureGateAuth,
): Router {
  const router = Router();

  // Phase 10 — /api/decide and /api/best-route retired (410 Gone). See
  // docs/MIGRATION-TO-1.0.md.
  router.post('/decide', createGoneHandler({
    from: '/api/decide',
    to: '/api/intent',
    removedOn: '2026-04-20',
    docs: 'https://satrank.dev/docs/migration-to-1.0',
  }));
  router.post('/best-route', createGoneHandler({
    from: '/api/best-route',
    to: '/api/intent',
    removedOn: '2026-04-20',
    docs: 'https://satrank.dev/docs/migration-to-1.0',
  }));
  // Phase 2 : dispatch anonyme (X-L402-Preimage ou body.preimage sans reporter)
  // bypass reportAuth ; chemin legacy délègue au middleware fourni.
  router.post('/report', reportRateLimit, createReportDispatchAuth(reportAuth), controller.report);
  router.get('/profile/:id', paidGate, balanceAuth, controller.profile);

  // Deposit: variable-amount L402 token purchase (bypasses Aperture, free endpoint)
  if (depositController) {
    // GET /deposit/tiers — public, no rate limit needed (read-only, cheap SELECT).
    // Register before POST so Express can match the more specific path first.
    router.get('/deposit/tiers', depositController.listTiers);
    router.post('/deposit', depositRateLimit, depositController.deposit);
  }

  return router;
}
