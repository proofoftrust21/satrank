// HTTP client for the LightningNetwork.plus API
// Rate limited to 1 request/sec to respect the service
import { z } from 'zod';
import { logger } from '../logger';

const DEFAULT_BASE_URL = 'https://lightningnetwork.plus/api/2';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 1;
const RATE_LIMIT_MS = 1000; // 1 req/sec

// Zod schema for LN+ API response validation — also used in tests
export const lnplusResponseSchema = z.object({
  lnp_rank: z.coerce.number().int().min(0).max(10).default(0),
  lnp_rank_name: z.string().default(''),
  lnp_positive_ratings_received: z.coerce.number().int().min(0).nullable().default(null),
  lnp_negative_ratings_received: z.coerce.number().int().min(0).nullable().default(null),
  hubness_rank: z.coerce.number().int().min(0).default(0),
  betweenness_rank: z.coerce.number().int().min(0).default(0),
  hopness_rank: z.coerce.number().int().min(0).default(0),
}).strip();

export interface LnplusNodeInfo {
  positive_ratings: number | null;
  negative_ratings: number | null;
  lnp_rank: number;
  lnp_rank_name: string;
  hubness_rank: number;
  betweenness_rank: number;
  hopness_rank: number;
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

    const url = `${this.baseUrl}/get_node?pubkey=${encodeURIComponent(pubkey)}`;

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

        const raw = await response.json();
        const parsed = lnplusResponseSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ url, errors: parsed.error.issues.map(i => i.message) }, 'LN+ response validation failed');
          return null;
        }
        const data = parsed.data;

        return {
          positive_ratings: data.lnp_positive_ratings_received,
          negative_ratings: data.lnp_negative_ratings_received,
          lnp_rank: data.lnp_rank,
          lnp_rank_name: data.lnp_rank_name,
          hubness_rank: data.hubness_rank,
          betweenness_rank: data.betweenness_rank,
          hopness_rank: data.hopness_rank,
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
