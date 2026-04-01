// HTTP client for the Observer Protocol API
// Handles retries with exponential backoff and timeouts
import { logger } from '../logger';
import type { ObserverClient, ObserverHealthResponse, ObserverTransactionsResponse } from './types';

const DEFAULT_BASE_URL = 'https://api.observerprotocol.org';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export interface ObserverClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class HttpObserverClient implements ObserverClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: ObserverClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
  }

  async fetchHealth(): Promise<ObserverHealthResponse> {
    return this.request<ObserverHealthResponse>('/api/v1/health');
  }

  async fetchTransactions(): Promise<ObserverTransactionsResponse> {
    return this.request<ObserverTransactionsResponse>('/observer/transactions');
  }

  // HTTP request with retry and exponential backoff
  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ url, attempt, delayMs: delay }, 'Retrying after failure');
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

        const data = await response.json() as T;
        return data;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.error({ url, attempt, error: lastError.message }, 'Observer Protocol request error');
      }
    }

    throw new Error(`Failed after ${this.maxRetries + 1} attempts: ${lastError?.message}`);
  }
}
