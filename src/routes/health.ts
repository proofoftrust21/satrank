// Health and stats routes
import { Router } from 'express';
import type { HealthController } from '../controllers/healthController';

export function createHealthRoutes(controller: HealthController): Router {
  const router = Router();

  router.get('/health', controller.getHealth);
  router.get('/version', controller.getVersion);
  router.get('/stats', controller.getStats);

  return router;
}
