// Periodic HTTP health checker for known service endpoints
// Probes URLs in service_endpoints that have been seen >= 3 times
// and haven't been checked in the last 30 minutes.
import { logger } from '../logger';
import { sha256 } from '../utils/crypto';
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { windowBucket } from '../utils/dualWriteLogger';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ServiceEndpoint, ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import type { Transaction } from '../types';

const CHECK_RATE_MS = 200; // 5 checks/sec
const FETCH_TIMEOUT_MS = 3000;

export class ServiceHealthCrawler {
  constructor(
    private repo: ServiceEndpointRepository,
    private txRepo?: TransactionRepository,
    private dualWriteMode: DualWriteMode = 'off',
    private dualWriteLogger?: DualWriteLogger,
    private agentRepo?: AgentRepository,
  ) {}

  async run(): Promise<{ checked: number; healthy: number; down: number }> {
    const result = { checked: 0, healthy: 0, down: 0 };
    const stale = await this.repo.findStale(3, 1800, 500); // >= 3 checks, > 30 min since last

    if (stale.length === 0) return result;
    logger.info({ candidates: stale.length }, 'Service health crawl starting');

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

      result.checked++;
      if (result.checked < stale.length) {
        await new Promise(resolve => setTimeout(resolve, CHECK_RATE_MS));
      }
    }

    logger.info(result, 'Service health crawl complete');
    return result;
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
