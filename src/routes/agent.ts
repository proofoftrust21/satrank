// Agent routes — score, history, leaderboard, search
import { Router } from 'express';
import type { AgentController } from '../controllers/agentController';

export function createAgentRoutes(controller: AgentController): Router {
  const router = Router();

  router.get('/agents/top', controller.getTop);
  router.get('/agents/search', controller.search);
  router.get('/agent/:publicKeyHash', controller.getAgent);
  router.get('/agent/:publicKeyHash/history', controller.getHistory);

  return router;
}
