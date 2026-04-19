// sr.fulfill() — the single-call API for agents: "pay a category of service,
// under a budget, within a deadline". Wraps the full L402 flow:
//
//   1. POST /api/intent → candidates
//   2. For each candidate, in rank order:
//      a. GET/POST the endpoint (unauthenticated)
//      b. If 402: parse WWW-Authenticate → token + BOLT11 invoice
//      c. Decode invoice amount, check against remaining budget
//      d. wallet.payInvoice(bolt11, max_fee_sats)
//      e. Retry with Authorization: L402 <token>:<preimage>
//      f. Return body + preimage on 2xx
//   3. Optionally POST /api/report (C7 — reserved here, wired later).
//
// Mechanical budget enforcement: if a candidate invoice would exceed the
// remaining budget, we abort that candidate without paying it. The wallet's
// own fee cap (max_fee_sats) is orthogonal — it bounds the routing fee, not
// the invoice amount.

import { decodeBolt11Amount } from './bolt11';
import { SatRankError, TimeoutError, WalletError } from './errors';
import type { ApiClient } from './client/apiClient';
import type {
  CandidateAttempt,
  FulfillOptions,
  FulfillRequest,
  FulfillResult,
  IntentCandidate,
  Wallet,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FEE_SATS = 10;
const DEFAULT_LIMIT = 5;

export interface FulfillCtx {
  api: ApiClient;
  wallet?: Wallet;
  fetchImpl: typeof fetch;
  defaultCaller?: string;
}

export async function fulfillIntent(
  ctx: FulfillCtx,
  opts: FulfillOptions,
): Promise<FulfillResult> {
  validateFulfillOptions(opts);

  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxFeeSats = opts.max_fee_sats ?? DEFAULT_MAX_FEE_SATS;
  const retryPolicy = opts.retry_policy ?? 'next_candidate';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const caller = opts.caller ?? ctx.defaultCaller;

  const startedAt = Date.now();
  const deadline = startedAt + timeout_ms;

  const tried: CandidateAttempt[] = [];
  let spent = 0;

  let intentResult;
  try {
    intentResult = await ctx.api.postIntent({
      category: opts.intent.category,
      keywords: opts.intent.keywords,
      budget_sats: opts.intent.budget_sats ?? opts.budget_sats,
      max_latency_ms: opts.intent.max_latency_ms,
      caller,
      limit,
    });
  } catch (err) {
    return failure(
      tried,
      0,
      err instanceof SatRankError ? err.code : 'INTENT_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (intentResult.candidates.length === 0) {
    return failure(
      tried,
      0,
      'NO_CANDIDATES',
      `No candidates for category "${opts.intent.category}"`,
    );
  }

  for (const candidate of intentResult.candidates) {
    const remainingBudget = opts.budget_sats - spent;
    const remainingTime = deadline - Date.now();

    if (remainingTime <= 0) {
      tried.push({
        url: candidate.endpoint_url,
        verdict: candidate.bayesian.verdict,
        outcome: 'abort_timeout',
      });
      break;
    }
    if (remainingBudget <= 0) {
      tried.push({
        url: candidate.endpoint_url,
        verdict: candidate.bayesian.verdict,
        outcome: 'abort_budget',
      });
      break;
    }

    const attempt = await attemptCandidate(
      ctx,
      candidate,
      opts.request,
      maxFeeSats,
      remainingBudget,
      remainingTime,
    );
    tried.push(attempt.summary);
    spent += attempt.summary.cost_sats ?? 0;

    if (attempt.summary.outcome === 'paid_success') {
      return {
        success: true,
        response_body: attempt.body,
        response_code: attempt.summary.response_code,
        response_latency_ms: Date.now() - startedAt,
        cost_sats: spent,
        preimage: attempt.preimage,
        endpoint_used: {
          url: candidate.endpoint_url,
          service_name: candidate.service_name,
          operator_pubkey: candidate.operator_pubkey,
        },
        candidates_tried: tried,
      };
    }

    // C6: honor retry_policy='none' — stop after the first attempt regardless
    // of outcome.
    if (retryPolicy === 'none') break;
  }

  const lastOutcome = tried[tried.length - 1]?.outcome ?? 'NO_CANDIDATES';
  return failure(
    tried,
    spent,
    lastOutcome.toString().toUpperCase(),
    `All ${tried.length} candidates failed`,
  );
}

interface AttemptInternal {
  summary: CandidateAttempt;
  body?: unknown;
  preimage?: string;
}

async function attemptCandidate(
  ctx: FulfillCtx,
  candidate: IntentCandidate,
  request: FulfillRequest | undefined,
  maxFeeSats: number,
  remainingBudget: number,
  remainingTime: number,
): Promise<AttemptInternal> {
  const base = {
    url: candidate.endpoint_url,
    verdict: candidate.bayesian.verdict,
  };

  // Pre-check — if the registry-advertised price is already over budget,
  // don't even bother hitting the endpoint.
  if (
    candidate.price_sats !== null &&
    candidate.price_sats > remainingBudget
  ) {
    return {
      summary: { ...base, outcome: 'abort_budget', cost_sats: 0 },
    };
  }

  let firstRes: Response;
  try {
    firstRes = await httpCall(
      ctx.fetchImpl,
      candidate.endpoint_url,
      request,
      remainingTime,
    );
  } catch (err) {
    return {
      summary: {
        ...base,
        outcome: err instanceof TimeoutError ? 'abort_timeout' : 'network_error',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (firstRes.status !== 402) {
    // Non-priced endpoint: if 2xx, treat as free success. Everything else
    // counts as a network_error (we never paid).
    if (firstRes.ok) {
      const body = await safeJson(firstRes);
      return {
        summary: {
          ...base,
          outcome: 'paid_success',
          cost_sats: 0,
          response_code: firstRes.status,
        },
        body,
      };
    }
    return {
      summary: {
        ...base,
        outcome: 'network_error',
        response_code: firstRes.status,
      },
    };
  }

  const wwwAuth = firstRes.headers.get('WWW-Authenticate') ?? '';
  const challenge = parseL402Challenge(wwwAuth);
  if (!challenge) {
    return {
      summary: { ...base, outcome: 'no_invoice', response_code: 402 },
    };
  }

  const invoiceAmount = decodeBolt11Amount(challenge.invoice);
  if (invoiceAmount !== null && invoiceAmount > remainingBudget) {
    return { summary: { ...base, outcome: 'abort_budget', cost_sats: 0 } };
  }

  if (!ctx.wallet) {
    return {
      summary: {
        ...base,
        outcome: 'pay_failed',
        error: 'no wallet configured (pass options.wallet)',
      },
    };
  }

  let pay: { preimage: string; feePaidSats: number };
  try {
    pay = await ctx.wallet.payInvoice(challenge.invoice, maxFeeSats);
  } catch (err) {
    return {
      summary: {
        ...base,
        outcome: 'pay_failed',
        error:
          err instanceof WalletError
            ? err.code
            : err instanceof Error
              ? err.message
              : String(err),
      },
    };
  }

  const paidSats = (invoiceAmount ?? 0) + pay.feePaidSats;
  const remainingAfterPay = remainingTime - (Date.now() - Date.now()); // keep timer simple
  void remainingAfterPay;

  let secondRes: Response;
  try {
    secondRes = await httpCall(
      ctx.fetchImpl,
      candidate.endpoint_url,
      request,
      remainingTime,
      `L402 ${challenge.token}:${pay.preimage}`,
    );
  } catch (err) {
    return {
      summary: {
        ...base,
        outcome: 'paid_failure',
        cost_sats: paidSats,
        error: err instanceof Error ? err.message : String(err),
      },
      preimage: pay.preimage,
    };
  }

  if (secondRes.ok) {
    const body = await safeJson(secondRes);
    return {
      summary: {
        ...base,
        outcome: 'paid_success',
        cost_sats: paidSats,
        response_code: secondRes.status,
      },
      body,
      preimage: pay.preimage,
    };
  }
  return {
    summary: {
      ...base,
      outcome: 'paid_failure',
      cost_sats: paidSats,
      response_code: secondRes.status,
    },
    preimage: pay.preimage,
  };
}

async function httpCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  request: FulfillRequest | undefined,
  timeoutMs: number,
  authHeader?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = request?.method ?? 'GET';
    const url = buildUrl(baseUrl, request?.path, request?.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(request?.headers ?? {}),
    };
    if (authHeader) headers.Authorization = authHeader;
    const body =
      request?.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
    if (body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`Request to ${baseUrl} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(
  base: string,
  path?: string,
  query?: Record<string, string>,
): string {
  let u = base;
  if (path) {
    const trimmedBase = u.replace(/\/$/, '');
    u = trimmedBase + (path.startsWith('/') ? path : `/${path}`);
  }
  if (query && Object.keys(query).length > 0) {
    const q = new URLSearchParams(query).toString();
    u += (u.includes('?') ? '&' : '?') + q;
  }
  return u;
}

async function safeJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

/** Parse a WWW-Authenticate L402/LSAT challenge header.
 *  Accepts both `macaroon="..."` (legacy LSAT) and `token=...` (newer L402). */
export function parseL402Challenge(
  header: string,
): { token: string; invoice: string } | null {
  if (!header) return null;
  const m = /^(?:L402|LSAT)\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const body = m[1];
  const tokenMatch =
    /(?:macaroon|token)\s*=\s*(?:"([^"]+)"|([^,\s]+))/i.exec(body);
  const invoiceMatch = /invoice\s*=\s*(?:"([^"]+)"|([^,\s]+))/i.exec(body);
  if (!tokenMatch || !invoiceMatch) return null;
  return {
    token: (tokenMatch[1] ?? tokenMatch[2]).trim(),
    invoice: (invoiceMatch[1] ?? invoiceMatch[2]).trim(),
  };
}

function validateFulfillOptions(opts: FulfillOptions): void {
  if (!opts || !opts.intent || !opts.intent.category) {
    throw new Error('fulfill: options.intent.category is required');
  }
  if (typeof opts.budget_sats !== 'number' || opts.budget_sats <= 0) {
    throw new Error('fulfill: options.budget_sats must be > 0');
  }
}

function failure(
  tried: CandidateAttempt[],
  spent: number,
  code: string,
  message: string,
): FulfillResult {
  return {
    success: false,
    cost_sats: spent,
    candidates_tried: tried,
    error: { code, message },
  };
}
