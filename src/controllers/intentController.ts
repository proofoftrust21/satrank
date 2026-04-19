// Phase 5 — /api/intent + /api/intent/categories.
//
// Endpoint discovery structuré : l'agent passe category (enum exact),
// keywords (AND, LIKE NOCASE), budget_sats, max_latency_ms. Le serveur
// répond par des candidats rankés bayésien-native + overlay advisory.
//
// Convention snake_case amorce la convention cible (cf. types/intent.ts).
// Les endpoints legacy (/decide, /best-route) restent camelCase en Phase 5,
// avec un header Deprecation: true pointant ici.

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../logger';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';
import { isValidCategoryFormat, normalizeCategory } from '../utils/categoryValidation';
import type { IntentService } from '../services/intentService';
import { INTENT_LIMIT_MAX } from '../services/intentService';

// Validation — on normalise puis on vérifie le format. L'existence de la
// catégorie dans le pool trusted est vérifiée par le service après parse
// (renvoie 400 INVALID_CATEGORY si inconnue).
const intentSchema = z.object({
  category: z
    .string()
    .min(1)
    .max(50)
    .transform(v => normalizeCategory(v) ?? v)
    .refine(isValidCategoryFormat, {
      message: 'category must match /^[a-z][a-z0-9/_-]{1,31}$/',
    }),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  budget_sats: z.number().int().min(0).max(1_000_000).optional(),
  max_latency_ms: z.number().int().min(0).max(60_000).optional(),
  caller: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(INTENT_LIMIT_MAX).optional(),
});

export class IntentController {
  constructor(private readonly intentService: IntentService) {}

  resolve = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = intentSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const { category, keywords, budget_sats, max_latency_ms, caller, limit } = parsed.data;

      // Enum dynamique : la catégorie doit exister dans le pool trusted.
      // Le format regex est déjà validé par zod ; ici on refuse les valeurs
      // qui matchent le format mais n'ont aucun endpoint indexé.
      const known = this.intentService.knownCategoryNames();
      if (!known.has(category)) {
        res.status(400).json({
          error: {
            code: 'INVALID_CATEGORY',
            message: `Unknown category "${category}". Call GET /api/intent/categories for the current list.`,
          },
        });
        return;
      }

      const response = this.intentService.resolveIntent(
        { category, keywords, budget_sats, max_latency_ms, caller },
        limit,
      );

      logger.info(
        {
          route: 'POST /api/intent',
          caller: caller ?? null,
          category,
          keywords_count: keywords?.length ?? 0,
          budget_sats: budget_sats ?? null,
          max_latency_ms: max_latency_ms ?? null,
          total_matched: response.meta.total_matched,
          returned: response.meta.returned,
          strictness: response.meta.strictness,
          warnings: response.meta.warnings,
        },
        'intent resolved',
      );

      res.json(response);
    } catch (err) {
      next(err);
    }
  };

  categories = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const response = this.intentService.listCategories();
      res.json(response);
    } catch (err) {
      next(err);
    }
  };
}
