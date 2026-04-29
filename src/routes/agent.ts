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

  // Excellence pass — align actual rate-limit with the public claim. The
  // landing page says these reads share the 10/min/IP discovery limit; the
  // SQL behind them (joins agents + score_snapshots + scoring) is also
  // expensive, so 10/min is a sensible bound regardless.
  router.get('/agents/top', discoveryRateLimit, controller.getTop);
  router.get('/agents/movers', discoveryRateLimit, controller.getMovers);
  router.get('/agents/search', discoveryRateLimit, controller.search);

  router.post('/verdicts', paidGate, balanceAuth, controller.batchVerdicts);
  router.get('/agent/:publicKeyHash/verdict', discoveryRateLimit, controller.getVerdict);
  router.get('/agent/:publicKeyHash', discoveryRateLimit, controller.getAgent);
  router.get('/agent/:publicKeyHash/history', discoveryRateLimit, controller.getHistory);

  return router;
}
