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
}

/** Rendu minimal de l'intention, rejoué dans la réponse pour que l'agent
 *  puisse vérifier ce que le serveur a effectivement résolu. */
export interface ResolvedIntent {
  category: string;
  keywords: string[];
  budget_sats: number | null;
  max_latency_ms: number | null;
  resolved_at: number;
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
  /** Médiane SQL sur service_probes 7j, null si < 3 probes. */
  median_latency_ms: number | null;

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
