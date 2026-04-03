// Probe crawler — tests route reachability to Lightning nodes via LND QueryRoutes
// Proprietary data: only our node can generate this. One probe = one route query, no payment sent.
// LND API: GET /v1/graph/routes/{pub_key}/{amt}
import { logger } from '../logger';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { LndGraphClient } from './lndGraphClient';
import { CircuitBreaker } from '../utils/circuitBreaker';

export interface ProbeCrawlResult {
  startedAt: number;
  finishedAt: number;
  probed: number;
  reachable: number;
  unreachable: number;
  errors: string[];
}

interface ProbeCrawlerOptions {
  maxPerSecond: number;
  amountSats: number;
}

export class ProbeCrawler {
  private breaker: CircuitBreaker;
  private delayMs: number;

  constructor(
    private lndClient: LndGraphClient,
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private options: ProbeCrawlerOptions,
  ) {
    this.breaker = new CircuitBreaker({ name: 'probe', failureThreshold: 10 });
    this.delayMs = Math.ceil(1000 / options.maxPerSecond);
  }

  async run(): Promise<ProbeCrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: ProbeCrawlResult = {
      startedAt,
      finishedAt: 0,
      probed: 0,
      reachable: 0,
      unreachable: 0,
      errors: [],
    };

    const agents = this.agentRepo.findLightningAgentsWithPubkey();
    logger.info({ count: agents.length }, 'Starting probe crawl');

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      if (!agent.public_key) continue;

      if (!this.breaker.canExecute()) {
        const msg = 'Probe circuit breaker open — aborting crawl';
        logger.warn(msg);
        result.errors.push(msg);
        break;
      }

      try {
        const startMs = Date.now();
        const response = await this.lndClient.queryRoutes(agent.public_key, this.options.amountSats);
        const latencyMs = Date.now() - startMs;
        const now = Math.floor(Date.now() / 1000);

        const hasRoute = response.routes && response.routes.length > 0;

        if (hasRoute) {
          const route = response.routes[0];
          const feeMsat = parseInt(route.total_fees_msat, 10);
          this.probeRepo.insert({
            target_hash: agent.public_key_hash,
            probed_at: now,
            reachable: 1,
            latency_ms: latencyMs,
            hops: route.hops.length,
            estimated_fee_msat: isNaN(feeMsat) ? null : feeMsat,
            failure_reason: null,
          });
          result.reachable++;
        } else {
          this.probeRepo.insert({
            target_hash: agent.public_key_hash,
            probed_at: now,
            reachable: 0,
            latency_ms: null,
            hops: null,
            estimated_fee_msat: null,
            failure_reason: 'no_route',
          });
          result.unreachable++;
        }

        result.probed++;
        this.breaker.onSuccess();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.breaker.onFailure();
        if (result.errors.length < 10) {
          result.errors.push(`${agent.public_key_hash.slice(0, 12)}: ${msg}`);
        }
      }

      // Progress log every 1000
      if ((i + 1) % 1000 === 0) {
        logger.info({
          progress: i + 1,
          total: agents.length,
          reachable: result.reachable,
          unreachable: result.unreachable,
        }, 'Probe crawl progress');
      }

      // Rate limiting
      if (i < agents.length - 1) {
        await this.sleep(this.delayMs);
      }
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    const durationMs = (result.finishedAt - result.startedAt) * 1000;
    logger.info({
      probed: result.probed,
      reachable: result.reachable,
      unreachable: result.unreachable,
      errors: result.errors.length,
      durationMs,
    }, 'Probe crawl complete');

    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
