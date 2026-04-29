// Service discovery controller — browse and search L402 services
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ServiceEndpoint, ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { AgentService } from '../services/agentService';
import type { BayesianVerdictService } from '../services/bayesianVerdictService';
import type { BayesianScoreBlock } from '../types';
import { endpointHash } from '../utils/urlCanonical';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';

// Bayesian sort/filter semantics (Phase 3): replace composite 0-100 score
// with posterior p_success ∈ [0,1]. `minPSuccess` replaces `minScore`; `sort`
// axis `p_success` replaces `score`. Legacy query params return 400.
// Phase 5.8 — `sort` axes extended with `latency`, `reliability`, `cost`
// so /api/services mirrors the /api/intent `optimize=` parameter. Default
// remains `p_success` for back-compat. The legacy `price` alias keeps
// working (same target column).
const serviceSearchSchema = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  minPSuccess: z.coerce.number().min(0).max(1).optional(),
  minUptime: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['p_success', 'price', 'uptime', 'latency', 'reliability', 'cost']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export class ServiceController {
  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private agentRepo: AgentRepository,
    private agentService: AgentService,
    /** Phase 5.7 — required for the per-endpoint Bayesian read. Optional in
     *  the type position so existing test harnesses that don't wire the
     *  verdict service still construct the controller; runtime falls back to
     *  the legacy operator-keyed agentService.toBayesianBlock when null. */
    private bayesianVerdictService?: BayesianVerdictService,
  ) {}

  /** Phase 5.7 — per-endpoint Bayesian block. Pre-Phase-5.7 `bayesianFor`
   *  read the operator-keyed posterior via agentService.toBayesianBlock,
   *  collapsing every endpoint of one operator into the same numbers
   *  (Sim 4 a02 + a09 verified the resulting bug on /api/services and
   *  /api/services/best). The fix mirrors intentService.toEndpointBayesianBlock:
   *  read the streaming posterior keyed by sha256(canonical url), with the
   *  hierarchical-prior cascade providing the operator/category fallback
   *  when local evidence is thin (in which case `is_meaningful=false`). */
  private async bayesianFor(svc: ServiceEndpoint): Promise<BayesianScoreBlock | null> {
    if (!svc.agent_hash) return null;
    if (!this.bayesianVerdictService) {
      // Test fallback — tests that don't wire the verdict service get the
      // legacy block. Production always injects bayesianVerdictService.
      return this.agentService.toBayesianBlock(svc.agent_hash);
    }
    const urlHash = endpointHash(svc.url);
    const v = await this.bayesianVerdictService.buildVerdict({
      targetHash: urlHash,
      serviceHash: urlHash,
      operatorId: svc.agent_hash ?? undefined,
    });
    return {
      p_success: v.p_success,
      ci95_low: v.ci95_low,
      ci95_high: v.ci95_high,
      n_obs: v.n_obs,
      verdict: v.verdict,
      sources: v.sources,
      convergence: v.convergence,
      recent_activity: v.recent_activity,
      risk_profile: v.risk_profile,
      time_constant_days: v.time_constant_days,
      last_update: v.last_update,
      // Default to true; downstream callers (or per-row checks) can downgrade
      // when freshness or n_obs are insufficient.
      is_meaningful: true,
    };
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
      const now = Math.floor(Date.now() / 1000);
      const enriched = await Promise.all(services.map(async svc => {
        const agent = svc.agent_hash ? await this.agentRepo.findByHash(svc.agent_hash) : null;
        const bayesian = await this.bayesianFor(svc);
        const uptimeRatio = svc.check_count >= 3
          ? Math.round((svc.success_count / svc.check_count) * 1000) / 1000
          : null;
        const medianLatencyMs = await this.serviceEndpointRepo.medianHttpLatency7d(svc.url);
        const lastProbeAgeSec = svc.last_checked_at != null
          ? Math.max(0, now - svc.last_checked_at)
          : null;

        // Phase 5.7 — surface Phase 3 multi-source attribution + l402.directory
        // signals, matching what /api/intent already exposes per candidate.
        // Audit 2026-04-29 fix — previously single-source rows omitted
        // `sources` entirely "for clean payloads", which left agents with no
        // attribution on the most common case (single-source 402index). Always
        // surface the array; an empty/missing column collapses to undefined.
        const sources = svc.sources && svc.sources.length > 0 ? svc.sources : undefined;
        const consumption_type = svc.consumption_type ?? undefined;
        const provider_contact = svc.provider_contact ?? undefined;
        // Phase 5.8 — upstream 402index signals (reliability_score has 24
        // distinct values stddev 19.5; uptime_30d 17 distinct stddev 0.3 —
        // strategic-review.md). Feed the new `optimize=` parameter axes.
        const reliability_score = svc.upstream_reliability_score ?? undefined;
        const uptime_30d = svc.upstream_uptime_30d ?? undefined;

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
          medianLatencyMs,
          lastCheckedAt: svc.last_checked_at,
          lastProbeAgeSec,
          ...(sources !== undefined ? { sources } : {}),
          ...(consumption_type !== undefined ? { consumption_type } : {}),
          ...(provider_contact !== undefined ? { provider_contact } : {}),
          ...(reliability_score !== undefined ? { reliability_score } : {}),
          ...(uptime_30d !== undefined ? { uptime_30d } : {}),
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
        const bayesian = await this.bayesianFor(svc);
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

      // Audit 2026-04-29 fix — pre-rank the pool on each axis with explicit
      // tie-breakers, then take the top of each ranking. Previous reduce()
      // logic only moved on strict > / <, so on a thin/tied pool the same
      // endpoint won all 3 axes (the one that happened to be first in the
      // input order). The audit caught this: 51 candidates, 3 picks all
      // pointing at Hyperdope/predictions/signals.
      const pSuccess = (s: typeof pool[number]): number => s.bayesian?.p_success ?? 0;
      const qualityScore = (s: typeof pool[number]): number => pSuccess(s) * s.uptimeRatio;
      const valueScore = (s: typeof pool[number]): number => qualityScore(s) / Math.sqrt(s.price);

      // Quality = max(p × uptime); ties broken by lower price (cheaper wins),
      // then by higher n_obs (more confident wins).
      const byQuality = [...pool].sort((a, b) => {
        const dq = qualityScore(b) - qualityScore(a);
        if (Math.abs(dq) > 1e-9) return dq;
        if (a.price !== b.price) return a.price - b.price;
        return (b.bayesian?.n_obs ?? 0) - (a.bayesian?.n_obs ?? 0);
      });
      const bestQuality = byQuality[0];

      // Value = max((p × uptime) / sqrt(price)); ties broken by lower price,
      // then higher n_obs. Already cost-sensitive by design.
      const byValue = [...pool].sort((a, b) => {
        const dv = valueScore(b) - valueScore(a);
        if (Math.abs(dv) > 1e-9) return dv;
        if (a.price !== b.price) return a.price - b.price;
        return (b.bayesian?.n_obs ?? 0) - (a.bayesian?.n_obs ?? 0);
      });
      // Pick the first byValue entry that differs from bestQuality (preserve
      // diversity on a thin pool). If every entry coincides with bestQuality,
      // accept the convergence — the pool is genuinely degenerate.
      const bestValue = byValue.find(s => s !== bestQuality) ?? byValue[0];

      // Cheapest = min(price); ties broken by higher quality, then higher n_obs.
      const byCheapest = [...pool].sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        const dq = qualityScore(b) - qualityScore(a);
        if (Math.abs(dq) > 1e-9) return dq;
        return (b.bayesian?.n_obs ?? 0) - (a.bayesian?.n_obs ?? 0);
      });
      const cheapest = byCheapest.find(s => s !== bestQuality && s !== bestValue) ?? byCheapest[0];

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
        // Phase 5.8 — also surface upstream signals on /services/best picks
        // so agents see what fed the chosen ranking dimension.
        const reliability_score = e.svc.upstream_reliability_score ?? undefined;
        const uptime_30d = e.svc.upstream_uptime_30d ?? undefined;
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
          ...(reliability_score !== undefined ? { reliability_score } : {}),
          ...(uptime_30d !== undefined ? { uptime_30d } : {}),
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
