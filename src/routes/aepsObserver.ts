// AEPS §8.5 — observer routes.
import { Router } from 'express';
import type { AepsObserverController } from '../controllers/aepsObserverController';

export function createAepsObserverRoutes(controller: AepsObserverController): Router {
  const router = Router();

  router.post('/observation', controller.submitObservation);
  router.get('/forks', controller.listForks);
  router.get('/observations/:operator_pubkey/:day_utc', controller.listObservations);

  return router;
}
