// HTTP client for the LightningNetwork.plus API
// Rate limited to 1 request/sec to respect the service
import { logger } from '../logger';

const DEFAULT_BASE_URL = 'https://lightningnetwork.plus/api/2';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 1;
const RATE_LIMIT_MS = 1000; // 1 req/sec

export interface LnplusNodeInfo {
  positive_ratings_count: number;
  negative_ratings_count: number;
  lnplus_rank_number: number;
  lnplus_rank_name: string;
}

export interface LnplusClient {
  fetchNodeInfo(pubkey: string): Promise<LnplusNodeInfo | null>;
}

export class HttpLnplusClient implements LnplusClient {
  private baseUrl: string;
  private timeoutMs: number;
  private lastRequestAt = 0;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchNodeInfo(pubkey: string): Promise<LnplusNodeInfo | null> {
    await this.rateLimit();

    const url = `${this.baseUrl}/get_node_info/${pubkey}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json', 'User-Agent': 'SatRank-Crawler/0.1' },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.status === 404) {
          return null; // Node not found on LN+
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as Record<string, unknown>;

        return {
          positive_ratings_count: Number(data.positive_ratings_count ?? 0),
          negative_ratings_count: Number(data.negative_ratings_count ?? 0),
          lnplus_rank_number: Number(data.lnplus_rank_number ?? 0),
          lnplus_rank_name: String(data.lnplus_rank_name ?? ''),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ url, attempt, error: msg }, 'LN+ request error');
        if (attempt === MAX_RETRIES) return null;
      }
    }

    return null;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
