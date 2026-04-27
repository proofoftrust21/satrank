// Phase 5 — /api/intent service layer.
//
// Résout une intention (category + keywords + budget + max_latency) en
// candidats classés bayésien-native avec overlay advisory. Tri primaire sur
// p_success DESC, secondaire sur ci95_low DESC, tertiaire sur price_sats ASC.
// Pool de candidats tiered strict → relaxed → degraded, miroir de
// /api/services/best (Phase 4 P3).
//
// Pure agrégation : la source de truth reste les repos (ServiceEndpoint,
// Probe) et les services existants (AgentService, TrendService). Aucune
// écriture en DB, aucun effet de bord hors logging côté controller.

import { endpointHash } from '../utils/urlCanonical';
import { computeAdvisoryReport } from './advisoryService';
import { deriveRecommendation } from '../utils/recommendation';
import { probeUrlsNow } from './freshProbeService';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type {
  ServiceEndpoint,
  ServiceEndpointRepository,
} from '../repositories/serviceEndpointRepository';
import type { AgentService } from './agentService';
import type { BayesianVerdictService } from './bayesianVerdictService';
import type { TrendService } from './trendService';
import type { OperatorResourceLookup, OperatorService } from './operatorService';
import type { BayesianScoreBlock, Verdict, VerdictFlag } from '../types';
import type {
  IntentCandidate,
  IntentCategoriesResponse,
  IntentRequest,
  IntentResponse,
  IntentStrictness,
} from '../types/intent';
import { computeBaseFlags } from '../utils/flags';

/** Flags critiques, alignés sur advisoryService.CRITICAL_FLAGS (dupliqués
 *  intentionnellement — CRITICAL_FLAGS n'est pas exporté). */
const CRITICAL_FLAGS: VerdictFlag[] = [
  'fraud_reported',
  'negative_reputation',
  'dispute_reported',
  'unreachable',
];

/** Fenêtre de reachability — cohérente avec τ=7j du bayésien, même choix que
 *  verdictService et advisoryService. */
const REACHABILITY_WINDOW_SEC = 7 * 86400;

/** Plafond du scan DB par catégorie. Au 2026-04-19 la plus grosse catégorie
 *  en prod a 26 endpoints ; 500 donne 20× de marge pour la croissance sans
 *  risque perf. */
const MAX_POOL_SCAN = 500;

/** Clamp max côté serveur même si le controller laisse passer. */
export const INTENT_LIMIT_DEFAULT = 5;
export const INTENT_LIMIT_MAX = 20;

/** Pricing Mix A+D — when fresh=true, we synchronously probe the top-N
 *  candidates to guarantee `last_probe_age_sec < 60`. N is bounded so a
 *  caller cannot turn one paid request into a high-fanout amplifier. */
export const FRESH_PROBE_TOP_N = 3;

/** Per-candidate freshness bucket. Drives the `freshness_status` field on
 *  the advisory block. Thresholds align with advisoryService:
 *    fresh      — within the hot-tier cycle (1 min)
 *    recent     — within the warm-tier window (1 h, applyFreshnessGate cutoff)
 *    stale      — within 24 h, posterior not freshly verified
 *    very_stale — older than 24 h (or never probed) */
export type FreshnessStatus = 'fresh' | 'recent' | 'stale' | 'very_stale';
const FRESHNESS_RECENT_THRESHOLD_SEC = 60;
const FRESHNESS_STALE_THRESHOLD_SEC = 60 * 60;
const FRESHNESS_VERY_STALE_THRESHOLD_SEC = 24 * 60 * 60;

/** Vague 1 B — minimum recent observations for `bayesian.is_meaningful` to
 *  be true. Lower than UNKNOWN_MIN_N_OBS=10 because is_meaningful is a hint,
 *  not a verdict; verdict already encodes the stricter threshold. We pick 5
 *  so a candidate freshly observed twice in the hot tier (n_obs ~ 4-6 once
 *  the operator/service prior is folded in) crosses the bar. */
const IS_MEANINGFUL_MIN_N_OBS = 5;

function freshnessStatusFromAge(ageSec: number | null): FreshnessStatus {
  if (ageSec == null) return 'very_stale';
  if (ageSec < FRESHNESS_RECENT_THRESHOLD_SEC) return 'fresh';
  if (ageSec < FRESHNESS_STALE_THRESHOLD_SEC) return 'recent';
  if (ageSec < FRESHNESS_VERY_STALE_THRESHOLD_SEC) return 'stale';
  return 'very_stale';
}

/** Mix A+D — message offered on free `/intent` calls so agents see exactly
 *  how to upgrade to a synchronously-probed result. Pricing in sats matches
 *  pricingMap['/intent'] in src/app.ts. */
export const INTENT_FRESH_UPGRADE_PATH = {
  flag: 'fresh=true' as const,
  cost_sats: 2,
  message:
    'Pass fresh=true (2 sats) to force a synchronous HTTP probe on the top candidates and guarantee fresh status.',
};

export interface IntentServiceDeps {
  serviceEndpointRepo: ServiceEndpointRepository;
  agentRepo: AgentRepository;
  agentService: AgentService;
  /** Phase 5 — read per-endpoint Bayesian posteriors instead of the
   *  operator-keyed block agentService.toBayesianBlock returns. The verdict
   *  service walks the prior cascade (endpoint → service → operator → upstream)
   *  so when a freshly registered endpoint has no observations yet, the
   *  caller still gets a reasonable prior with `is_meaningful=false`. */
  bayesianVerdictService: BayesianVerdictService;
  trendService: TrendService;
  probeRepo?: ProbeRepository;
  /** Phase 7 — optional. Quand fourni, chaque candidat expose operator_id
   *  (seulement si status='verified') + advisory OPERATOR_UNVERIFIED pour
   *  les statuts pending/rejected. Absent → fallback strict (operator_id=null,
   *  aucun advisory operator émis). */
  operatorService?: OperatorService;
  /** Clock injectable pour tests déterministes. */
  now?: () => number;
}

/** Résultat intermédiaire avant tri/strictness. */
interface EnrichedCandidate {
  svc: ServiceEndpoint;
  operatorPubkey: string | null;
  /** Phase 7 — résolution operator par url_hash. null si pas de lookup
   *  possible (operatorService absent) ou pas d'ownership claim. */
  operatorLookup: OperatorResourceLookup | null;
  bayesian: BayesianScoreBlock;
  flags: VerdictFlag[];
  reachability: number | null;
  delta7d: number | null;
  httpHealthScore: number | null;
  healthFreshness: number | null;
  lastProbeAgeSec: number | null;
  medianLatencyMs: number | null;
  httpStatus: 'healthy' | 'degraded' | 'down' | 'unknown';
}

export class IntentService {
  private readonly now: () => number;

  constructor(private readonly deps: IntentServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** GET /api/intent/categories — liste des catégories vivantes avec compte
   *  total + compte actif (≥3 probes ET uptime ≥ 0.5). */
  async listCategories(): Promise<IntentCategoriesResponse> {
    const rows = await this.deps.serviceEndpointRepo.findCategoriesWithActive();
    return {
      categories: rows.map(r => ({
        name: r.category,
        endpoint_count: r.endpoint_count,
        active_count: r.active_count,
      })),
    };
  }

  /** Liste plate des noms de catégories valides — utilisée par le controller
   *  pour valider la request AVANT de lancer le tri. */
  async knownCategoryNames(): Promise<Set<string>> {
    const categories = await this.deps.serviceEndpointRepo.findCategories();
    return new Set(categories.map(c => c.category));
  }

  /** POST /api/intent — résout l'intention en candidats triés.
   *  `opts.fresh` (Mix A+D) — when true, after sort/trim we run a synchronous
   *  HTTP probe on the top candidates and re-enrich them so the response
   *  carries `last_probe_age_sec` ≈ 0. The caller is responsible for the L402
   *  paywall — the service layer trusts the flag at this point. */
  async resolveIntent(
    req: IntentRequest,
    rawLimit: number | undefined,
    opts: { fresh?: boolean } = {},
  ): Promise<IntentResponse> {
    const fresh = opts.fresh === true;
    const limit = Math.min(
      Math.max(1, rawLimit ?? INTENT_LIMIT_DEFAULT),
      INTENT_LIMIT_MAX,
    );
    const keywords = (req.keywords ?? []).map(k => k.trim()).filter(k => k.length > 0);

    const poolResult = await this.deps.serviceEndpointRepo.findServices({
      category: req.category,
      sort: 'uptime',
      limit: MAX_POOL_SCAN,
      offset: 0,
    });
    const pool = poolResult.services;

    // Filter matches — sequential because each iteration may hit the DB for
    // median latency. Keep order deterministic and respect pool-max.
    const matched: ServiceEndpoint[] = [];
    for (const svc of pool) {
      if (keywords.length > 0 && !keywordsMatchAll(svc, keywords)) continue;
      if (req.budget_sats != null) {
        if (svc.service_price_sats == null) continue;
        if (svc.service_price_sats > req.budget_sats) continue;
      }
      if (req.max_latency_ms != null) {
        const median = await this.deps.serviceEndpointRepo.medianHttpLatency7d(svc.url);
        if (median == null) continue;
        if (median > req.max_latency_ms) continue;
      }
      matched.push(svc);
    }

    const enriched: EnrichedCandidate[] = [];
    for (const svc of matched) {
      enriched.push(await this.enrich(svc));
    }

    const { pool: tierPool, strictness, warnings } = applyStrictness(enriched);

    const sorted = [...tierPool].sort(compareCandidates);
    const trimmed = sorted.slice(0, limit);

    // Mix A+D — when ?fresh=true, force a synchronous probe on the top-N
    // URLs so the response carries a probe younger than the hot-tier cadence.
    // The probe service upserts via repo.upsert (preserving trust source);
    // we then re-fetch and re-enrich each touched candidate so the updated
    // last_checked_at, http_status, latency_ms reach the formatter.
    let finalCandidates = trimmed;
    if (fresh && trimmed.length > 0) {
      const probeBatch = trimmed.slice(0, FRESH_PROBE_TOP_N);
      await probeUrlsNow(
        probeBatch.map(c => c.svc.url),
        this.deps.serviceEndpointRepo,
      );
      const refreshed: EnrichedCandidate[] = [];
      for (let i = 0; i < trimmed.length; i++) {
        const original = trimmed[i];
        const inProbeBatch = i < FRESH_PROBE_TOP_N;
        if (!inProbeBatch) {
          refreshed.push(original);
          continue;
        }
        const updatedSvc = await this.deps.serviceEndpointRepo.findByUrl(original.svc.url);
        refreshed.push(updatedSvc ? await this.enrich(updatedSvc) : original);
      }
      finalCandidates = refreshed;
    }

    const candidates: IntentCandidate[] = finalCandidates.map((c, idx) =>
      this.formatCandidate(c, idx + 1),
    );

    // Axe 1 — record that these URLs were just surfaced. Drives the
    // hot/warm/cold tiering in serviceHealthCrawler. Best-effort: a
    // failed UPDATE must not break the response.
    if (finalCandidates.length > 0) {
      try {
        await this.deps.serviceEndpointRepo.markIntentQuery(
          finalCandidates.map(c => c.svc.url),
        );
      } catch {
        // Tiering will fall back to legacy single-tier on next crawl cycle —
        // not worth surfacing to the caller.
      }
    }

    return {
      intent: {
        category: req.category,
        keywords,
        budget_sats: req.budget_sats ?? null,
        max_latency_ms: req.max_latency_ms ?? null,
        resolved_at: this.now(),
        fresh,
      },
      candidates,
      meta: {
        total_matched: matched.length,
        returned: candidates.length,
        strictness,
        warnings,
        ...(fresh ? {} : { upgrade_path: INTENT_FRESH_UPGRADE_PATH }),
        ranking_explanation: INTENT_RANKING_EXPLANATION,
      },
    };
  }

  private async enrich(svc: ServiceEndpoint): Promise<EnrichedCandidate> {
    const agent = svc.agent_hash ? await this.deps.agentRepo.findByHash(svc.agent_hash) : null;
    // Phase 5 — per-endpoint Bayesian read.
    //
    // Pre-Phase-5 the call resolved through agentService.toBayesianBlock(agent_hash),
    // which keys the streaming posteriors by sha256(operator_pubkey). Every endpoint
    // hosted by the same operator therefore returned identical p_success / n_obs / ci95,
    // collapsing the ranking signal (Sim 3 root cause: 8 of 9 agents flagged it).
    //
    // The verdict service is keyed by an opaque target hash, so we now pass the
    // endpoint-canonicalized URL hash. The hierarchical-prior cascade
    // (endpoint → service → operator → upstream) stays exactly as designed:
    // endpoints with their own observations surface a real per-row posterior
    // with `is_meaningful=true`; endpoints without yet-accumulated probe data
    // fall back to the operator/category/upstream prior with `is_meaningful=false`.
    const bayesian = svc.agent_hash
      ? await this.toEndpointBayesianBlock(svc)
      : neutralBayesian(this.now());

    const delta = svc.agent_hash
      ? await this.deps.trendService.computeDeltas(svc.agent_hash, bayesian.p_success)
      : null;
    const delta7d = delta?.delta7d ?? null;

    const flags: VerdictFlag[] = svc.agent_hash && agent
      ? computeBaseFlags(agent, { delta7d }, this.now())
      : [];

    const reachability = svc.agent_hash && this.deps.probeRepo
      ? await this.deps.probeRepo.computeUptime(svc.agent_hash, REACHABILITY_WINDOW_SEC)
      : null;

    const httpStatus = classifyHttpStatus(svc.last_http_status);
    const uptimeRatio = svc.check_count >= 3
      ? Math.round((svc.success_count / svc.check_count) * 1000) / 1000
      : null;
    const httpHealthScore = computeHttpHealthScore(httpStatus, uptimeRatio);
    const healthFreshness = computeHealthFreshness(svc.last_checked_at, this.now());
    const lastProbeAgeSec = svc.last_checked_at != null
      ? Math.max(0, this.now() - svc.last_checked_at)
      : null;

    const medianLatencyMs = await this.deps.serviceEndpointRepo.medianHttpLatency7d(svc.url);

    const operatorLookup = this.deps.operatorService
      ? await this.deps.operatorService.resolveOperatorForEndpoint(endpointHash(svc.url))
      : null;

    return {
      svc,
      operatorPubkey: agent?.public_key ?? null,
      operatorLookup,
      bayesian,
      flags,
      reachability,
      delta7d,
      httpHealthScore,
      healthFreshness,
      lastProbeAgeSec,
      medianLatencyMs,
      httpStatus,
    };
  }

  /** Phase 5 — read the Bayesian block keyed by the endpoint URL hash, not
   *  the operator hash. The verdict service walks its own prior cascade so
   *  endpoints with no per-URL observations still get a sensible block
   *  (with is_meaningful=false). The serviceHash and operatorId arguments
   *  feed the cascade overlay (category siblings + upstream signals) — they
   *  do not influence the verdict itself when per-endpoint evidence exists. */
  private async toEndpointBayesianBlock(svc: ServiceEndpoint): Promise<BayesianScoreBlock> {
    const urlHash = endpointHash(svc.url);
    const v = await this.deps.bayesianVerdictService.buildVerdict({
      targetHash: urlHash,
      serviceHash: urlHash,
      operatorId: svc.agent_hash ?? undefined,
    });
    return {
      p_success: v.p_success,
      ci95_low: v.ci95_low,
      ci95_high: v.ci95_high,
      n_obs: v.n_obs,
      verdict: v.verdict,
      sources: v.sources,
      convergence: v.convergence,
      recent_activity: v.recent_activity,
      risk_profile: v.risk_profile,
      time_constant_days: v.time_constant_days,
      last_update: v.last_update,
      // Default to true; intentService.formatCandidate downgrades to false
      // when freshness is insufficient or local evidence is too thin.
      is_meaningful: true,
    };
  }

  private formatCandidate(c: EnrichedCandidate, rank: number): IntentCandidate {
    const advisoryReport = computeAdvisoryReport({
      bayesian: {
        p_success: c.bayesian.p_success,
        ci95_low: c.bayesian.ci95_low,
        ci95_high: c.bayesian.ci95_high,
        n_obs: c.bayesian.n_obs,
      },
      flags: c.flags,
      reachability: c.reachability ?? undefined,
      delta7d: c.delta7d,
      operatorLookup: c.operatorLookup,
      lastProbeAgeSec: c.lastProbeAgeSec,
    });

    const hasCritical = CRITICAL_FLAGS.some(f => c.flags.includes(f));
    const serviceDown = c.httpStatus === 'down';
    const recommendation = deriveRecommendation({
      verdict: c.bayesian.verdict,
      advisoryLevel: advisoryReport.advisory_level,
      hasCritical,
      serviceDown,
      ci95Low: c.bayesian.ci95_low,
    });

    // Phase 7 — C11 : operator_id exposé seulement si verified (zero auto-trust).
    const operator_id =
      c.operatorLookup?.status === 'verified' ? c.operatorLookup.operatorId : null;

    // Phase 5 — surface multi-source attribution + l402.directory-only
    // signals only when present. Omit the field entirely when null/empty so
    // single-source rows have a leaner shape (avoids "sources":["402index"]
    // appearing on every candidate, which is information-free noise).
    const sources = c.svc.sources && c.svc.sources.length > 1
      ? c.svc.sources
      : undefined;
    const consumption_type = c.svc.consumption_type ?? undefined;
    const provider_contact = c.svc.provider_contact ?? undefined;

    return {
      rank,
      endpoint_url: c.svc.url,
      endpoint_hash: endpointHash(c.svc.url),
      operator_pubkey: c.operatorPubkey,
      operator_id,
      service_name: c.svc.name,
      price_sats: c.svc.service_price_sats,
      median_latency_ms: c.medianLatencyMs,
      ...(sources !== undefined ? { sources } : {}),
      ...(consumption_type !== undefined ? { consumption_type } : {}),
      ...(provider_contact !== undefined ? { provider_contact } : {}),
      bayesian: {
        ...c.bayesian,
        // Vague 1 B: surface a non-breaking honesty flag. The score is
        // meaningful only when the underlying probe is fresh AND there are
        // enough recent observations to override the prior. Stale or thin
        // posteriors stay visible (back-compat), but agents that read this
        // flag know to either ignore the score or pay ?fresh=true.
        is_meaningful:
          (freshnessStatusFromAge(c.lastProbeAgeSec) === 'fresh' ||
            freshnessStatusFromAge(c.lastProbeAgeSec) === 'recent') &&
          c.bayesian.n_obs >= IS_MEANINGFUL_MIN_N_OBS,
      },
      advisory: {
        advisory_level: advisoryReport.advisory_level,
        risk_score: advisoryReport.risk_score,
        advisories: advisoryReport.advisories,
        recommendation,
        freshness_status: freshnessStatusFromAge(c.lastProbeAgeSec),
      },
      health: {
        reachability: c.reachability != null ? Math.round(c.reachability * 1000) / 1000 : null,
        http_health_score: c.httpHealthScore,
        health_freshness: c.healthFreshness,
        last_probe_age_sec: c.lastProbeAgeSec,
      },
    };
  }
}

/** AND sur plusieurs keywords — chaque keyword doit matcher endpoint.name OU
 *  service.name OU provider OU category. Comparaison case-insensitive. */
function keywordsMatchAll(svc: ServiceEndpoint, keywords: string[]): boolean {
  const haystack = [svc.name, svc.description, svc.category, svc.provider]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase();
  return keywords.every(k => haystack.includes(k.toLowerCase()));
}

/** Strictness tiers alignés avec /api/services/best Phase 4 P3.
 *  - strict : verdict === 'SAFE' uniquement
 *  - relaxed : tout non-RISKY (SAFE, UNKNOWN, INSUFFICIENT) quand strict est vide
 *  - degraded : pool vide après exclusion RISKY
 *  RISKY est toujours exclu (aucun fallback n'accepte un RISKY). */
function applyStrictness(
  enriched: EnrichedCandidate[],
): { pool: EnrichedCandidate[]; strictness: IntentStrictness; warnings: string[] } {
  const nonRisky = enriched.filter(e => e.bayesian.verdict !== 'RISKY');
  const strict = nonRisky.filter(e => e.bayesian.verdict === 'SAFE');
  if (strict.length > 0) {
    return { pool: strict, strictness: 'strict', warnings: [] };
  }
  if (nonRisky.length > 0) {
    return { pool: nonRisky, strictness: 'relaxed', warnings: ['FALLBACK_RELAXED'] };
  }
  return { pool: [], strictness: 'degraded', warnings: ['NO_CANDIDATES'] };
}

/** Tri canonique (Vague 1 B):
 *    1. is_meaningful=true devant is_meaningful=false (un score honnête bat
 *       un score prior-dominé même si le second est numériquement plus haut)
 *    2. p_success DESC
 *    3. ci95_low DESC
 *    4. price_sats ASC
 *  is_meaningful est dérivé inline (freshness <1h ET n_obs ≥ IS_MEANINGFUL_MIN_N_OBS).
 *  Le calcul dupliqué avec formatCandidate est intentionnel: garder le tri
 *  pré-format pour ne pas avoir à matérialiser l'API shape avant le sort. */

/** Phase 5 — surfaced in IntentResponse.meta.ranking_explanation so agents
 *  don't have to read the source to understand why two candidates with
 *  identical posteriors got the order they did. Mirrors the comparator
 *  below — keep them in sync. */
const INTENT_RANKING_EXPLANATION: { primary: string; tiebreakers: string[] } = {
  primary: 'is_meaningful=true ranks above is_meaningful=false; an honest score beats a prior-dominated one even when numerically lower',
  tiebreakers: [
    'p_success DESC',
    'ci95_low DESC (tighter lower bound wins on equal mean)',
    'price_sats ASC (cheapest wins on equal posterior)',
  ],
};
function compareCandidates(a: EnrichedCandidate, b: EnrichedCandidate): number {
  const isMeaningful = (c: EnrichedCandidate): boolean => {
    if (c.lastProbeAgeSec == null) return false;
    if (c.lastProbeAgeSec >= FRESHNESS_STALE_THRESHOLD_SEC) return false;
    return c.bayesian.n_obs >= IS_MEANINGFUL_MIN_N_OBS;
  };
  const aMean = isMeaningful(a);
  const bMean = isMeaningful(b);
  if (aMean !== bMean) {
    return aMean ? -1 : 1;
  }
  if (b.bayesian.p_success !== a.bayesian.p_success) {
    return b.bayesian.p_success - a.bayesian.p_success;
  }
  if (b.bayesian.ci95_low !== a.bayesian.ci95_low) {
    return b.bayesian.ci95_low - a.bayesian.ci95_low;
  }
  const priceA = a.svc.service_price_sats ?? Number.MAX_SAFE_INTEGER;
  const priceB = b.svc.service_price_sats ?? Number.MAX_SAFE_INTEGER;
  return priceA - priceB;
}

function classifyHttpStatus(
  status: number | null,
): 'healthy' | 'degraded' | 'down' | 'unknown' {
  if (status == null || status === 0) return 'unknown';
  if (status >= 200 && status < 300) return 'healthy';
  if (status === 301 || status === 302 || status === 307 || status === 308) return 'healthy';
  if (status === 402) return 'healthy';
  if (status === 401 || status === 403) return 'degraded';
  if (status >= 400 && status < 500) return 'degraded';
  return 'down';
}

/** Identique à decideService.computeHttpHealthScore (Phase 4 P6). Dupliqué
 *  pour éviter un import croisé ; la formule est gelée et testée. */
function computeHttpHealthScore(
  status: 'healthy' | 'degraded' | 'down' | 'unknown',
  uptimeRatio: number | null,
): number | null {
  if (status === 'unknown') return null;
  const statusScore = status === 'healthy' ? 1 : status === 'degraded' ? 0.5 : 0;
  if (uptimeRatio == null) return statusScore;
  return Math.round((0.7 * statusScore + 0.3 * uptimeRatio) * 1000) / 1000;
}

/** Identique à decideService.computeHealthFreshness. */
function computeHealthFreshness(lastCheckedAt: number | null, nowSec: number): number | null {
  if (lastCheckedAt == null) return null;
  const age = Math.max(0, nowSec - lastCheckedAt);
  return Math.round(Math.exp(-age / 600) * 1000) / 1000;
}

/** Bayesian block neutre pour les services orphelins (pas de agent_hash).
 *  Exposé "UNKNOWN" avec prior flat — ne sera pas classé SAFE. */
function neutralBayesian(nowSec: number): BayesianScoreBlock {
  return {
    p_success: 0.5,
    ci95_low: 0.025,
    ci95_high: 0.975,
    n_obs: 0,
    verdict: 'UNKNOWN' as Verdict,
    sources: { probe: null, report: null, paid: null },
    convergence: {
      converged: false,
      sources_above_threshold: [],
      threshold: 0.15,
    },
    recent_activity: { last_24h: 0, last_7d: 0, last_30d: 0 },
    risk_profile: 'unknown',
    time_constant_days: 7,
    last_update: nowSec,
    // Orphan endpoints have zero local evidence: by definition the score is
    // not meaningful regardless of freshness.
    is_meaningful: false,
  };
}
