// Periodic HTTP health checker for known service endpoints.
//
// Axe 1 — runs in 3 independent tiers driven by `last_intent_query_at`:
//   hot  : queried < 2h ago,  re-probed if last check older than 1h
//   warm : queried < 24h ago, re-probed if last check older than 6h
//   cold : queried >= 24h or never, re-probed if last check older than 24h
//
// `run()` keeps the legacy "all stale" sweep for tests and ad-hoc invocations;
// production scheduling calls `runTier(tier)` from three separate timers.
import { logger } from '../logger';
import { sha256 } from '../utils/crypto';
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { windowBucket } from '../utils/dualWriteLogger';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeTier, ServiceEndpoint, ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import type { Transaction } from '../types';
import type { BayesianScoringService } from '../services/bayesianScoringService';

const CHECK_RATE_MS = 200; // 5 checks/sec
const FETCH_TIMEOUT_MS = 3000;

const TIER_LIMITS: Record<ProbeTier, number> = {
  hot: 200,
  warm: 200,
  cold: 500,
};

export interface ServiceHealthRunResult {
  checked: number;
  healthy: number;
  down: number;
  tier?: ProbeTier;
}

export class ServiceHealthCrawler {
  constructor(
    private repo: ServiceEndpointRepository,
    private txRepo?: TransactionRepository,
    private dualWriteMode: DualWriteMode = 'off',
    private dualWriteLogger?: DualWriteLogger,
    private agentRepo?: AgentRepository,
    /** Phase 5 — when wired, every probe outcome is written into the
     *  endpoint-keyed streaming posterior so /api/intent can surface a real
     *  per-URL Bayesian block instead of falling through to the operator
     *  prior. Optional so test harnesses that don't care about scoring can
     *  still construct the crawler with the legacy 5-arg form. */
    private bayesianService?: BayesianScoringService,
  ) {}

  /** Production entrypoint — probe a single tier. */
  async runTier(tier: ProbeTier): Promise<ServiceHealthRunResult> {
    const stale = await this.repo.findStaleByTier(tier, TIER_LIMITS[tier]);
    return this.probeBatch(stale, tier);
  }

  /** Legacy single-sweep — kept for tests and one-off scripts. */
  async run(): Promise<ServiceHealthRunResult> {
    const stale = await this.repo.findStale(3, 1800, 500);
    return this.probeBatch(stale);
  }

  private async probeBatch(stale: ServiceEndpoint[], tier?: ProbeTier): Promise<ServiceHealthRunResult> {
    const result: ServiceHealthRunResult = { checked: 0, healthy: 0, down: 0, tier };
    if (stale.length === 0) return result;
    logger.info({ tier, candidates: stale.length }, 'Service health crawl starting');

    for (const endpoint of stale) {
      let status = 0;
      let latencyMs = 0;
      let healthy = false;

      try {
        // SSRF guard via fetchSafeExternal — single connect-time DNS lookup
        // validated inline (no TOCTOU). Attacker-controlled URL resolving to
        // 169.254.169.254/10.0.0.1 is rejected at the Agent lookup hook.
        const start = Date.now();
        const resp = await fetchSafeExternal(endpoint.url, {
          method: 'GET',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'SatRank-HealthCheck/1.0' },
        });
        latencyMs = Date.now() - start;
        status = resp.status;
        healthy = resp.status === 402 || (resp.status >= 200 && resp.status < 300);
      } catch (err: unknown) {
        if (err instanceof SsrfBlockedError) {
          logger.debug({ url: endpoint.url, reason: err.message }, 'Health crawler skipped URL (SSRF)');
        }
        status = 0;
        latencyMs = 0;
        healthy = false;
      }

      await this.repo.upsert(endpoint.agent_hash, endpoint.url, status, latencyMs);
      if (healthy) result.healthy++;
      else result.down++;

      await this.dualWriteProbeTx(endpoint, healthy);
      // Phase 5 — feed the per-endpoint streaming posterior so /api/intent's
      // Bayesian block discriminates per URL, not per operator. Skipped when
      // bayesianService isn't wired (test harnesses that don't care about scoring).
      await this.ingestProbeStreaming(endpoint, healthy);

      result.checked++;
      if (result.checked < stale.length) {
        await new Promise(resolve => setTimeout(resolve, CHECK_RATE_MS));
      }
    }

    logger.info({ ...result }, 'Service health crawl complete');
    return result;
  }

  /** Phase 5 — endpoint-keyed streaming posterior write. probeCrawler.ts
   *  feeds operator-keyed posteriors via LN keysend probes; this is the
   *  parallel write for HTTP probes. Without it, /api/intent's Bayesian
   *  read keyed by `endpointHash(url)` falls through to the prior cascade
   *  on every endpoint, defeating per-URL discrimination (Sim 3 root cause).
   *
   *  Idempotency: streaming_posteriors are additive on (target_hash, source);
   *  duplicate writes from overlapping cron ticks are tolerated by the
   *  τ=7d decay applied at read time.
   *
   *  Skipped when bayesianService isn't injected (test contexts) or when the
   *  endpoint has no operator hash (synthesized probe rows can't satisfy
   *  the operator FK in the daily_buckets table). */
  private async ingestProbeStreaming(endpoint: ServiceEndpoint, success: boolean): Promise<void> {
    if (!this.bayesianService) return;
    if (!endpoint.agent_hash) return;
    try {
      const urlHash = endpointHash(endpoint.url);
      await this.bayesianService.ingestStreaming({
        success,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'probe',
        endpointHash: urlHash,
        serviceHash: urlHash,
        operatorId: endpoint.agent_hash,
        nodePubkey: endpoint.agent_hash,
      });
    } catch (err) {
      logger.warn(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Probe streaming ingest failed — endpoint posterior unchanged',
      );
    }
  }

  /** Compose a synthetic probe-tx row and dispatch through insertWithDualWrite
   *  per docs/PHASE-1-DESIGN.md §4. Skipped when:
   *   - mode is `off` — probes are a *new* writer for `transactions`; preserving
   *     pre-v31 behavior in off mode means we don't introduce rows here at all.
   *   - endpoint has no operator (agent_hash IS NULL) — can't satisfy NOT NULL
   *     FKs on sender_hash/receiver_hash. Matches §1.1's `operator_id` NULL
   *     rule: if we don't know the operator we don't attribute probe observations.
   *   - txRepo wasn't injected — allows the crawler to be used in contexts
   *     (tests, one-off scripts) that don't care about tx writes.
   *   - same tx_id already exists for today — daily-granularity idempotence,
   *     so overlapping cron ticks / restarts don't double-count a probe. */
  private async dualWriteProbeTx(endpoint: ServiceEndpoint, healthy: boolean): Promise<void> {
    if (this.dualWriteMode === 'off') return;
    if (!this.txRepo) return;
    if (!endpoint.agent_hash) return;

    // Purge-safe: the stale-sweep may remove an `agents` row whose
    // `public_key_hash` is still referenced by a `service_endpoints.agent_hash`.
    // Without this guard the legacy INSERT throws `FOREIGN KEY constraint failed`
    // (sender_hash → agents.public_key_hash), which is caught below but costs a
    // roundtrip per probe and pollutes logs on every cycle. Skip silently
    // when the operator is gone; observed on `l402.lndyn.com/*`, `satring.com/*`.
    if (this.agentRepo && !(await this.agentRepo.findByHash(endpoint.agent_hash))) {
      logger.warn(
        { url: endpoint.url, agent_hash: endpoint.agent_hash },
        'Probe dual-write skipped — endpoint.agent_hash references purged agent',
      );
      return;
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const bucket = windowBucket(timestamp);
      const canonical = canonicalizeUrl(endpoint.url);
      const txId = sha256(`probe:${canonical}:${bucket}`);

      if (await this.txRepo.findById(txId)) return;

      const tx: Transaction = {
        tx_id: txId,
        sender_hash: endpoint.agent_hash,
        receiver_hash: endpoint.agent_hash,
        amount_bucket: 'micro',
        timestamp,
        payment_hash: sha256(`${txId}:ph`),
        preimage: null,
        status: healthy ? 'verified' : 'failed',
        protocol: 'l402',
      };

      const enrichment: DualWriteEnrichment = {
        endpoint_hash: endpointHash(endpoint.url),
        operator_id: endpoint.agent_hash,
        source: 'probe',
        window_bucket: bucket,
      };

      await this.txRepo.insertWithDualWrite(tx, enrichment, this.dualWriteMode, 'serviceProbes', this.dualWriteLogger);
    } catch (err) {
      // One malformed URL or DB hiccup must not abort the health probe loop.
      // The legacy service_endpoints row was already persisted above.
      logger.error(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Probe dual-write failed',
      );
    }
  }
}
