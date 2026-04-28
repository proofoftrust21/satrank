// Phase 5 — /api/intent shapes.
//
// Convention distincte du reste de l'API : **snake_case** partout pour amorcer
// la convention cible long terme (cf. D3 du rapport d'enquête Phase 5).
// Les endpoints legacy (/verdict, /decide, /best-route, /services, …) restent
// camelCase — harmonisation différée à Phase 10.

import type { Advisory, AdvisoryLevel, BayesianScoreBlock, Recommendation } from './index';

/** Requête POST /api/intent. Validation zod dans intentController. */
export interface IntentRequest {
  /** Enum dynamique contre findCategories() au moment de la requête. */
  category: string;
  /** Filtre additionnel AND sur endpoint.name / service.name (LIKE NOCASE). */
  keywords?: string[];
  /** Filtre price_sats <= budget_sats. */
  budget_sats?: number;
  /** Filtre median_latency_ms <= max_latency_ms. */
  max_latency_ms?: number;
  /** Libre, tracé dans les logs (pas en DB). */
  caller?: string;
  /** Phase 5.8 — explicit optimization axis. Default `p_success` preserves
   *  the Bayesian probabilistic oracle as the canonical ranking. Agents
   *  with concrete priorities pick a different axis: a trading bot wants
   *  `latency`, a batch processor wants `reliability`, a budget-strict
   *  agent wants `cost`. The empirical case for exposing these as a
   *  switchable parameter (rather than a hand-tuned composite) is in
   *  /tmp/satrank-investigation-second-opinion/strategic-review.md. */
  optimize?: IntentOptimizeAxis;
}

/** Phase 5.8 — supported optimize axes. The default of `p_success` keeps
 *  pre-Phase-5.8 behavior identical for callers that don't pass the field. */
export type IntentOptimizeAxis = 'p_success' | 'latency' | 'reliability' | 'cost';

/** Rendu minimal de l'intention, rejoué dans la réponse pour que l'agent
 *  puisse vérifier ce que le serveur a effectivement résolu. */
export interface ResolvedIntent {
  category: string;
  keywords: string[];
  budget_sats: number | null;
  max_latency_ms: number | null;
  resolved_at: number;
  /** Mix A+D — true when ?fresh=true was honoured (paid path, top-N
   *  synchronously probed). false on free directory reads. */
  fresh: boolean;
  /** Phase 5.8 — echo the optimization axis the server actually applied.
   *  Always present; defaults to 'p_success' when the request omitted it. */
  optimize: IntentOptimizeAxis;
}

/** Mix A+D — bucket exposing how stale the probe behind a candidate is.
 *  Replaces "trust me, it's recent" with an explicit answer agents can act on. */
export type FreshnessStatus = 'fresh' | 'recent' | 'stale' | 'very_stale';

/** Mix A+D — advertised paid upgrade path, attached to free responses only. */
export interface IntentUpgradePath {
  flag: 'fresh=true';
  cost_sats: number;
  message: string;
}

export interface IntentHealthBlock {
  /** Ratio probe reachable/total sur 7j — null si aucun probe. */
  reachability: number | null;
  /** Santé HTTP graduée Phase 4 P6 ∈ [0,1] — null si pas de probe. */
  http_health_score: number | null;
  /** exp(-age/600) — 1 juste après le probe, décroît. null si pas de probe. */
  health_freshness: number | null;
  /** Secondes depuis le dernier probe HTTP — null si pas de probe. */
  last_probe_age_sec: number | null;
}

export interface IntentAdvisoryBlock {
  advisory_level: AdvisoryLevel;
  risk_score: number;
  advisories: Advisory[];
  recommendation: Recommendation;
  /** Mix A+D — explicit staleness bucket derived from `health.last_probe_age_sec`.
   *  Lets agents short-circuit on `very_stale` without reading numeric ages. */
  freshness_status: FreshnessStatus;
}

export interface IntentCandidate {
  rank: number;
  endpoint_url: string;
  endpoint_hash: string;
  /** Pubkey LN (66 chars) du node operator. null si URL orpheline. */
  operator_pubkey: string | null;
  /** Phase 7 — logical operator_id (SatRank operators table) EXPOSÉ uniquement
   *  si l'operator a passé la règle 2/3 preuves (status='verified'). Null si
   *  pas d'operator rattaché, ou si status∈{'pending','rejected'}. Zero auto-trust. */
  operator_id: string | null;
  service_name: string | null;
  /** Prix extrait du BOLT11 — null si inconnu. */
  price_sats: number | null;
  /** Médiane SQL sur service_probes 7j, null si < 3 probes.
   *  Phase 5 — falls back to `service_endpoints.last_latency_ms` (single
   *  most-recent observation) when service_probes has no data. */
  median_latency_ms: number | null;
  /** Phase 5.8 — upstream signals from 402index, surfaced for the new
   *  `optimize=` parameter. The strategic review verified these signals
   *  carry real per-endpoint variance (reliability_score has 24 distinct
   *  values, stddev 19.5; uptime_30d 17 distinct, stddev 0.3) yet were
   *  invisible to consumers. Omitted when null. */
  reliability_score?: number;
  uptime_30d?: number;
  /** Phase 5 — multi-source attribution exposed to consumers. Field is
   *  omitted when the row has no source attribution beyond the legacy scalar
   *  `source` column; populated when Phase 3's `service_endpoints.sources[]`
   *  contains more than one source. Lets an agent see at a glance whether a
   *  candidate is cross-listed (e.g. ['402index','l402directory']) vs
   *  single-sourced. */
  sources?: string[];
  /** Phase 5 — l402.directory's `consumption.type` signal (browser /
   *  api_response / stream / download). Indicates how the response is meant
   *  to be consumed — relevant for agents that can only render certain
   *  response shapes. Omitted when null. */
  consumption_type?: string;
  /** Phase 5 — l402.directory's `provider.contact` (operator handle for
   *  support escalation). Omitted when null. */
  provider_contact?: string;

  bayesian: BayesianScoreBlock;
  advisory: IntentAdvisoryBlock;
  health: IntentHealthBlock;
}

/** Stratégie de pool appliquée. Miroir de /api/services/best Phase 4 P3. */
export type IntentStrictness = 'strict' | 'relaxed' | 'degraded';

export interface IntentResponseMeta {
  /** Nombre d'endpoints qui matchent category + keywords + budget + latency
   *  (avant filtrage par strictness). */
  total_matched: number;
  /** Nombre d'éléments effectivement retournés (après limit + tri). */
  returned: number;
  strictness: IntentStrictness;
  /** Warnings globaux — ex. ['FALLBACK_RELAXED', 'NO_CANDIDATES']. */
  warnings: string[];
  /** Mix A+D — only present on free responses (fresh !== true). Tells the
   *  agent how to upgrade to a synchronously-probed result. Omitted on paid
   *  fresh requests because the upgrade has already been applied. */
  upgrade_path?: IntentUpgradePath;
  /** Phase 5 — Sim 3 agents asked how rank order is broken when several
   *  candidates score the same. This documents the deterministic ladder
   *  applied in `sortAndApplyStrictness`. Stable across requests (no
   *  randomness). */
  ranking_explanation: {
    primary: string;
    tiebreakers: string[];
  };
}

export interface IntentResponse {
  intent: ResolvedIntent;
  candidates: IntentCandidate[];
  meta: IntentResponseMeta;
}

export interface IntentCategorySummary {
  name: string;
  endpoint_count: number;
  active_count: number;
}

export interface IntentCategoriesResponse {
  categories: IntentCategorySummary[];
}
