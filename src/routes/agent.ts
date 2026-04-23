// Agent routes — score, history, leaderboard, search
import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { AgentController } from '../controllers/agentController';
import { apertureGateAuth } from '../middleware/auth';

const noopMiddleware: RequestHandler = (_req, _res, next) => next();

export function createAgentRoutes(
  controller: AgentController,
  balanceAuth: RequestHandler = noopMiddleware,
  paidGate: RequestHandler = apertureGateAuth,
): Router {
  const router = Router();

  router.get('/agents/top', controller.getTop);
  router.get('/agents/movers', controller.getMovers);
  router.get('/agents/search', controller.search);

  router.post('/verdicts', paidGate, balanceAuth, controller.batchVerdicts);
  router.get('/agent/:publicKeyHash/verdict', paidGate, balanceAuth, controller.getVerdict);
  router.get('/agent/:publicKeyHash', paidGate, balanceAuth, controller.getAgent);
  router.get('/agent/:publicKeyHash/history', paidGate, balanceAuth, controller.getHistory);

  return router;
}
