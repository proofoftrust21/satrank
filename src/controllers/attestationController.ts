// Attestation endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { AttestationService } from '../services/attestationService';
import { publicKeyHashSchema, paginationSchema, createAttestationSchema } from '../middleware/validation';
import { ValidationError } from '../errors';
import { logger } from '../logger';

function safeParseJsonTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    logger.warn({ value: value.slice(0, 100) }, 'JSON.parse tags failed');
    return [];
  }
}

export class AttestationController {
  constructor(private attestationService: AttestationService) {}

  getBySubject = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const hashParsed = publicKeyHashSchema.safeParse(req.params.publicKeyHash);
      if (!hashParsed.success) throw new ValidationError(hashParsed.error.errors[0].message);

      const paginationParsed = paginationSchema.safeParse(req.query);
      if (!paginationParsed.success) throw new ValidationError(paginationParsed.error.errors[0].message);
      const { limit, offset } = paginationParsed.data;
      const { attestations, total } = this.attestationService.getBySubject(
        hashParsed.data, limit, offset,
      );

      res.json({
        data: attestations.map(a => ({
          attestationId: a.attestation_id,
          txId: a.tx_id,
          attesterHash: a.attester_hash,
          score: a.score,
          tags: a.tags ? safeParseJsonTags(a.tags) : [],
          evidenceHash: a.evidence_hash,
          timestamp: a.timestamp,
          category: a.category,
        })),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };

  create = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = createAttestationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors.map(e => e.message).join(', '));
      }

      const attestation = this.attestationService.create(parsed.data);
      res.status(201).json({
        data: {
          attestationId: attestation.attestation_id,
          timestamp: attestation.timestamp,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
