// Agent routes — score, history, leaderboard, search
//
// Pricing Mix A+D (2026-04-26): /agent/:publicKeyHash GET routes are public
// directory reads — moved off paidGate. Only POST /verdicts (batch) stays
// paid because it amortises one round-trip into up to 100 lookups, which is
// a power-user pattern worth a small per-request fee.
import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { AgentController } from '../controllers/agentController';

const noopMiddleware: RequestHandler = (_req, _res, next) => next();

export function createAgentRoutes(
  controller: AgentController,
  balanceAuth: RequestHandler = noopMiddleware,
  paidGate: RequestHandler = noopMiddleware,
  discoveryRateLimit: RequestHandler = noopMiddleware,
): Router {
  const router = Router();

  router.get('/agents/top', controller.getTop);
  router.get('/agents/movers', controller.getMovers);
  router.get('/agents/search', controller.search);

  router.post('/verdicts', paidGate, balanceAuth, controller.batchVerdicts);
  router.get('/agent/:publicKeyHash/verdict', discoveryRateLimit, controller.getVerdict);
  router.get('/agent/:publicKeyHash', discoveryRateLimit, controller.getAgent);
  router.get('/agent/:publicKeyHash/history', discoveryRateLimit, controller.getHistory);

  return router;
}
