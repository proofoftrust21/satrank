// Service discovery controller — browse and search L402 services
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AgentService } from '../services/agentService';
import type { BayesianScoreBlock } from '../types';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';

// Bayesian sort/filter semantics (Phase 3): replace composite 0-100 score
// with posterior p_success ∈ [0,1]. `minPSuccess` replaces `minScore`; `sort`
// axis `p_success` replaces `score`. Legacy query params return 400.
const serviceSearchSchema = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  minPSuccess: z.coerce.number().min(0).max(1).optional(),
  minUptime: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['p_success', 'price', 'uptime']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export class ServiceController {
  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private agentRepo: AgentRepository,
    private agentService: AgentService,
  ) {}

  /** Canonical Bayesian block for a service's agent; `null` when no agent is
   *  linked. Centralised so `search` and `best` share identical semantics. */
  private async bayesianFor(agentHash: string | null): Promise<BayesianScoreBlock | null> {
    if (!agentHash) return null;
    return this.agentService.toBayesianBlock(agentHash);
  }

  search = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = serviceSearchSchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.query));

      const filters = parsed.data;
      const { services } = await this.serviceEndpointRepo.findServices({
        q: filters.q,
        category: filters.category,
        minUptime: filters.minUptime,
        sort: filters.sort,
        limit: filters.limit,
        offset: filters.offset,
      });

      // Enrich with SatRank node data
      const enriched = await Promise.all(services.map(async svc => {
        const agent = svc.agent_hash ? await this.agentRepo.findByHash(svc.agent_hash) : null;
        const bayesian = await this.bayesianFor(svc.agent_hash ?? null);
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
            bayesian,
          } : null,
        };
      }));

      // Post-filter by minPSuccess (requires agent join, can't do in SQL)
      const filtered = filters.minPSuccess !== undefined
        ? enriched.filter(s => s.node && s.node.bayesian !== null && s.node.bayesian.p_success >= filters.minPSuccess!)
        : enriched;

      // Re-sort by posterior p_success if requested (SQL sorts by check_count).
      const sorted = filters.sort === 'p_success'
        ? filtered.sort((a, b) => (b.node?.bayesian?.p_success ?? 0) - (a.node?.bayesian?.p_success ?? 0))
        : filtered;

      res.json({
        data: sorted,
        meta: { total: sorted.length, limit: filters.limit ?? 20, offset: filters.offset ?? 0 },
      });
    } catch (err) {
      next(err);
    }
  };

  categories = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cats = await this.serviceEndpointRepo.findCategories();
      res.json({ data: cats });
    } catch (err) {
      next(err);
    }
  };

  /** Picks 3 best providers for a category/keyword: bestQuality, bestValue, cheapest.
   *
   *  Filtering is tiered (Phase 4 P3):
   *  - **strict** pool: `verdict === 'SAFE'` + httpHealth healthy|unknown. This
   *    is the default; when it's non-empty we return from here.
   *  - **relaxed** fallback: `verdict ∈ {SAFE, UNKNOWN}` + httpHealth
   *    healthy|unknown. Lets agents surface candidates on thin categories where
   *    no node has converged to SAFE yet, rather than returning nulls.
   *  - **degraded** fallback (legacy): if both above are empty, allow
   *    httpHealth === 'degraded' (never 'down'). Tagged with a DEGRADED_HTTP
   *    warning per-result so agents can gate client-side.
   *
   *  `meta.strictness` exposes which pool was used so agents can re-query with
   *  stricter params or inform their user. */
  best = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      const { services } = await this.serviceEndpointRepo.findServices({
        q: parsed.data.q,
        category: parsed.data.category,
        sort: 'uptime',
        limit: 100,
        offset: 0,
      });

      // Enrich all candidates (no verdict gate yet — that's the pool-tier step).
      const minUptime = parsed.data.minUptime ?? 0;
      const enrichedPreFilter = await Promise.all(services.map(async svc => {
        const agent = svc.agent_hash ? await this.agentRepo.findByHash(svc.agent_hash) : null;
        const bayesian = await this.bayesianFor(svc.agent_hash ?? null);
        const uptimeRatio = svc.check_count >= 3 ? svc.success_count / svc.check_count : 0;
        const price = svc.service_price_sats ?? 0;
        const httpHealth = svc.last_http_status !== null && svc.last_http_status > 0
          ? classifyStatus(svc.last_http_status)
          : 'unknown' as const;
        return { svc, agent, bayesian, uptimeRatio, price, httpHealth, lastCheckedAt: svc.last_checked_at };
      }));
      const enriched = enrichedPreFilter.filter(s =>
        s.bayesian !== null &&
        s.uptimeRatio > 0 &&
        s.price > 0 &&
        s.uptimeRatio >= minUptime &&
        s.httpHealth !== 'down',
      );

      // Tier 1 — strict: SAFE verdict + healthy|unknown HTTP.
      const strictPool = enriched.filter(s =>
        s.bayesian!.verdict === 'SAFE'
        && (s.httpHealth === 'healthy' || s.httpHealth === 'unknown'),
      );
      // Tier 2 — relaxed: SAFE or UNKNOWN verdict + healthy|unknown HTTP.
      const relaxedPool = enriched.filter(s =>
        (s.bayesian!.verdict === 'SAFE' || s.bayesian!.verdict === 'UNKNOWN')
        && (s.httpHealth === 'healthy' || s.httpHealth === 'unknown'),
      );
      // Tier 3 — degraded legacy: accept degraded HTTP, still exclude RISKY.
      const degradedPool = enriched.filter(s => s.bayesian!.verdict !== 'RISKY');

      let pool: typeof enriched;
      let strictness: 'strict' | 'relaxed' | 'degraded';
      if (strictPool.length > 0) {
        pool = strictPool;
        strictness = 'strict';
      } else if (relaxedPool.length > 0) {
        pool = relaxedPool;
        strictness = 'relaxed';
      } else {
        pool = degradedPool;
        strictness = 'degraded';
      }
      const usedDegradedFallback = strictness === 'degraded' && enriched.length > 0;

      if (pool.length === 0) {
        res.json({
          data: { bestQuality: null, bestValue: null, cheapest: null },
          meta: {
            candidates: 0,
            strictness,
            message: 'No candidate services found with positive uptime and price',
          },
        });
        return;
      }

      // bestQuality = max(p_success × uptime), price ignored
      const pSuccess = (s: typeof pool[number]): number => s.bayesian?.p_success ?? 0;
      const bestQuality = pool.reduce((best, s) =>
        (pSuccess(s) * s.uptimeRatio) > (pSuccess(best) * best.uptimeRatio) ? s : best,
      );

      // bestValue = max((p_success × uptime) / sqrt(price)) — sqrt softens price impact
      const bestValue = pool.reduce((best, s) => {
        const sValue = (pSuccess(s) * s.uptimeRatio) / Math.sqrt(s.price);
        const bValue = (pSuccess(best) * best.uptimeRatio) / Math.sqrt(best.price);
        return sValue > bValue ? s : best;
      });

      // cheapest = min(price) among pool
      const cheapest = pool.reduce((min, s) => s.price < min.price ? s : min);

      // Sim #5 #8 / #6 #3: even the "best" of a thin candidate pool can have
      // poor uptime or degraded HTTP; surface structured warnings so agents
      // can gate on warnings.length === 0 instead of re-deriving thresholds
      // client-side.
      const LOW_UPTIME_THRESHOLD = 0.20;
      // Sim #7 #4: the cached httpHealth on /services/best can disagree with a
      // fresh probe run by /decide. Surface lastHealthCheckedAt + a derived
      // `stale` boolean so agents can gate on freshness or re-probe themselves.
      const STALE_HEALTH_AGE_SEC = 5 * 60; // 5 min — tied to crawler probe cadence
      const nowSec = Math.floor(Date.now() / 1000);
      const format = (e: typeof pool[number]) => {
        const warnings: string[] = [];
        if (e.uptimeRatio < LOW_UPTIME_THRESHOLD) warnings.push('LOW_UPTIME');
        if (e.httpHealth === 'degraded') warnings.push('DEGRADED_HTTP');
        const lastCheckedAt = e.lastCheckedAt ?? null;
        const ageSec = lastCheckedAt !== null ? nowSec - lastCheckedAt : null;
        const stale = ageSec === null || ageSec > STALE_HEALTH_AGE_SEC;
        if (stale) warnings.push('STALE_HEALTH');
        return {
          name: e.svc.name,
          category: e.svc.category,
          provider: e.svc.provider,
          url: e.svc.url,
          priceSats: e.price,
          uptimeRatio: Math.round(e.uptimeRatio * 1000) / 1000,
          httpHealth: e.httpHealth,
          lastHealthCheckedAt: lastCheckedAt,
          stale,
          node: e.agent ? {
            publicKeyHash: e.agent.public_key_hash,
            alias: e.agent.alias,
            bayesian: e.bayesian,
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
          strictPoolSize: strictPool.length,
          relaxedPoolSize: relaxedPool.length,
          strictness,
          usedDegradedFallback,
          formula: 'bestValue = (p_success × uptime) / sqrt(priceSats)',
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
