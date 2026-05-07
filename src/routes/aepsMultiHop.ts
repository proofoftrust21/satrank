// AEPS §6.3 — multi-hop HTLC chain routes.
import { Router } from 'express';
import type { AepsMultiHopController } from '../controllers/aepsMultiHopController';

export function createAepsMultiHopRoutes(controller: AepsMultiHopController): Router {
  const router = Router();

  router.post('/multihop/plan', controller.plan);
  router.post('/multihop/:chain_id/lock', controller.lock);
  router.post('/multihop/:chain_id/reveal', controller.reveal);
  router.post('/multihop/:chain_id/settle', controller.settle);
  router.post('/multihop/:chain_id/abort', controller.abort);
  router.get('/multihop/:chain_id', controller.get);

  return router;
}
