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

      // Candidate pool sorted by UPTIME rather than the default check_count
      // (audit H5). Previously an attacker could register many service
      // endpoints then trigger health checks to inflate their rank. With
      // uptime sort, the top of the pool is dominated by services that
      // pass health checks consistently, which the attacker can't fake
      // without actually serving healthy responses. Post-fetch we still
      // rank client-side on score × uptime / sqrt(price).
      const { services } = this.serviceEndpointRepo.findServices({
        q: parsed.data.q,
        category: parsed.data.category,
        sort: 'uptime',
        limit: 100,
        offset: 0,
      });

      // Enrich + filter to SAFE nodes with valid price + optional minUptime floor.
      // Sim #6 finding: the prior filter ignored last_http_status, so a service
      // returning 404 on every probe could still win bestQuality just because
      // its uptime was >20%. We now classify the last HTTP status (healthy /
      // unknown / degraded / down) and prefer healthy|unknown. Degraded
      // services are only kept as a fallback pool and are tagged with a
      // DEGRADED_HTTP warning so agents can gate on warnings.length === 0.
      const minUptime = parsed.data.minUptime ?? 0;
      const enriched = services
        .map(svc => {
          const agent = svc.agent_hash ? this.agentRepo.findByHash(svc.agent_hash) : null;
          const scoreResult = svc.agent_hash ? this.scoringService.getScore(svc.agent_hash) : null;
          const score = scoreResult?.total ?? 0;
          const uptimeRatio = svc.check_count >= 3 ? svc.success_count / svc.check_count : 0;
          const price = svc.service_price_sats ?? 0;
          const httpHealth = svc.last_http_status !== null && svc.last_http_status > 0
            ? classifyStatus(svc.last_http_status)
            : 'unknown' as const;
          return { svc, agent, score, uptimeRatio, price, httpHealth };
        })
        .filter(s =>
          s.score >= VERDICT_SAFE_THRESHOLD &&
          s.uptimeRatio > 0 &&
          s.price > 0 &&
          s.uptimeRatio >= minUptime &&
          s.httpHealth !== 'down',
        );

      // Prefer healthy|unknown. Fall back to degraded only if the healthy pool is empty.
      const healthyPool = enriched.filter(s => s.httpHealth === 'healthy' || s.httpHealth === 'unknown');
      const pool = healthyPool.length > 0 ? healthyPool : enriched;
      const usedDegradedFallback = healthyPool.length === 0 && enriched.length > 0;

      if (pool.length === 0) {
        res.json({
          data: { bestQuality: null, bestValue: null, cheapest: null },
          meta: { candidates: 0, message: 'No SAFE services with healthy HTTP, positive uptime and price found' },
        });
        return;
      }

      // bestQuality = max(score × uptime), price ignored
      const bestQuality = pool.reduce((best, s) =>
        (s.score * s.uptimeRatio) > (best.score * best.uptimeRatio) ? s : best,
      );

      // bestValue = max((score × uptime) / sqrt(price)) — sqrt softens price impact
      const bestValue = pool.reduce((best, s) => {
        const sValue = (s.score * s.uptimeRatio) / Math.sqrt(s.price);
        const bValue = (best.score * best.uptimeRatio) / Math.sqrt(best.price);
        return sValue > bValue ? s : best;
      });

      // cheapest = min(price) among pool
      const cheapest = pool.reduce((min, s) => s.price < min.price ? s : min);

      // Sim #5 #8 / #6 #3: even the "best" of a thin candidate pool can have
      // poor uptime or degraded HTTP; surface structured warnings so agents
      // can gate on warnings.length === 0 instead of re-deriving thresholds
      // client-side.
      const LOW_UPTIME_THRESHOLD = 0.20;
      const format = (e: typeof pool[number]) => {
        const warnings: string[] = [];
        if (e.uptimeRatio < LOW_UPTIME_THRESHOLD) warnings.push('LOW_UPTIME');
        if (e.httpHealth === 'degraded') warnings.push('DEGRADED_HTTP');
        return {
          name: e.svc.name,
          category: e.svc.category,
          provider: e.svc.provider,
          url: e.svc.url,
          priceSats: e.price,
          uptimeRatio: Math.round(e.uptimeRatio * 1000) / 1000,
          httpHealth: e.httpHealth,
          node: e.agent ? {
            publicKeyHash: e.agent.public_key_hash,
            alias: e.agent.alias,
            score: e.score,
          } : null,
          warnings,
        };
      };

      res.json({
        data: {
          bestQuality: format(bestQuality),
          bestValue: format(bestValue),
          cheapest: format(cheapest),
        },
        meta: {
          candidates: pool.length,
          healthyCandidates: healthyPool.length,
          usedDegradedFallback,
          formula: 'bestValue = (score × uptime) / sqrt(priceSats)',
        },
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
