// Agent endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { AgentService } from '../services/agentService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import { publicKeyHashSchema, paginationSchema, topQuerySchema, searchQuerySchema } from '../middleware/validation';
import { ValidationError } from '../errors';
import { logger } from '../logger';

function safeParseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    logger.warn({ value: value.slice(0, 100) }, 'JSON.parse failed, using fallback');
    return fallback;
  }
}

export class AgentController {
  constructor(
    private agentService: AgentService,
    private agentRepo: AgentRepository,
    private snapshotRepo: SnapshotRepository,
  ) {}

  getAgent = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = publicKeyHashSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const result = this.agentService.getAgentScore(parsed.data);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  getHistory = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const hashParsed = publicKeyHashSchema.safeParse(req.params.publicKeyHash);
      if (!hashParsed.success) throw new ValidationError(hashParsed.error.errors[0].message);

      const paginationParsed = paginationSchema.safeParse(req.query);
      if (!paginationParsed.success) throw new ValidationError(paginationParsed.error.errors[0].message);

      const { limit, offset } = paginationParsed.data;
      const snapshots = this.snapshotRepo.findHistoryByAgent(hashParsed.data, limit, offset);
      const total = this.snapshotRepo.countByAgent(hashParsed.data);

      res.json({
        data: snapshots.map(s => ({
          score: s.score,
          components: safeParseJson(s.components, {}),
          computedAt: s.computed_at,
        })),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };

  getTop = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const topParsed = topQuerySchema.safeParse(req.query);
      if (!topParsed.success) throw new ValidationError(topParsed.error.errors[0].message);
      const { limit, offset } = topParsed.data;
      const agents = this.agentService.getTopAgents(limit, offset);
      const total = this.agentRepo.count();

      res.json({
        data: agents.map(a => ({
          publicKeyHash: a.public_key_hash,
          alias: a.alias,
          score: a.avg_score,
          totalTransactions: a.total_transactions,
          source: a.source,
        })),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };

  search = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const searchParsed = searchQuerySchema.safeParse(req.query);
      if (!searchParsed.success) throw new ValidationError(searchParsed.error.errors[0].message);
      const { alias, limit, offset } = searchParsed.data;
      const agents = this.agentService.searchByAlias(alias, limit, offset);
      const total = this.agentRepo.countByAlias(alias);

      res.json({
        data: agents.map(a => ({
          publicKeyHash: a.public_key_hash,
          alias: a.alias,
          score: a.avg_score,
          source: a.source,
        })),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };
}
