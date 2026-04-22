// Public types for @satrank/sdk 1.0. Mirrors the shape of POST /api/intent
// on the server side — snake_case kept on the wire, exposed in this SDK as
// typed TS interfaces so agents get end-to-end static typing on fulfill().

/** Input intent an agent hands to the SDK. Only `category` is required; the
 *  rest narrow the candidate pool. */
export interface Intent {
  category: string;
  keywords?: string[];
  budget_sats?: number;
  max_latency_ms?: number;
}

export interface BayesianBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  verdict: 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';
  risk_profile: 'low' | 'medium' | 'high' | 'unknown';
  time_constant_days: number;
  last_update: number;
  sources?: {
    probe: unknown | null;
    report: unknown | null;
    paid: unknown | null;
  };
  convergence?: {
    converged: boolean;
    sources_above_threshold: string[];
    threshold: number;
  };
  recent_activity?: {
    last_24h: number;
    last_7d: number;
    last_30d: number;
  };
}

export interface AdvisoryBlock {
  advisory_level: 'green' | 'yellow' | 'orange' | 'red';
  risk_score: number;
  recommendation: 'proceed' | 'proceed_with_caution' | 'consider_alternative' | 'avoid';
  advisories: Array<{
    code: string;
    level: 'info' | 'warning' | 'critical';
    msg: string;
    signal_strength: number;
    data?: Record<string, unknown>;
  }>;
}

export interface HealthBlock {
  reachability: number | null;
  http_health_score: number | null;
  health_freshness: number | null;
  last_probe_age_sec: number | null;
}

/** Candidate endpoint as returned by /api/intent. snake_case preserved so
 *  the JSON round-trips cleanly. */
export interface IntentCandidate {
  rank: number;
  endpoint_url: string;
  endpoint_hash: string;
  operator_pubkey: string;
  service_name: string | null;
  price_sats: number | null;
  median_latency_ms: number | null;
  bayesian: BayesianBlock;
  advisory: AdvisoryBlock;
  health: HealthBlock;
}

export interface IntentResponseMeta {
  total_matched: number;
  returned: number;
  strictness: 'strict' | 'relaxed' | 'degraded';
  warnings: string[];
}

export interface ResolvedIntent extends Intent {
  resolved_at: number;
}

export interface IntentResponse {
  intent: ResolvedIntent;
  candidates: IntentCandidate[];
  meta: IntentResponseMeta;
}

export interface IntentCategory {
  name: string;
  endpoint_count: number;
  active_count: number;
}

export interface IntentCategoriesResponse {
  categories: IntentCategory[];
}

/** Wallet driver contract — implemented by LndWallet, NwcWallet, LnurlWallet.
 *  Intentionally narrow: the SDK only needs "pay this invoice" + liveness. */
export interface Wallet {
  /** Pay a BOLT11 invoice, capping fees. Returns the preimage on success. */
  payInvoice(
    bolt11: string,
    maxFeeSats: number,
  ): Promise<{ preimage: string; feePaidSats: number }>;
  /** Cheap liveness check — used to fail fast before a fulfill() attempt. */
  isAvailable(): Promise<boolean>;
}

/** Optional request shaping for the downstream service call. Defaults to
 *  `GET <endpoint_url>` with no body. fulfill() doesn't know the agent's
 *  use case; this lets them pass method/body/headers through. */
export interface FulfillRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path segment appended to the candidate endpoint_url (rarely needed — the
   *  /api/intent response already points at the exact URL). */
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Arguments to sr.fulfill(). Only `intent` and `budget_sats` are required. */
export interface FulfillOptions {
  intent: Intent;
  /** Hard cap on total sats the SDK is allowed to spend across all attempts.
   *  Any individual BOLT11 exceeding the remaining budget aborts that candidate
   *  without paying it. */
  budget_sats: number;
  /** Wall-clock cap (ms) — when exceeded, no new candidate is attempted. */
  timeout_ms?: number;
  /** Whether to try the next candidate if the current one fails. */
  retry_policy?: 'next_candidate' | 'none';
  /** Auto-submit outcome to /api/report (anonymous report). Default true. */
  auto_report?: boolean;
  /** Pass-through to /api/intent — snake_case agent identifier. */
  caller?: string;
  /** Max candidates returned by /api/intent (default 5, max 20 server-side). */
  limit?: number;
  /** Shape the outbound request to the downstream service. */
  request?: FulfillRequest;
  /** Per-candidate fee cap handed to Wallet.payInvoice. Default 10 sats. */
  max_fee_sats?: number;
}

/** Outcome classification for a single candidate attempt. */
export type CandidateOutcome =
  | 'paid_success' // BOLT11 paid and service responded 2xx
  | 'paid_failure' // BOLT11 paid but service returned 4xx/5xx
  | 'skipped' // retry_policy=none and a prior candidate already fulfilled
  | 'abort_budget' // BOLT11 amount would exceed remaining budget
  | 'abort_timeout' // wall-clock timeout reached before attempt
  | 'pay_failed' // wallet rejected the invoice (no route / no funds / etc.)
  | 'no_invoice' // candidate didn't return a 402+BOLT11 flow
  | 'network_error'; // transport-level failure before 402

export interface CandidateAttempt {
  url: string;
  verdict: string;
  outcome: CandidateOutcome;
  cost_sats?: number;
  response_code?: number;
  error?: string;
}

export interface FulfillErrorShape {
  code: string;
  message: string;
}

export interface FulfillResult {
  success: boolean;
  response_body?: unknown;
  response_code?: number;
  response_latency_ms?: number;
  /** Total sats spent across all attempts. Always ≤ budget_sats. */
  cost_sats: number;
  preimage?: string;
  endpoint_used?: {
    url: string;
    service_name: string | null;
    operator_pubkey: string;
  };
  candidates_tried: CandidateAttempt[];
  report_submitted?: boolean;
  error?: FulfillErrorShape;
}

/** Constructor options for the SatRank client. */
export interface SatRankOptions {
  apiBase: string;
  /** Optional Authorization header value (e.g. "L402 deposit:<preimage>").
   *  Sent with /api/report only — /api/intent is unauthenticated discovery. */
  depositToken?: string;
  /** Wallet driver used to pay candidate invoices during fulfill(). */
  wallet?: Wallet;
  /** Dependency injection point for tests — defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default caller identifier piped into /api/intent logs. */
  caller?: string;
  /** Request timeout for individual API calls (ms). Default 10_000. */
  request_timeout_ms?: number;
}
