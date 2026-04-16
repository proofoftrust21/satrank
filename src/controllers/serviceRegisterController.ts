// Self-registration endpoint for L402 service operators
// Free endpoint — operator submits their URL, SatRank validates it's a real
// L402 endpoint by fetching it (must return 402 with valid BOLT11 invoice).
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { RegistryCrawler } from '../crawler/registryCrawler';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';

const registerSchema = z.object({
  url: z.string().url().max(500),
  name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
  provider: z.string().max(100).optional(),
});

export class ServiceRegisterController {
  constructor(private registryCrawler: RegistryCrawler | null) {}

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.registryCrawler) {
        res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Self-registration unavailable — LND BOLT11 decoder not configured' } });
        return;
      }

      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const { url, name, description, category, provider } = parsed.data;

      const result = await this.registryCrawler.registerSelfSubmitted(url, { name, description, category, provider });

      if (!result) {
        res.status(400).json({
          error: {
            code: 'NOT_L402',
            message: 'URL is not a valid L402 endpoint. Expected GET to return 402 with WWW-Authenticate header containing a BOLT11 invoice.',
          },
        });
        return;
      }

      res.status(201).json({
        data: {
          url,
          registered: true,
          agentHash: result.agentHash,
          priceSats: result.priceSats,
          message: 'Service registered. Health checks will run periodically. Visible at GET /api/services within 30 minutes.',
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
