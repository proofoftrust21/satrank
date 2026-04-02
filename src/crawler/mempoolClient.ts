// HTTP client for the mempool.space Lightning Network API
import { logger } from '../logger';

const DEFAULT_BASE_URL = 'https://mempool.space';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;

export interface MempoolNode {
  publicKey: string;
  alias: string;
  channels: number;
  capacity: number;
  firstSeen: number;
  updatedAt: number;
  country?: { en: string | null };
  iso_code?: string | null;
}

export interface MempoolClient {
  fetchTopNodes(): Promise<MempoolNode[]>;
}

export interface MempoolClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class HttpMempoolClient implements MempoolClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(options: MempoolClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // mempool.space hardcodes LIMIT 100 server-side with no pagination support.
  // ?page=N is silently ignored — all pages return the same 100 nodes.
  async fetchTopNodes(): Promise<MempoolNode[]> {
    return this.request<MempoolNode[]>('/api/v1/lightning/nodes/rankings/connectivity');
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ url, attempt, delayMs: delay }, 'Retrying mempool.space request');
        await new Promise(resolve => setTimeout(resolve, delay));
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

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json() as T;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.error({ url, attempt, error: lastError.message }, 'mempool.space request error');
      }
    }

    throw new Error(`Failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  }
}
