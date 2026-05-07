// Phase 12.14 — HTTP surface for the SatRank mini-AI gateway.
//
// L402 gating happens upstream (createL402Native + pricingMap). The
// controller assumes payment was either verified by the gate or the
// request carries the OPERATOR_BYPASS_SECRET header. Each route maps
// 1:1 to a MiniLlmService task.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendError } from '../errors/errorEnvelope';
import type { MiniLlmService, MiniLlmTask } from '../services/miniLlmService';
import { logger } from '../logger';

const baseSchema = z.object({
  text: z.string().min(1).max(8_000),
  options: z.record(z.unknown()).optional(),
});

export interface MiniLlmControllerDeps {
  service: MiniLlmService;
}

export class MiniLlmController {
  constructor(private readonly deps: MiniLlmControllerDeps) {}

  private async run(req: Request, res: Response, task: MiniLlmTask): Promise<void> {
    const parsed = baseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
      return;
    }
    try {
      const result = await this.deps.service.run({
        task,
        text: parsed.data.text,
        options: parsed.data.options,
      });
      res.status(200).json({ data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ task, error: msg }, 'mini-llm: upstream error');
      sendError(res, 'internal_error', { message: 'mini-AI upstream error' });
    }
  }

  classify = (req: Request, res: Response, _next: NextFunction): Promise<void> =>
    this.run(req, res, 'classify');
  summarize = (req: Request, res: Response, _next: NextFunction): Promise<void> =>
    this.run(req, res, 'summarize');
  translate = (req: Request, res: Response, _next: NextFunction): Promise<void> =>
    this.run(req, res, 'translate');
}
