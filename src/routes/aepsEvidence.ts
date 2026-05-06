// AEPS §8 — Evidence anchor + inclusion-proof routes.
import { Router } from 'express';
import type { AepsEvidenceController } from '../controllers/aepsEvidenceController';

export function createAepsEvidenceRoutes(controller: AepsEvidenceController): Router {
  const router = Router();

  router.get('/anchor/recent', controller.listRecent);
  router.get('/anchor/:day_utc', controller.getAnchor);
  router.get('/proof/:receipt_id', controller.getProof);

  return router;
}
