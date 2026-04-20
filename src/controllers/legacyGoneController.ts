// Phase 10 — handler 410 Gone pour les endpoints legacy supprimés.
//
// Signature RFC 7231 §6.5.9 : 410 Gone indique une ressource retirée
// intentionnellement, sans redirection possible. Le body JSON porte
// l'URL successeur pour que l'agent corrige son intégration.
//
// Chaque appel incrémente `satrank_legacy_endpoint_calls_total{endpoint=...}`
// pour tracker combien de consommateurs restent coincés sur une ancienne URL.

import type { Request, Response } from 'express';
import { logger } from '../logger';
import { legacyEndpointCallsTotal } from '../middleware/metrics';

export interface LegacyEndpointSpec {
  /** Legacy path that was removed, e.g. `/api/decide`. */
  from: string;
  /** Successor path the caller should use, e.g. `/api/intent`. */
  to: string;
  /** ISO date (YYYY-MM-DD) at which the endpoint was removed. */
  removedOn: string;
  /** Public migration guide URL, returned in the body for operator diagnosis. */
  docs: string;
}

export function createGoneHandler(spec: LegacyEndpointSpec) {
  return function gone(req: Request, res: Response): void {
    legacyEndpointCallsTotal.inc({ endpoint: spec.from });
    logger.info(
      {
        route: spec.from,
        successor: spec.to,
        removed_on: spec.removedOn,
        ip: req.ip ?? null,
        user_agent: req.headers['user-agent'] ?? null,
        request_id: (req as Request & { requestId?: string }).requestId ?? null,
      },
      'legacy endpoint called',
    );
    res.status(410).json({
      error: {
        code: 'ENDPOINT_REMOVED',
        message: `This endpoint was removed on ${spec.removedOn}. Use ${spec.to} instead.`,
        migration: {
          from: spec.from,
          to: spec.to,
          see: spec.docs,
        },
      },
    });
  };
}
