// Internal HTTP client for the SatRank API. Not exported publicly — the
// SatRank class wraps this with higher-level methods. Kept narrow (four
// endpoints) so the public surface has exactly one entry point per call site.
import {
  errorFromResponse,
  NetworkError,
  SatRankError,
  TimeoutError,
} from '../errors';
import type {
  IntentCategoriesResponse,
  IntentResponse,
  Intent,
} from '../types';

export interface ApiClientOptions {
  apiBase: string;
  fetch: typeof fetch;
  request_timeout_ms: number;
  depositToken?: string;
}

export interface ResolveIntentInput {
  category: string;
  keywords?: string[];
  budget_sats?: number;
  max_latency_ms?: number;
  caller?: string;
  limit?: number;
  /** Mix A+D — when true, the SDK upgrades to the paid /intent path
   *  (2 sats via L402) so the server can synchronously probe the top
   *  candidates before returning. Default: false. */
  fresh?: boolean;
}

export interface ReportInput {
  target: string;
  outcome: 'success' | 'failure' | 'timeout';
  preimage?: string;
  bolt11Raw?: string;
  amountBucket?: 'micro' | 'small' | 'medium' | 'large';
  memo?: string;
}

/** Thin fetch wrapper. Centralises timeout handling + typed error mapping so
 *  downstream code can treat every call as "returns T or throws SatRankError". */
export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  async getIntentCategories(): Promise<IntentCategoriesResponse> {
    return this.request<IntentCategoriesResponse>('GET', '/api/intent/categories');
  }

  async postIntent(input: ResolveIntentInput): Promise<IntentResponse> {
    return this.request<IntentResponse>('POST', '/api/intent', input);
  }

  async postReport(
    input: ReportInput,
  ): Promise<{ data?: unknown; requestId?: string }> {
    return this.request('POST', '/api/report', input, {
      requireAuth: true,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    flags: { requireAuth?: boolean } = {},
  ): Promise<T> {
    const url = `${this.opts.apiBase}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.opts.request_timeout_ms,
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (flags.requireAuth && this.opts.depositToken) {
      headers.Authorization = this.opts.depositToken;
    }

    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(
          `Request to ${path} timed out after ${this.opts.request_timeout_ms}ms`,
        );
      }
      throw new NetworkError(
        `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    return this.parseResponse<T>(res, path);
  }

  private async parseResponse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body — fall through to status-based error mapping.
      }
    }

    if (!res.ok) {
      const errBody = parsed as
        | { error?: { code?: string; message?: string } }
        | null;
      throw errorFromResponse(
        res.status,
        errBody?.error?.code,
        errBody?.error?.message ?? `HTTP ${res.status} at ${path}`,
      );
    }

    if (parsed === null) {
      throw new SatRankError(
        `Empty response body from ${path}`,
        res.status,
        'EMPTY_RESPONSE',
      );
    }
    return parsed as T;
  }
}

// Re-export types so SatRank.ts imports from one module.
export type { Intent };
