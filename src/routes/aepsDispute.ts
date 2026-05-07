// AEPS §10 — dispute routes.
import { Router } from 'express';
import type { AepsDisputeController } from '../controllers/aepsDisputeController';

export function createAepsDisputeRoutes(controller: AepsDisputeController): Router {
  const router = Router();

  router.post('/dispute', controller.open);
  router.post('/dispute/:dispute_id/attestation', controller.attest);
  router.get('/dispute/:dispute_id', controller.get);

  return router;
}
