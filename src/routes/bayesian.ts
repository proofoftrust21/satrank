// Routes bayésiennes — C9. Expose le nouveau shape canonique Phase 3.

import { Router } from 'express';
import type { BayesianController } from '../controllers/bayesianController';

export function createBayesianRoutes(controller: BayesianController): Router {
  const router = Router();
  router.get('/bayesian/:target', controller.getVerdict);
  return router;
}
