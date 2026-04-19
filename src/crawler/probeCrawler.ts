// Probe crawler — tests route reachability to Lightning nodes via LND QueryRoutes
// Proprietary data: only our node can generate this. One probe = one route query, no payment sent.
// LND API: GET /v1/graph/routes/{pub_key}/{amt}
import type Database from 'better-sqlite3';
import { logger } from '../logger';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { TransactionRepository, DualWriteMode } from '../repositories/transactionRepository';
import type { BayesianScoringService } from '../services/bayesianScoringService';
import type { LndGraphClient } from './lndGraphClient';
import { CircuitBreaker } from '../utils/circuitBreaker';
import { sha256 } from '../utils/crypto';
import { windowBucket, type DualWriteLogger, type DualWriteEnrichment } from '../utils/dualWriteLogger';

export interface ProbeCrawlResult {
  startedAt: number;
  finishedAt: number;
  probed: number;
  reachable: number;
  unreachable: number;
  errors: string[];
}

// Multi-amount probe tiers. The base probe (1k sats) runs for all nodes.
// Higher tiers run only for hot nodes (recently queried via /decide) and
// nodes reachable at 1k, to reveal the max routable amount per node.
const PROBE_AMOUNTS = [1_000, 10_000, 100_000, 1_000_000];

interface ProbeCrawlerOptions {
  maxPerSecond: number;
  amountSats: number;
  /** Dual-write mode for the v31 enrichment columns on the transactions row.
   *  Bayesian aggregates ingestion is systematically performed regardless of
   *  this flag — only the transactions.endpoint_hash/operator_id/source/
   *  window_bucket population respects it. See Phase 3 brief Q1. */
  dualWriteMode?: DualWriteMode;
}

/** Optional dependencies that turn probe observations into bayesian signal.
 *  When any is missing, the crawler still writes probe_results (legacy
 *  behavior) but produces no bayesian ingestion — used by the few unit
 *  tests that don't bootstrap the full stack. */
export interface ProbeCrawlerBayesianDeps {
  txRepo: TransactionRepository;
  bayesian: BayesianScoringService;
  db: Database.Database;
  dualWriteLogger?: DualWriteLogger;
}

export class ProbeCrawler {
  private breaker: CircuitBreaker;
  private delayMs: number;

  constructor(
    private lndClient: LndGraphClient,
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private options: ProbeCrawlerOptions,
    private bayesianDeps?: ProbeCrawlerBayesianDeps,
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

    // Hot nodes first (recently queried via /decide or /ping), then the rest
    const hotNodes = this.agentRepo.findHotNodes(7200); // queried in last 2h
    const allAgents = this.agentRepo.findLightningAgentsWithPubkey();
    const hotSet = new Set(hotNodes.map(a => a.public_key_hash));
    const coldAgents = allAgents.filter(a => !hotSet.has(a.public_key_hash));
    const agents = [...hotNodes, ...coldAgents];
    logger.info({ total: agents.length, hot: hotNodes.length }, `Starting probe crawl: ${agents.length} agents to probe (${hotNodes.length} hot)`);

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
        const isHot = hotSet.has(agent.public_key_hash);
        // Base probe at the configured amount (default 1k sats)
        const baseAmount = this.options.amountSats;
        const startMs = Date.now();
        const response = await this.lndClient.queryRoutes(agent.public_key, baseAmount);
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
            probe_amount_sats: baseAmount,
          });
          result.reachable++;
          this.ingestProbeToBayesian(agent.public_key_hash, baseAmount, true, now);

          // Multi-amount probing for hot nodes: test higher tiers to find
          // the max routable amount. Stops at the first failure (no point
          // testing 1M if 100k already fails). Each tier adds ~50-100ms.
          if (isHot) {
            for (const amt of PROBE_AMOUNTS) {
              if (amt <= baseAmount) continue;
              try {
                const tierResp = await this.lndClient.queryRoutes(agent.public_key, amt);
                const tierRoutes = tierResp.routes ?? [];
                const tierReachable = tierRoutes.length > 0;
                this.probeRepo.insert({
                  target_hash: agent.public_key_hash,
                  probed_at: now,
                  reachable: tierReachable ? 1 : 0,
                  latency_ms: null,
                  hops: tierReachable ? tierRoutes[0].hops.length : null,
                  estimated_fee_msat: tierReachable ? (parseInt(tierRoutes[0].total_fees_msat, 10) || null) : null,
                  failure_reason: tierReachable ? null : 'no_route',
                  probe_amount_sats: amt,
                });
                if (!tierReachable) break; // stop escalating
              } catch { break; }
            }
          }
        } else {
          this.probeRepo.insert({
            target_hash: agent.public_key_hash,
            probed_at: now,
            reachable: 0,
            latency_ms: null,
            hops: null,
            estimated_fee_msat: null,
            failure_reason: 'no_route',
            probe_amount_sats: baseAmount,
          });
          result.unreachable++;
          this.ingestProbeToBayesian(agent.public_key_hash, baseAmount, false, now);
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

  /** Bridge base-probe outcome → bayesian streaming state. Une transaction
   *  SQLite atomique : INSERT `transactions` + `ingestStreaming`.
   *
   *  Daily idempotence via tx_id = sha256('lnprobe:<pubkey>:<bucket>:<amount>').
   *  The guard avoids double-counting on overlapping cron ticks / restarts.
   *
   *  Only the base amount contributes — higher tiers are capacity-discovery
   *  probes, not a fresh reachability signal for 1k-sat routing. */
  private ingestProbeToBayesian(pubkeyHash: string, amountSats: number, success: boolean, timestamp: number): void {
    if (!this.bayesianDeps) return;
    if (amountSats !== this.options.amountSats) return;

    const { txRepo, bayesian, db, dualWriteLogger } = this.bayesianDeps;
    const bucket = windowBucket(timestamp);
    const txId = sha256(`lnprobe:${pubkeyHash}:${bucket}:${amountSats}`);
    const mode = this.options.dualWriteMode ?? 'active';

    try {
      db.transaction(() => {
        if (txRepo.findById(txId)) return;

        const tx = {
          tx_id: txId,
          sender_hash: pubkeyHash,
          receiver_hash: pubkeyHash,
          amount_bucket: amountToBucket(amountSats),
          timestamp,
          payment_hash: sha256(`${txId}:ph`),
          preimage: null,
          status: (success ? 'verified' : 'failed') as 'verified' | 'failed',
          protocol: 'keysend' as const,
        };
        const enrichment: DualWriteEnrichment = {
          endpoint_hash: pubkeyHash,
          operator_id: pubkeyHash,
          source: 'probe',
          window_bucket: bucket,
        };
        txRepo.insertWithDualWrite(tx, enrichment, mode, 'probeCrawler', dualWriteLogger);
        // Phase 3 streaming — unique chemin d'écriture verdict. Observer exclu :
        // probe écrit dans streaming_posteriors ET daily_buckets.
        bayesian.ingestStreaming({
          success,
          timestamp,
          source: 'probe',
          endpointHash: pubkeyHash,
          operatorId: pubkeyHash,
          nodePubkey: pubkeyHash,
        });
      })();
    } catch (err) {
      // A FK miss or a UNIQUE collision must not abort the probe crawler —
      // probe_results was already persisted, which is the legacy contract.
      logger.warn(
        { pubkey: pubkeyHash.slice(0, 12), error: err instanceof Error ? err.message : String(err) },
        'Probe bayesian ingest failed — tx row and streaming posteriors rolled back',
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** Map probe amount (sats) → canonical amount_bucket enum. Mirrors the
 *  thresholds used elsewhere in the codebase so a probe row sits in the
 *  same bucket as a real payment of the same size. */
function amountToBucket(sats: number): 'micro' | 'small' | 'medium' | 'large' {
  if (sats < 10_000) return 'micro';
  if (sats < 100_000) return 'small';
  if (sats < 1_000_000) return 'medium';
  return 'large';
}
