// Paid probe crawler -- pays L402 endpoints 1 sat to verify they deliver
// a valid response. Detects scams (encaisse but returns nothing).
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { ServiceProbeRepository } from '../repositories/serviceProbeRepository';
import type { LndGraphClient } from './lndGraphClient';
import { config } from '../config';

const FETCH_TIMEOUT_MS = 10_000;
const CONSECUTIVE_FAILURE_LIMIT = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 3_600_000; // 1 hour

export class PaidProbeCrawler {
  private consecutiveFailures = 0;
  private disabledUntil = 0;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private serviceProbeRepo: ServiceProbeRepository,
    private lndClient: LndGraphClient,
  ) {}

  async run(): Promise<{ probed: number; verified: number; scam: number; errors: number }> {
    const result = { probed: 0, verified: 0, scam: 0, errors: 0 };

    if (!config.PAID_PROBE_ENABLED) {
      logger.info('Paid probe crawler disabled (PAID_PROBE_ENABLED=false)');
      return result;
    }

    if (Date.now() < this.disabledUntil) {
      logger.warn({ disabledUntilMs: this.disabledUntil }, 'Paid probe circuit breaker active -- skipping');
      return result;
    }

    const now = Math.floor(Date.now() / 1000);
    const dailyCount = this.serviceProbeRepo.countSince(now - 86400);
    if (dailyCount >= config.PAID_PROBE_MAX_PER_DAY) {
      logger.info({ dailyCount, max: config.PAID_PROBE_MAX_PER_DAY }, 'Daily paid probe budget exhausted');
      return result;
    }

    // Hot endpoints: URLs in service_endpoints that were health-checked recently
    // and haven't been paid-probed in 24h
    const candidates = this.serviceEndpointRepo.findStale(1, 0, 200)
      .filter(ep => {
        const latestProbe = this.serviceProbeRepo.findLatest(ep.url);
        return !latestProbe || (now - latestProbe.probed_at) > 86400;
      })
      .slice(0, config.PAID_PROBE_MAX_PER_DAY - dailyCount);

    for (const ep of candidates) {
      try {
        await this.probeEndpoint(ep.url, ep.agent_hash);
        result.probed++;
        this.consecutiveFailures = 0;
      } catch (err: unknown) {
        result.errors++;
        this.consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ url: ep.url, error: msg, consecutiveFailures: this.consecutiveFailures }, 'Paid probe failed');

        if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          this.disabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
          logger.error({ cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS }, 'Paid probe circuit breaker triggered -- disabling for 1h');
          break;
        }
      }
    }

    // Count results from this run
    for (const ep of candidates.slice(0, result.probed)) {
      const probe = this.serviceProbeRepo.findLatest(ep.url);
      if (probe?.body_valid) result.verified++;
      else if (probe && !probe.body_valid && probe.paid_sats > 0) result.scam++;
    }

    logger.info(result, 'Paid probe crawl complete');
    return result;
  }

  private async probeEndpoint(url: string, agentHash: string | null): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Step 1: GET the URL to trigger 402
    const resp402 = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0' }, // blend in
    });

    if (resp402.status !== 402) {
      // Not an L402 endpoint
      this.serviceProbeRepo.insert({
        url, agent_hash: agentHash, probed_at: now, paid_sats: 0,
        payment_hash: null, http_status: resp402.status,
        body_valid: resp402.status >= 200 && resp402.status < 300 ? 1 : 0,
        response_latency_ms: null, error: 'not_l402',
      });
      return;
    }

    // Step 2: Extract invoice from WWW-Authenticate
    const wwwAuth = resp402.headers.get('www-authenticate') ?? '';
    const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
    const macaroonMatch = wwwAuth.match(/macaroon="([A-Za-z0-9+/=]+)"/);
    if (!invoiceMatch || !macaroonMatch) {
      this.serviceProbeRepo.insert({
        url, agent_hash: agentHash, probed_at: now, paid_sats: 0,
        payment_hash: null, http_status: 402, body_valid: 0,
        response_latency_ms: null, error: 'no_invoice_in_402',
      });
      return;
    }

    const invoice = invoiceMatch[1];
    const macaroon = macaroonMatch[1];

    // Step 3: Decode invoice and check amount
    if (!this.lndClient.decodePayReq) {
      this.serviceProbeRepo.insert({
        url, agent_hash: agentHash, probed_at: now, paid_sats: 0,
        payment_hash: null, http_status: 402, body_valid: 0,
        response_latency_ms: null, error: 'no_decode_available',
      });
      return;
    }

    const decoded = await this.lndClient.decodePayReq(invoice);
    if (!decoded) {
      this.serviceProbeRepo.insert({
        url, agent_hash: agentHash, probed_at: now, paid_sats: 0,
        payment_hash: null, http_status: 402, body_valid: 0,
        response_latency_ms: null, error: 'decode_failed',
      });
      return;
    }

    // Safety: don't pay more than MAX_SATS
    // Note: amount must be extracted from decoded invoice in production
    // For now, we trust the config and skip invoices we can't verify

    // Step 4: Pay the invoice via LND
    // This is the most critical part -- spending real sats
    // Implementation deferred: payInvoice not yet in LndGraphClient
    // For now, record as 'payment_deferred'
    this.serviceProbeRepo.insert({
      url, agent_hash: agentHash, probed_at: now, paid_sats: 0,
      payment_hash: null, http_status: 402, body_valid: 0,
      response_latency_ms: null, error: 'payment_deferred',
    });
  }
}
