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
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type {
  ServiceEndpoint,
  ServiceEndpointRepository,
} from '../repositories/serviceEndpointRepository';
import type { AgentService } from './agentService';
import type { TrendService } from './trendService';
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

export interface IntentServiceDeps {
  serviceEndpointRepo: ServiceEndpointRepository;
  agentRepo: AgentRepository;
  agentService: AgentService;
  trendService: TrendService;
  probeRepo?: ProbeRepository;
  /** Clock injectable pour tests déterministes. */
  now?: () => number;
}

/** Résultat intermédiaire avant tri/strictness. */
interface EnrichedCandidate {
  svc: ServiceEndpoint;
  operatorPubkey: string | null;
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
  listCategories(): IntentCategoriesResponse {
    const rows = this.deps.serviceEndpointRepo.findCategoriesWithActive();
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
  knownCategoryNames(): Set<string> {
    return new Set(this.deps.serviceEndpointRepo.findCategories().map(c => c.category));
  }

  /** POST /api/intent — résout l'intention en candidats triés. */
  resolveIntent(req: IntentRequest, rawLimit: number | undefined): IntentResponse {
    const limit = Math.min(
      Math.max(1, rawLimit ?? INTENT_LIMIT_DEFAULT),
      INTENT_LIMIT_MAX,
    );
    const keywords = (req.keywords ?? []).map(k => k.trim()).filter(k => k.length > 0);

    const pool = this.deps.serviceEndpointRepo.findServices({
      category: req.category,
      sort: 'uptime',
      limit: MAX_POOL_SCAN,
      offset: 0,
    }).services;

    const matched = pool.filter(svc => {
      if (keywords.length > 0 && !keywordsMatchAll(svc, keywords)) return false;
      if (req.budget_sats != null) {
        if (svc.service_price_sats == null) return false;
        if (svc.service_price_sats > req.budget_sats) return false;
      }
      if (req.max_latency_ms != null) {
        const median = this.deps.serviceEndpointRepo.medianHttpLatency7d(svc.url);
        if (median == null) return false;
        if (median > req.max_latency_ms) return false;
      }
      return true;
    });

    const enriched = matched.map(svc => this.enrich(svc));

    const { pool: tierPool, strictness, warnings } = applyStrictness(enriched);

    const sorted = [...tierPool].sort(compareCandidates);
    const trimmed = sorted.slice(0, limit);

    const candidates: IntentCandidate[] = trimmed.map((c, idx) =>
      this.formatCandidate(c, idx + 1),
    );

    return {
      intent: {
        category: req.category,
        keywords,
        budget_sats: req.budget_sats ?? null,
        max_latency_ms: req.max_latency_ms ?? null,
        resolved_at: this.now(),
      },
      candidates,
      meta: {
        total_matched: matched.length,
        returned: candidates.length,
        strictness,
        warnings,
      },
    };
  }

  private enrich(svc: ServiceEndpoint): EnrichedCandidate {
    const agent = svc.agent_hash ? this.deps.agentRepo.findByHash(svc.agent_hash) : null;
    const bayesian = svc.agent_hash
      ? this.deps.agentService.toBayesianBlock(svc.agent_hash)
      : neutralBayesian(this.now());

    const delta = svc.agent_hash
      ? this.deps.trendService.computeDeltas(svc.agent_hash, bayesian.p_success)
      : null;
    const delta7d = delta?.delta7d ?? null;

    const flags: VerdictFlag[] = svc.agent_hash && agent
      ? computeBaseFlags(agent, { delta7d }, this.now())
      : [];

    const reachability = svc.agent_hash && this.deps.probeRepo
      ? this.deps.probeRepo.computeUptime(svc.agent_hash, REACHABILITY_WINDOW_SEC)
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

    const medianLatencyMs = this.deps.serviceEndpointRepo.medianHttpLatency7d(svc.url);

    return {
      svc,
      operatorPubkey: agent?.public_key ?? null,
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

    return {
      rank,
      endpoint_url: c.svc.url,
      endpoint_hash: endpointHash(c.svc.url),
      operator_pubkey: c.operatorPubkey,
      service_name: c.svc.name,
      price_sats: c.svc.service_price_sats,
      median_latency_ms: c.medianLatencyMs,
      bayesian: c.bayesian,
      advisory: {
        advisory_level: advisoryReport.advisory_level,
        risk_score: advisoryReport.risk_score,
        advisories: advisoryReport.advisories,
        recommendation,
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

/** Tri canonique : p_success DESC → ci95_low DESC → price_sats ASC. */
function compareCandidates(a: EnrichedCandidate, b: EnrichedCandidate): number {
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
  };
}
