// Agent endpoint controller
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AgentService } from '../services/agentService';
import type { VerdictService } from '../services/verdictService';
import type { AutoIndexService } from '../services/autoIndexService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { TrendService } from '../services/trendService';
import { agentIdentifierSchema, paginationSchema, topQuerySchema, searchQuerySchema, batchVerdictsSchema } from '../middleware/validation';
import { ValidationError, NotFoundError } from '../errors';
import { normalizeIdentifier, resolveIdentifier } from '../utils/identifier';
import { logger } from '../logger';
import * as memoryCache from '../cache/memoryCache';
import { formatZodError } from '../utils/zodError';
import { logTokenQuery } from '../utils/tokenQueryLog';
import type Database from 'better-sqlite3';

/** TTL for the leaderboard response cache — matches the stats TTL of 5 minutes.
 *  Long enough that refresh blocks are rare, short enough that new scoring cycles
 *  propagate to the leaderboard within a few minutes. */
const TOP_CACHE_TTL_MS = 5 * 60_000;

interface TopResponse {
  data: Array<{
    publicKeyHash: string;
    alias: string | null;
    /** Integer score (API contract, stable) */
    score: number;
    /** 2-decimal float — use for visual tie-breaking when many nodes sit in
     *  the same integer band (the 80-82 compression observed 2026-04-17). */
    scoreFine: number;
    rank: number | null;
    totalTransactions: number;
    source: string;
    components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
    delta7d: number | null;
    /** False when the 7d comparator predates the Option D methodology cutoff.
     *  UI should render "—" or a "methodology change" badge instead of the
     *  numeric delta, which would mix pre/post-methodology scores. Auto-
     *  resolves 7 days after the cutoff. */
    deltaValid: boolean;
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
    // Optional DB handle — used to write decide_log entries from verdict/batch
    // paths so the /api/report endpoint accepts tokens whose history lives on
    // those endpoints rather than /api/decide.
    private db?: Database.Database,
  ) {}

  getAgent = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.params.publicKeyHash, { fallbackField: 'publicKeyHash' }));

      const { hash, pubkey } = resolveIdentifier(parsed.data, p => this.agentRepo.findByPubkey(p));

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
      if (!hashParsed.success) throw new ValidationError(formatZodError(hashParsed.error, req.params.publicKeyHash, { fallbackField: 'publicKeyHash' }));
      const { hash: agentHash } = resolveIdentifier(hashParsed.data, p => this.agentRepo.findByPubkey(p));

      const paginationParsed = paginationSchema.safeParse(req.query);
      if (!paginationParsed.success) throw new ValidationError(formatZodError(paginationParsed.error, req.query));

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
   *  the startup warm-up can reuse the exact same path the controller uses.
   *  Uses batch queries (3 + 1 instead of 5N) to avoid N+1 amplification. */
  buildTopResponse(limit: number, offset: number, sort_by: 'score' | 'volume' | 'reputation' | 'seniority' | 'regularity' | 'diversity'): TopResponse {
    const agents = this.agentService.getTopAgents(limit, offset, sort_by);
    const total = this.agentRepo.count();

    // Batch: compute all deltas and ranks in 4 queries instead of 5N.
    // Deltas are computed off the float score so the 7d delta reflects real
    // movement (e.g. 80.7 → 82.3 = +1.6) and not integer-rounding noise.
    const hashes = agents.map(a => a.publicKeyHash);
    const deltas = this.trendService.computeDeltasBatch(
      agents.map(a => ({ hash: a.publicKeyHash, score: a.scoreFine })),
    );
    const ranks = this.agentRepo.getRanks(hashes);

    return {
      data: agents.map(a => {
        const d = deltas.get(a.publicKeyHash);
        const delta7d = d?.delta7d;
        return {
          publicKeyHash: a.publicKeyHash,
          alias: a.alias,
          score: a.score,
          scoreFine: a.scoreFine,
          rank: ranks.get(a.publicKeyHash) ?? null,
          totalTransactions: a.totalTransactions,
          source: a.source,
          components: a.components,
          // Round delta7d to 1 decimal for display while keeping source precision.
          delta7d: delta7d != null ? Math.round(delta7d * 10) / 10 : null,
          deltaValid: d?.deltaValid ?? true,
        };
      }),
      meta: { total, limit, offset, sort_by },
    };
  }

  getTop = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const topParsed = topQuerySchema.safeParse(req.query);
      if (!topParsed.success) throw new ValidationError(formatZodError(topParsed.error, req.query));
      const { limit, offset, sort_by } = topParsed.data;

      // Key varies per leaderboard variant so component-sorted views don't collide.
      // Stale-while-revalidate: expired entries refresh in the background so a
      // real user never pays the full rebuild cost after the initial warm-up.
      const cacheKey = `agents:top:${limit}:${offset}:${sort_by}`;
      const response = memoryCache.getOrCompute<TopResponse>(
        cacheKey,
        TOP_CACHE_TTL_MS,
        () => this.buildTopResponse(limit, offset, sort_by),
      );
      res.json(response);
    } catch (err) {
      next(err);
    }
  };

  getMovers = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const response = memoryCache.getOrCompute(
        'agents:movers',
        TOP_CACHE_TTL_MS,
        () => {
          const { up, down } = this.trendService.getTopMovers(5);
          return { data: { gainers: up, losers: down } };
        },
      );
      res.json(response);
    } catch (err) {
      next(err);
    }
  };

  getVerdict = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = agentIdentifierSchema.safeParse(req.params.publicKeyHash);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.params.publicKeyHash, { fallbackField: 'publicKeyHash' }));

      const { hash, pubkey } = resolveIdentifier(parsed.data, p => this.agentRepo.findByPubkey(p));

      // Extract caller pubkey from query param or header — accepts 64-char hash or 66-char Lightning pubkey
      const callerRaw = typeof req.query.caller_pubkey === 'string' ? req.query.caller_pubkey
        : typeof req.headers['x-caller-pubkey'] === 'string' ? req.headers['x-caller-pubkey']
        : undefined;
      let callerPubkey: string | undefined;
      if (callerRaw) {
        const callerParsed = agentIdentifierSchema.safeParse(callerRaw);
        if (!callerParsed.success) throw new ValidationError(formatZodError(callerParsed.error, callerRaw, { fallbackField: 'caller_pubkey' }));
        // Normalize to hash for internal use (trust graph + pathfinding lookup)
        callerPubkey = normalizeIdentifier(callerParsed.data).hash;
      }

      const result = await this.verdictService.getVerdict(hash, callerPubkey, undefined, 'verdict');
      // Record token-target binding so the caller can later /api/report on it.
      logTokenQuery(this.db, req.headers.authorization, hash, req.requestId);

      // Auto-index if UNKNOWN and input was a Lightning pubkey
      if (result.verdict === 'UNKNOWN' && this.autoIndexService && pubkey) {
        const started = this.autoIndexService.tryAutoIndex(pubkey);
        if (started) {
          res.status(202).json({ status: 'indexing', retryAfter: 10 });
          return;
        }
      }

      // Weak ETag over the verdict payload. Changes whenever score, flags,
      // pathfinding, or personalTrust shifts — which is exactly what clients
      // need to revalidate after the 30s Cache-Control window. Skipped when
      // callerPubkey is present (personalTrust makes the response caller-specific
      // and the Vary header makes shared caches useless).
      const etag = `W/"${crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', callerPubkey ? 'private, max-age=30' : 'public, max-age=30');
      if (callerPubkey) res.setHeader('Vary', 'X-Caller-Pubkey');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  batchVerdicts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = batchVerdictsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));

      const MAX_AUTO_INDEX_PER_BATCH = 2;
      let autoIndexCount = 0;

      // Batch verdicts: no caller_pubkey, no pathfinding (would be N * 100ms)
      const results: Array<{ publicKeyHash: string } & Awaited<ReturnType<typeof this.verdictService.getVerdict>>> = [];
      for (const identifier of parsed.data.hashes) {
        const { hash, pubkey } = resolveIdentifier(identifier, p => this.agentRepo.findByPubkey(p));
        const verdict = await this.verdictService.getVerdict(hash, undefined, undefined, 'verdict');
        // Bind every queried target to the caller token so each one is eligible
        // for a later /api/report submission.
        logTokenQuery(this.db, req.headers.authorization, hash, req.requestId);

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
      if (!searchParsed.success) throw new ValidationError(formatZodError(searchParsed.error, req.query));
      const { alias, limit, offset } = searchParsed.data;
      const agents = this.agentService.searchByAlias(alias, limit, offset);
      const total = this.agentRepo.countByAlias(alias);

      // Enrich with components from latest snapshots (same shape as /agents/top)
      const hashes = agents.map(a => a.public_key_hash);
      const snapshotMap = this.snapshotRepo.findLatestByAgents(hashes);
      const defaultComponents = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };

      // Batch: compute all deltas and ranks in 4 queries instead of 5N
      const deltas = this.trendService.computeDeltasBatch(
        agents.map(a => ({ hash: a.public_key_hash, score: a.avg_score })),
      );
      const ranks = this.agentRepo.getRanks(hashes);

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
          const scoreFine = Math.round(a.avg_score * 100) / 100;
          const d = deltas.get(a.public_key_hash);
          const delta7d = d?.delta7d;
          return {
            publicKeyHash: a.public_key_hash,
            alias: a.alias,
            score: Math.round(scoreFine),
            scoreFine,
            rank: ranks.get(a.public_key_hash) ?? null,
            totalTransactions: a.total_transactions,
            source: a.source,
            components,
            delta7d: delta7d != null ? Math.round(delta7d * 10) / 10 : null,
            deltaValid: d?.deltaValid ?? true,
          };
        }),
        meta: { total, limit, offset },
      });
    } catch (err) {
      next(err);
    }
  };
}
