// Agent endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { AgentService } from '../services/agentService';
import type { VerdictService } from '../services/verdictService';
import type { AutoIndexService } from '../services/autoIndexService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { TrendService } from '../services/trendService';
import { agentIdentifierSchema, paginationSchema, topQuerySchema, searchQuerySchema, batchVerdictsSchema } from '../middleware/validation';
import { ValidationError, NotFoundError } from '../errors';
import { normalizeIdentifier } from '../utils/identifier';
import { logger } from '../logger';
import * as memoryCache from '../cache/memoryCache';

/** TTL for the leaderboard response cache — matches the 30s stats TTL. */
const TOP_CACHE_TTL_MS = 30_000;

interface TopResponse {
  data: Array<{
    publicKeyHash: string;
    alias: string | null;
    score: number;
    rank: number | null;
    totalTransactions: number;
    source: string;
    components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
    delta7d: number | null;
  }>;
  meta: { total: number; limit: number; offset: number; sort_by: string };
}

function safeParseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    logger.warn({ len: value.length }, 'JSON.parse failed on snapshot components, using fallback');
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

  /** Builds the leaderboard response from the current DB state. Extracted so
   *  the startup warm-up can reuse the exact same path the controller uses. */
  buildTopResponse(limit: number, offset: number, sort_by: 'score' | 'volume' | 'reputation' | 'seniority' | 'regularity' | 'diversity'): TopResponse {
    const agents = this.agentService.getTopAgents(limit, offset, sort_by);
    const total = this.agentRepo.count();

    return {
      data: agents.map(a => {
        const delta = this.trendService.computeDeltas(a.publicKeyHash, a.score);
        return {
          publicKeyHash: a.publicKeyHash,
          alias: a.alias,
          score: a.score,
          rank: this.agentRepo.getRank(a.publicKeyHash),
          totalTransactions: a.totalTransactions,
          source: a.source,
          components: a.components,
          delta7d: delta.delta7d,
        };
      }),
      meta: { total, limit, offset, sort_by },
    };
  }

  getTop = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const topParsed = topQuerySchema.safeParse(req.query);
      if (!topParsed.success) throw new ValidationError(topParsed.error.errors[0].message);
      const { limit, offset, sort_by } = topParsed.data;

      // Key varies per leaderboard variant so component-sorted views don't collide
      const cacheKey = `agents:top:${limit}:${offset}:${sort_by}`;
      const cached = memoryCache.get<TopResponse>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const response = this.buildTopResponse(limit, offset, sort_by);
      memoryCache.set(cacheKey, response, TOP_CACHE_TTL_MS);
      res.json(response);
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

  getVerdict = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const { hash, pubkey } = normalizeIdentifier(parsed.data);

      // Extract caller pubkey from query param or header — accepts 64-char hash or 66-char Lightning pubkey
      const callerRaw = typeof req.query.caller_pubkey === 'string' ? req.query.caller_pubkey
        : typeof req.headers['x-caller-pubkey'] === 'string' ? req.headers['x-caller-pubkey']
        : undefined;
      let callerPubkey: string | undefined;
      if (callerRaw) {
        const callerParsed = agentIdentifierSchema.safeParse(callerRaw);
        if (!callerParsed.success) throw new ValidationError('Invalid caller_pubkey: expected 64-char SHA256 hash or 66-char Lightning pubkey');
        // Normalize to hash for internal use (trust graph + pathfinding lookup)
        callerPubkey = normalizeIdentifier(callerParsed.data).hash;
      }

      const result = await this.verdictService.getVerdict(hash, callerPubkey);

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

  batchVerdicts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = batchVerdictsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);

      const MAX_AUTO_INDEX_PER_BATCH = 2;
      let autoIndexCount = 0;

      // Batch verdicts: no caller_pubkey, no pathfinding (would be N * 100ms)
      const results: Array<{ publicKeyHash: string } & Awaited<ReturnType<typeof this.verdictService.getVerdict>>> = [];
      for (const identifier of parsed.data.hashes) {
        const { hash, pubkey } = normalizeIdentifier(identifier);
        const verdict = await this.verdictService.getVerdict(hash);

        // Auto-index unknown Lightning pubkeys (capped per batch to prevent abuse)
        if (verdict.verdict === 'UNKNOWN' && this.autoIndexService && pubkey && autoIndexCount < MAX_AUTO_INDEX_PER_BATCH) {
          const alreadyPending = this.autoIndexService.isPending(pubkey);
          if (this.autoIndexService.tryAutoIndex(pubkey) && !alreadyPending) {
            autoIndexCount++;
          }
        }

        results.push({ publicKeyHash: hash, ...verdict });
      }

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

      // Enrich with components from latest snapshots (same shape as /agents/top)
      const hashes = agents.map(a => a.public_key_hash);
      const snapshotMap = this.snapshotRepo.findLatestByAgents(hashes);
      const defaultComponents = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };

      res.json({
        data: agents.map(a => {
          const snap = snapshotMap.get(a.public_key_hash);
          let components = defaultComponents;
          if (snap) {
            const parsed = safeParseJson(snap.components, null);
            if (parsed && typeof parsed === 'object' && 'volume' in parsed) {
              components = parsed as typeof defaultComponents;
            }
          }
          const delta = this.trendService.computeDeltas(a.public_key_hash, a.avg_score);
          return {
            publicKeyHash: a.public_key_hash,
            alias: a.alias,
            score: a.avg_score,
            rank: this.agentRepo.getRank(a.public_key_hash),
            totalTransactions: a.total_transactions,
            source: a.source,
            components,
            delta7d: delta.delta7d,
          };
        }),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };
}
