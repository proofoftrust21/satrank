// Service discovery controller — browse and search L402 services
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ScoringService } from '../services/scoringService';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';

const VERDICT_UNKNOWN_THRESHOLD = 30;

const serviceSearchSchema = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  minUptime: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['score', 'price', 'uptime']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export class ServiceController {
  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private agentRepo: AgentRepository,
    private scoringService: ScoringService,
  ) {}

  search = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = serviceSearchSchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.query));

      const filters = parsed.data;
      const { services, total } = this.serviceEndpointRepo.findServices({
        q: filters.q,
        category: filters.category,
        minUptime: filters.minUptime,
        sort: filters.sort,
        limit: filters.limit,
        offset: filters.offset,
      });

      // Enrich with SatRank node data
      const enriched = services.map(svc => {
        const agent = svc.agent_hash ? this.agentRepo.findByHash(svc.agent_hash) : null;
        const scoreResult = svc.agent_hash ? this.scoringService.getScore(svc.agent_hash) : null;
        const score = scoreResult?.total ?? null;
        const verdict = score !== null
          ? (score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' as const : score >= VERDICT_UNKNOWN_THRESHOLD ? 'UNKNOWN' as const : 'RISKY' as const)
          : null;
        const uptimeRatio = svc.check_count >= 3
          ? Math.round((svc.success_count / svc.check_count) * 1000) / 1000
          : null;

        return {
          name: svc.name,
          description: svc.description,
          category: svc.category,
          provider: svc.provider,
          url: svc.url,
          priceSats: svc.service_price_sats,
          httpHealth: svc.last_http_status !== null && svc.last_http_status > 0
            ? classifyStatus(svc.last_http_status)
            : null,
          uptimeRatio,
          latencyMs: svc.last_latency_ms,
          lastCheckedAt: svc.last_checked_at,
          node: agent ? {
            publicKeyHash: agent.public_key_hash,
            alias: agent.alias,
            score,
            verdict,
          } : null,
        };
      });

      // Post-filter by minScore (requires agent join, can't do in SQL)
      const filtered = filters.minScore !== undefined
        ? enriched.filter(s => s.node && s.node.score !== null && s.node.score >= filters.minScore!)
        : enriched;

      // Re-sort by score if requested (SQL sorts by check_count, not agent score)
      const sorted = filters.sort === 'score'
        ? filtered.sort((a, b) => (b.node?.score ?? 0) - (a.node?.score ?? 0))
        : filtered;

      res.json({
        data: sorted,
        meta: { total: sorted.length, limit: filters.limit ?? 20, offset: filters.offset ?? 0 },
      });
    } catch (err) {
      next(err);
    }
  };

  categories = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const cats = this.serviceEndpointRepo.findCategories();
      res.json({ data: cats });
    } catch (err) {
      next(err);
    }
  };

  /** Picks 3 best providers for a category/keyword: bestQuality, bestValue, cheapest.
   *  All three filter to SAFE nodes (score ≥ 47). */
  best = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = serviceSearchSchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.query));

      // Pull all matching services (cap at 100 candidates to keep ranking O(n))
      const { services } = this.serviceEndpointRepo.findServices({
        q: parsed.data.q,
        category: parsed.data.category,
        limit: 100,
        offset: 0,
      });

      // Enrich + filter to SAFE nodes with valid price + optional minUptime floor
      const minUptime = parsed.data.minUptime ?? 0;
      const enriched = services
        .map(svc => {
          const agent = svc.agent_hash ? this.agentRepo.findByHash(svc.agent_hash) : null;
          const scoreResult = svc.agent_hash ? this.scoringService.getScore(svc.agent_hash) : null;
          const score = scoreResult?.total ?? 0;
          const uptimeRatio = svc.check_count >= 3 ? svc.success_count / svc.check_count : 0;
          const price = svc.service_price_sats ?? 0;
          return { svc, agent, score, uptimeRatio, price };
        })
        .filter(s =>
          s.score >= VERDICT_SAFE_THRESHOLD &&
          s.uptimeRatio > 0 &&
          s.price > 0 &&
          s.uptimeRatio >= minUptime,
        );

      if (enriched.length === 0) {
        res.json({
          data: { bestQuality: null, bestValue: null, cheapest: null },
          meta: { candidates: 0, message: 'No SAFE services with positive uptime and price found' },
        });
        return;
      }

      // bestQuality = max(score × uptime), price ignored
      const bestQuality = enriched.reduce((best, s) =>
        (s.score * s.uptimeRatio) > (best.score * best.uptimeRatio) ? s : best,
      );

      // bestValue = max((score × uptime) / sqrt(price)) — sqrt softens price impact
      const bestValue = enriched.reduce((best, s) => {
        const sValue = (s.score * s.uptimeRatio) / Math.sqrt(s.price);
        const bValue = (best.score * best.uptimeRatio) / Math.sqrt(best.price);
        return sValue > bValue ? s : best;
      });

      // cheapest = min(price) among SAFE
      const cheapest = enriched.reduce((min, s) => s.price < min.price ? s : min);

      const format = (e: typeof enriched[number]) => ({
        name: e.svc.name,
        category: e.svc.category,
        provider: e.svc.provider,
        url: e.svc.url,
        priceSats: e.price,
        uptimeRatio: Math.round(e.uptimeRatio * 1000) / 1000,
        node: e.agent ? {
          publicKeyHash: e.agent.public_key_hash,
          alias: e.agent.alias,
          score: e.score,
        } : null,
      });

      res.json({
        data: {
          bestQuality: format(bestQuality),
          bestValue: format(bestValue),
          cheapest: format(cheapest),
        },
        meta: { candidates: enriched.length, formula: 'bestValue = (score × uptime) / sqrt(priceSats)' },
      });
    } catch (err) {
      next(err);
    }
  };
}

function classifyStatus(status: number): 'healthy' | 'degraded' | 'down' {
  if (status >= 200 && status < 300) return 'healthy';
  if (status === 301 || status === 302 || status === 307 || status === 308) return 'healthy';
  if (status === 402) return 'healthy';
  if (status === 401 || status === 403) return 'degraded';
  if (status >= 400 && status < 500) return 'degraded';
  return 'down';
}
