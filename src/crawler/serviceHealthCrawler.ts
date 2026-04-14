// Periodic HTTP health checker for known service endpoints
// Probes URLs in service_endpoints that have been seen >= 3 times
// and haven't been checked in the last 30 minutes.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

const CHECK_RATE_MS = 200; // 5 checks/sec
const FETCH_TIMEOUT_MS = 3000;

export class ServiceHealthCrawler {
  constructor(private repo: ServiceEndpointRepository) {}

  async run(): Promise<{ checked: number; healthy: number; down: number }> {
    const result = { checked: 0, healthy: 0, down: 0 };
    const stale = this.repo.findStale(3, 1800, 500); // >= 3 checks, > 30 min since last

    if (stale.length === 0) return result;
    logger.info({ candidates: stale.length }, 'Service health crawl starting');

    for (const endpoint of stale) {
      try {
        const start = Date.now();
        const resp = await fetch(endpoint.url, {
          method: 'GET',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'SatRank-HealthCheck/1.0' },
          redirect: 'manual',
        });
        const latencyMs = Date.now() - start;
        this.repo.upsert(endpoint.agent_hash, endpoint.url, resp.status, latencyMs);

        if (resp.status === 402 || (resp.status >= 200 && resp.status < 300)) {
          result.healthy++;
        } else {
          result.down++;
        }
      } catch {
        this.repo.upsert(endpoint.agent_hash, endpoint.url, 0, 0);
        result.down++;
      }

      result.checked++;
      if (result.checked < stale.length) {
        await new Promise(resolve => setTimeout(resolve, CHECK_RATE_MS));
      }
    }

    logger.info(result, 'Service health crawl complete');
    return result;
  }
}
