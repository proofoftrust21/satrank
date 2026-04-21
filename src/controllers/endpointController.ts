// Endpoint detail controller — Bayesian view of a single HTTP service endpoint
// keyed by the sha256 of its canonical URL (endpoint_hash).
//
// The route is intentionally decoupled from `/api/services/:url` (which is
// keyed by the literal URL and couples discovery+metadata). `/endpoint/:url_hash`
// is the Bayesian-only detail endpoint — it returns the canonical
// BayesianScoreBlock for the endpoint plus light metadata when a matching
// service_endpoints row is known.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { BayesianVerdictService } from '../services/bayesianVerdictService';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { OperatorService } from '../services/operatorService';
import type { BayesianScoreBlock } from '../types';
import { computeAdvisoryReport } from '../services/advisoryService';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';

const urlHashSchema = z.object({
  url_hash: z.string().regex(/^[0-9a-f]{64}$/, 'url_hash must be a 64-char lowercase sha256 hex'),
});

export class EndpointController {
  constructor(
    private bayesianVerdict: BayesianVerdictService,
    private serviceEndpointRepo: ServiceEndpointRepository,
    private agentRepo: AgentRepository,
    private operatorService: OperatorService,
  ) {}

  show = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = urlHashSchema.safeParse(req.params);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.params));

      const urlHash = parsed.data.url_hash;

      const v = await this.bayesianVerdict.buildVerdict({ targetHash: urlHash });
      const bayesian: BayesianScoreBlock = {
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
      };

      const svc = await this.serviceEndpointRepo.findByUrlHash(urlHash);
      const metadata = svc ? {
        url: svc.url,
        name: svc.name,
        description: svc.description,
        category: svc.category,
        provider: svc.provider,
        priceSats: svc.service_price_sats,
        source: svc.source,
      } : null;

      const http = svc ? {
        status: svc.last_http_status,
        latencyMs: svc.last_latency_ms,
        uptimeRatio: svc.check_count >= 3
          ? Math.round((svc.success_count / svc.check_count) * 1000) / 1000
          : null,
        checkCount: svc.check_count,
        lastCheckedAt: svc.last_checked_at,
      } : null;

      const node = svc && svc.agent_hash
        ? await (async () => {
            const agent = await this.agentRepo.findByHash(svc.agent_hash!);
            return agent ? { publicKeyHash: agent.public_key_hash, alias: agent.alias } : null;
          })()
        : null;

      // Phase 7 — C11 : operator_id exposé seulement quand status='verified'
      // (zero auto-trust). C12 : overlay advisory qui émet OPERATOR_UNVERIFIED
      // quand un operator est rattaché mais pas encore (ou plus) 2/3.
      const operatorLookup = await this.operatorService.resolveOperatorForEndpoint(urlHash);
      const operator_id = operatorLookup?.status === 'verified' ? operatorLookup.operatorId : null;

      const advisory = computeAdvisoryReport({
        bayesian: {
          p_success: bayesian.p_success,
          ci95_low: bayesian.ci95_low,
          ci95_high: bayesian.ci95_high,
          n_obs: bayesian.n_obs,
        },
        operatorLookup,
      });

      res.json({
        data: {
          urlHash,
          bayesian,
          advisory,
          metadata,
          http,
          node,
          operator_id,
        },
        meta: { computedAt: v.computed_at },
      });
    } catch (err) {
      next(err);
    }
  };
}
