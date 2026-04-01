// Attestation routes — retrieval and submission
import { Router } from 'express';
import type { AttestationController } from '../controllers/attestationController';
import { apiKeyAuth } from '../middleware/auth';

export function createAttestationRoutes(controller: AttestationController): Router {
  const router = Router();

  router.get('/agent/:publicKeyHash/attestations', controller.getBySubject);
  router.post('/attestation', apiKeyAuth, controller.create);

  return router;
}
