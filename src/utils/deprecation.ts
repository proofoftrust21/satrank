// Phase 5 — helper pour signaler la déprécation d'un endpoint.
//
// Deux effets de bord sur la Response :
//   - Header `Deprecation: true` (RFC 8594 draft, largement reconnu par les
//     clients HTTP / SDK modernes).
//   - Header `Link: <successor>; rel="successor-version"` pointant vers
//     l'endpoint remplaçant (RFC 5988).
// Et un patch de body : ajoute `meta.deprecated_use: "<successor>"` pour les
// clients qui inspectent le JSON plutôt que les headers (courant côté SDK
// agent où les headers sont parfois mangés par les proxies).
//
// Usage :
//   markDeprecated(res, '/api/intent');
//   res.json(patchDeprecatedBody(body, '/api/intent'));
//
// La séparation header/body permet de ne pas muter la structure quand le body
// n'est pas un objet JSON attendu (erreur 4xx/5xx renvoyée ailleurs).

import type { Response } from 'express';
import { logger } from '../logger';

export function markDeprecated(res: Response, successor: string): void {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', `<${successor}>; rel="successor-version"`);
}

/** Injecte `meta.deprecated_use` dans un body JSON-like. Préserve toute
 *  `meta` existante ; n'écrase rien. Retourne le body tel quel si déjà
 *  marqué. */
export function patchDeprecatedBody<T extends Record<string, unknown>>(
  body: T,
  successor: string,
): T {
  const existingMeta = (body.meta && typeof body.meta === 'object' ? body.meta : {}) as Record<string, unknown>;
  return {
    ...body,
    meta: {
      ...existingMeta,
      deprecated_use: successor,
    },
  };
}

/** Log structuré d'un appel vers un endpoint déprécié. Sample-safe (warn). */
export function logDeprecatedCall(
  route: string,
  successor: string,
  context: Record<string, unknown> = {},
): void {
  logger.warn({ route, successor, deprecated: true, ...context }, 'deprecated endpoint called');
}
