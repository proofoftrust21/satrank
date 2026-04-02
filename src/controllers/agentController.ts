// Agent endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { AgentService } from '../services/agentService';
import type { VerdictService } from '../services/verdictService';
import type { AutoIndexService } from '../services/autoIndexService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { TrendService } from '../services/trendService';
import { publicKeyHashSchema, agentIdentifierSchema, paginationSchema, topQuerySchema, searchQuerySchema, batchVerdictsSchema } from '../middleware/validation';
import { ValidationError, NotFoundError } from '../errors';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';

/** If input is a 66-char Lightning pubkey, return { hash, pubkey }. Otherwise { hash, pubkey: null }. */
function normalizeIdentifier(input: string): { hash: string; pubkey: string | null } {
  if (input.length === 66 && /^(02|03)/.test(input)) {
    return { hash: sha256(input), pubkey: input };
  }
  return { hash: input, pubkey: null };
}

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
    private trendService: TrendService,
    private verdictService: VerdictService,
    private autoIndexService: AutoIndexService | null = null,
  ) {}

  getAgent = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const { hash, pubkey } = normalizeIdentifier(parsed.data);

      try {
        const result = this.agentService.getAgentScore(hash);
        this.agentRepo.incrementQueryCount(hash);
        res.json({ data: result });
      } catch (err) {
        if (err instanceof NotFoundError && this.autoIndexService && pubkey) {
          const started = this.autoIndexService.tryAutoIndex(pubkey);
          if (started) {
            res.status(202).json({ status: 'indexing', retryAfter: 10 });
            return;
          }
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  };

  getHistory = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const hashParsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!hashParsed.success) throw new ValidationError(hashParsed.error.errors[0].message);
      const { hash: agentHash } = normalizeIdentifier(hashParsed.data);

      const paginationParsed = paginationSchema.safeParse(req.query);
      if (!paginationParsed.success) throw new ValidationError(paginationParsed.error.errors[0].message);

      const { limit, offset } = paginationParsed.data;
      const snapshots = this.snapshotRepo.findHistoryByAgent(agentHash, limit, offset);
      const total = this.snapshotRepo.countByAgent(agentHash);

      // Enrich with deltas: for each snapshot, compute delta vs previous
      const enriched = snapshots.map((s, i) => {
        const prev = i < snapshots.length - 1 ? snapshots[i + 1] : null;
        return {
          score: s.score,
          components: safeParseJson(s.components, {}),
          computedAt: s.computed_at,
          delta: prev ? s.score - prev.score : null,
        };
      });

      // Current agent delta summary
      const latestScore = snapshots.length > 0 ? snapshots[0].score : 0;
      const delta = snapshots.length > 0
        ? this.trendService.computeDeltas(agentHash, latestScore)
        : { delta24h: null, delta7d: null, delta30d: null, trend: 'stable' as const };

      res.json({
        data: enriched,
        delta,
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
      const { limit, offset, sort_by } = topParsed.data;
      const agents = this.agentService.getTopAgents(limit, offset, sort_by);
      const total = this.agentRepo.count();

      res.json({
        data: agents.map(a => ({
          publicKeyHash: a.publicKeyHash,
          alias: a.alias,
          score: a.score,
          totalTransactions: a.totalTransactions,
          source: a.source,
          components: a.components,
        })),
        meta: { total, limit, offset, sort_by },
      });
    } catch (err) {
      next(err);
    }
  };

  getMovers = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const { up, down } = this.trendService.getTopMovers(5);
      res.json({ data: { up, down } });
    } catch (err) {
      next(err);
    }
  };

  getVerdict = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const { hash, pubkey } = normalizeIdentifier(parsed.data);

      // Extract caller pubkey from query param or header (with safe type guard)
      const callerRaw = typeof req.query.caller_pubkey === 'string' ? req.query.caller_pubkey
        : typeof req.headers['x-caller-pubkey'] === 'string' ? req.headers['x-caller-pubkey']
        : undefined;
      let callerPubkey: string | undefined;
      if (callerRaw) {
        const callerParsed = publicKeyHashSchema.safeParse(callerRaw);
        if (!callerParsed.success) throw new ValidationError('Invalid caller_pubkey: expected 64 hex characters');
        callerPubkey = callerParsed.data;
      }

      const result = this.verdictService.getVerdict(hash, callerPubkey);

      // Auto-index if UNKNOWN and input was a Lightning pubkey
      if (result.verdict === 'UNKNOWN' && this.autoIndexService && pubkey) {
        const started = this.autoIndexService.tryAutoIndex(pubkey);
        if (started) {
          res.status(202).json({ status: 'indexing', retryAfter: 10 });
          return;
        }
      }

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  batchVerdicts = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = batchVerdictsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const MAX_AUTO_INDEX_PER_BATCH = 2;
      let autoIndexCount = 0;

      const results = parsed.data.hashes.map(identifier => {
        const { hash, pubkey } = normalizeIdentifier(identifier);
        const verdict = this.verdictService.getVerdict(hash);

        // Auto-index unknown Lightning pubkeys (capped per batch to prevent abuse)
        if (verdict.verdict === 'UNKNOWN' && this.autoIndexService && pubkey && autoIndexCount < MAX_AUTO_INDEX_PER_BATCH) {
          const alreadyPending = this.autoIndexService.isPending(pubkey);
          if (this.autoIndexService.tryAutoIndex(pubkey) && !alreadyPending) {
            autoIndexCount++;
          }
        }

        return { publicKeyHash: hash, ...verdict };
      });

      res.json({ data: results });
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
