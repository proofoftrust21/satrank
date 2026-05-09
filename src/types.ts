// SatRank V3 — shared types.
//
// Five concepts. That's it.

/** A 5-stage decomposition of an L402 transaction lifecycle.
 *  Each stage has a Beta(α,β) posterior maintained over the endpoint's history. */
export type Stage = 'challenge' | 'invoice' | 'payment' | 'delivery' | 'quality';

export const STAGES: ReadonlyArray<Stage> = ['challenge', 'invoice', 'payment', 'delivery', 'quality'];

/** Beta(α,β) posterior with derived stats. */
export interface Posterior {
  alpha: number;
  beta: number;
  /** Mean of the Beta distribution: α / (α+β). */
  mean: number;
  /** 95% credible interval, computed via the Beta inverse-CDF approximation. */
  ci95: readonly [number, number];
  /** Total observations (α + β − priors). Below `meaningful_n` the score is mostly prior. */
  n: number;
}

/** Bayesian score for an endpoint: per-stage posteriors + end-to-end product. */
export interface EndpointScore {
  url: string;
  url_hash: string;
  category: string;
  stages: Record<Stage, Posterior>;
  /** Product of stage means, the end-to-end probability of full success. */
  p_e2e: number;
  /** Total observations across all stages (max). */
  n_obs: number;
  /** True iff every meaningful_n threshold is crossed (default 3). */
  is_meaningful: boolean;
  median_latency_ms: number | null;
  last_probe_at: number | null;
  price_sats: number;
}

/** A single observation produced by a probe (paid or unpaid). */
export interface Observation {
  url_hash: string;
  observed_at: number;
  challenge_ok: boolean;
  invoice_ok: boolean;
  payment_ok: boolean | null;
  delivery_ok: boolean | null;
  quality_ok: boolean | null;
  latency_ms: number;
  http_status: number | null;
  /** sha256 of response body when delivery_ok ; helps audit. */
  body_sha256: string | null;
}

/** Catalogue row. The crawler upserts these. */
export interface Endpoint {
  url: string;
  url_hash: string;
  /** Primary display category (= category_tags[0]). */
  category: string;
  /** Full multi-category set this endpoint is listed under. /api/intent
   *  filters by `req.category = ANY(category_tags)` so a service tagged
   *  ['video','streaming','content'] surfaces for any of those queries. */
  category_tags: string[];
  name: string;
  description: string;
  http_method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  price_sats: number;
  source: string;
  added_at: number;
}

/** /api/intent request body. */
export interface IntentRequest {
  category: string;
  keywords?: string[];
  budget_sats?: number;
  max_latency_ms?: number;
  optimize?: 'p_success' | 'latency' | 'cost';
  limit?: number;
}

/** /api/intent response candidate. */
export interface IntentCandidate {
  url: string;
  url_hash: string;
  category: string;
  name: string;
  description: string;
  http_method: string;
  price_sats: number;
  bayesian: { p_success: number; ci95: [number, number]; n_obs: number };
  stages: Record<Stage, { p_success: number; ci95: [number, number]; n: number }>;
  median_latency_ms: number | null;
  is_meaningful: boolean;
}
