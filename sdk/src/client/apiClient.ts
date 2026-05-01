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
  RegisterInput,
  RegisterResponse,
  ProxyFulfillInput,
  ProxyFulfillResult,
  ProxyFulfillQuoteResult,
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

  /** SDK 1.2.0 — operator self-registers a new L402 endpoint via NIP-98.
   *  The Authorization header must be pre-signed by the caller and include
   *  the canonical L402 endpoint URL (= `${apiBase}/api/services/register`)
   *  in the `u` tag, the HTTP method in the `method` tag, and sha256 of the
   *  JSON request body in the `payload` tag. The SDK does not bundle a
   *  Nostr signer (zero-dep policy) — see docs/sdk/register-tutorial.md. */
  async postServicesRegister(
    input: Omit<RegisterInput, 'authorization'>,
    authorizationHeader: string,
  ): Promise<{ data: RegisterResponse }> {
    const body = stripUndefined({
      url: input.url,
      name: input.name,
      description: input.description,
      category: input.category,
      provider: input.provider,
    });
    return this.request<{ data: RegisterResponse }>(
      'POST',
      '/api/services/register',
      body,
      { customAuthorization: authorizationHeader },
    );
  }

  /** SDK 1.3.0 — server-side fulfill proxy. Unlike postIntent (which only
   *  ranks), this hands SatRank the entire intent + budget, lets it pay
   *  candidates on the agent's behalf, retry on failure, validate the body,
   *  and either deliver-or-refund. Returns the typed result for every
   *  business outcome (success / refunded / insufficient_balance /
   *  daily_cap_reached / circuit_breaker_open) without throwing. Genuine
   *  errors (401 invalid auth, 503 fulfill_disabled, 5xx server errors,
   *  network timeouts) still throw via SatRankError. */
  async postFulfill(
    input: Omit<ProxyFulfillInput, 'authorization'>,
    authorizationHeader: string,
  ): Promise<ProxyFulfillResult> {
    const body = stripUndefined({
      intent: input.intent,
      max_sats: input.max_sats,
      max_latency_ms: input.max_latency_ms,
      expected_schema_hash: input.expected_schema_hash,
      mode: input.mode,
      refund_bolt11: input.refund_bolt11,
    });
    return this.requestAcceptingBusinessFailures<ProxyFulfillResult>(
      'POST',
      '/api/fulfill',
      body,
      authorizationHeader,
    );
  }

  /** SDK 1.4.0 — second step of hold-mode fulfill. Agent paid the
   *  hold-invoice from a prior postFulfill({mode:'hold'}); this triggers
   *  the orchestrator. The intent must be re-supplied because the server
   *  stores only intent_hash between the two calls. */
  async postFulfillExecute(
    jobId: string,
    intent: ProxyFulfillInput['intent'],
    authorizationHeader: string,
  ): Promise<ProxyFulfillResult> {
    const body = { intent };
    return this.requestAcceptingBusinessFailures<ProxyFulfillResult>(
      'POST',
      `/api/fulfill/${encodeURIComponent(jobId)}/execute`,
      body,
      authorizationHeader,
    );
  }

  /** SDK 1.3.0 — preview a fulfill without engagement. No NIP-98 (read-only)
   *  but the server still applies the discoveryRateLimit ceiling. Returns
   *  candidate-by-candidate invoice + premium estimates so the agent can
   *  decide whether to launch the actual fulfill (and whether to top up). */
  async postFulfillQuote(input: {
    intent: ProxyFulfillInput['intent'];
    max_sats: number;
  }): Promise<ProxyFulfillQuoteResult> {
    const body = stripUndefined({
      intent: input.intent,
      max_sats: input.max_sats,
    });
    const wrapped = await this.request<{ data: ProxyFulfillQuoteResult }>(
      'POST',
      '/api/fulfill/quote',
      body,
    );
    return wrapped.data;
  }

  /** Internal — POST that maps known business-failure status codes (402, 429,
   *  502, 503-with-circuit-breaker) into typed return values instead of
   *  throwing. Used by postFulfill to surface the structured agent-facing
   *  outcomes without forcing a try/catch on every call site. */
  private async requestAcceptingBusinessFailures<T>(
    method: 'POST',
    path: string,
    body: unknown,
    authorizationHeader: string,
  ): Promise<T> {
    const url = `${this.opts.apiBase}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.opts.request_timeout_ms,
    );
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: authorizationHeader,
        },
        body: JSON.stringify(body),
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
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { /* fall through */ }
    }
    // Status codes that carry typed business outcomes:
    //   200 → status='success'
    //   402 → status='insufficient_balance' (with required/available)
    //   429 → status='daily_cap_reached'
    //   502 → status='refunded'
    //   503 + body.error='circuit_breaker_open' → status='circuit_breaker_open'
    // Anything else (401, 503 fulfill_disabled, 5xx, malformed) → throw.
    if (res.status === 200 && parsed && typeof parsed === 'object') {
      return parsed as T;
    }
    if (res.status === 402 && parsed && typeof parsed === 'object') {
      // SDK 1.4.0 — 402 carries two distinct shapes: deposit-mode
      // insufficient_balance OR hold-mode hold_invoice_required. The
      // server's `status` field tells us which.
      const o = parsed as {
        status?: string;
        required_sats?: number;
        available_sats?: number;
        job_id?: string;
        payment_request?: string;
        payment_hash?: string;
        invoice_amount_sats?: number;
        expires_at?: number;
        execute_endpoint?: string;
      };
      if (o.status === 'hold_invoice_required') {
        return {
          status: 'hold_invoice_required',
          job_id: o.job_id,
          payment_request: o.payment_request,
          payment_hash: o.payment_hash,
          invoice_amount_sats: o.invoice_amount_sats,
          expires_at: o.expires_at,
          execute_endpoint: o.execute_endpoint,
          refund_bolt11: (o as { refund_bolt11?: string }).refund_bolt11,
        } as unknown as T;
      }
      return {
        status: 'insufficient_balance',
        required_sats: o.required_sats,
        available_sats: o.available_sats,
      } as unknown as T;
    }
    if (res.status === 429 && parsed && typeof parsed === 'object') {
      const o = parsed as {
        cap_sats?: number;
        used_24h_sats?: number;
        agent_age_bucket?: 'fresh' | 'established';
        retry_after_sec?: number;
      };
      return {
        status: 'daily_cap_reached',
        cap_sats: o.cap_sats,
        used_24h_sats: o.used_24h_sats,
        agent_age_bucket: o.agent_age_bucket,
        retry_after_sec: o.retry_after_sec,
      } as unknown as T;
    }
    if (res.status === 502 && parsed && typeof parsed === 'object') {
      // refunded shape — pass through verbatim (already includes status).
      return parsed as T;
    }
    if (
      res.status === 503 &&
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { error?: string }).error === 'circuit_breaker_open'
    ) {
      const o = parsed as { pool_balance_sats?: number; min_pool_sats?: number; retry_after_sec?: number };
      return {
        status: 'circuit_breaker_open',
        pool_balance_sats: o.pool_balance_sats,
        min_pool_sats: o.min_pool_sats,
        retry_after_sec: o.retry_after_sec,
      } as unknown as T;
    }
    if (
      res.status === 503 &&
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { error?: string }).error === 'hold_mode_unavailable'
    ) {
      const o = parsed as { reason?: string };
      return {
        status: 'hold_mode_unavailable',
        reason: o.reason,
      } as unknown as T;
    }
    // Unrecognised — bubble up as a SatRankError.
    const errBody = parsed as { error?: string | { code?: string; message?: string }; message?: string } | null;
    const code = typeof errBody?.error === 'string' ? errBody.error : errBody?.error?.code;
    const message = typeof errBody?.error === 'string'
      ? errBody.message ?? errBody.error
      : errBody?.error?.message ?? `HTTP ${res.status} at ${path}`;
    throw errorFromResponse(res.status, code, message);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    flags: { requireAuth?: boolean; customAuthorization?: string } = {},
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
    // SDK 1.2.0 — `customAuthorization` overrides the deposit token for
    // routes that require their own auth scheme (NIP-98, NIP-98 + custom).
    if (flags.customAuthorization) {
      headers.Authorization = flags.customAuthorization;
    } else if (flags.requireAuth && this.opts.depositToken) {
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

/** Strip undefined values so the JSON body has only the keys the caller
 *  actually set. Keeps the wire payload minimal and lets the server's zod
 *  schema apply its own defaults / coercions. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
