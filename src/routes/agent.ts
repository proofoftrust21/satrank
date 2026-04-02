// Agent routes — score, history, leaderboard, search
import { Router } from 'express';
import type { AgentController } from '../controllers/agentController';
import { apertureGateAuth } from '../middleware/auth';

export function createAgentRoutes(controller: AgentController): Router {
  const router = Router();

  router.get('/agents/top', controller.getTop);
  router.get('/agents/movers', controller.getMovers);
  router.get('/agents/search', controller.search);
  router.post('/verdicts', apertureGateAuth, controller.batchVerdicts);
  router.get('/agent/:publicKeyHash/verdict', apertureGateAuth, controller.getVerdict);
  router.get('/agent/:publicKeyHash', apertureGateAuth, controller.getAgent);
  router.get('/agent/:publicKeyHash/history', apertureGateAuth, controller.getHistory);

  return router;
}
