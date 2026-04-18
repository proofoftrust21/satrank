// Contrôleur pour le shape bayésien canonique — C9.
//
// Un seul endpoint public pour le moment : GET /api/bayesian/:target
// Retourne la BayesianVerdictResponse complète (voir bayesianVerdictService.ts).

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { BayesianVerdictService } from '../services/bayesianVerdictService';
import { ValidationError } from '../errors';

const targetSchema = z.string().min(3).max(128);

const querySchema = z.object({
  service_hash: z.string().max(128).optional(),
  operator_id: z.string().max(128).optional(),
  reporter_tier: z.enum(['low', 'medium', 'high', 'nip98']).optional(),
});

function toValidationError(err: unknown): Error {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    const path = issue?.path?.join('.') ?? 'input';
    return new ValidationError(`Invalid ${path}: ${issue?.message ?? 'validation failed'}`);
  }
  return err as Error;
}

export class BayesianController {
  constructor(private bayesianVerdictService: BayesianVerdictService) {}

  getVerdict = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const target = targetSchema.parse(req.params.target);
      const q = querySchema.parse(req.query);
      const response = this.bayesianVerdictService.buildVerdict({
        targetHash: target,
        serviceHash: q.service_hash ?? null,
        operatorId: q.operator_id ?? null,
        reporterTier: q.reporter_tier,
      });
      res.json(response);
    } catch (err) {
      next(toValidationError(err));
    }
  };
}
