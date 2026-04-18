// Agent routes — score, history, leaderboard, search
import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { AgentController } from '../controllers/agentController';
import { apertureGateAuth } from '../middleware/auth';

const noopMiddleware: RequestHandler = (_req, _res, next) => next();

export function createAgentRoutes(controller: AgentController, balanceAuth: RequestHandler = noopMiddleware): Router {
  const router = Router();

  router.get('/agents/top', controller.getTop);
  router.get('/agents/movers', controller.getMovers);
  router.get('/agents/search', controller.search);

  // /api/top → /api/agents/top (301). Some early docs referenced /api/top
  // without the `/agents` segment; the redirect removes the ambiguity rather
  // than returning a bare Express 404 HTML page.
  router.get('/top', (req, res) => {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, `/api/agents/top${qs}`);
  });
  router.post('/verdicts', apertureGateAuth, balanceAuth, controller.batchVerdicts);
  router.get('/agent/:publicKeyHash/verdict', apertureGateAuth, balanceAuth, controller.getVerdict);
  router.get('/agent/:publicKeyHash', apertureGateAuth, balanceAuth, controller.getAgent);
  router.get('/agent/:publicKeyHash/history', apertureGateAuth, balanceAuth, controller.getHistory);

  return router;
}
