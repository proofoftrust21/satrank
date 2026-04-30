// Phase 4 — graduated advisory overlay.
//
// Produces a continuous `risk_score` ∈ [0, 1] and a 4-level `advisory_level`
// (green/yellow/orange/red) orthogonal to the Bayesian `verdict`. The verdict
// stays the canonical 4-class label (SAFE/RISKY/UNKNOWN/INSUFFICIENT); this
// module surfaces the *degree* of concern so agents can nuance their decision
// without re-deriving thresholds client-side.
//
// Formula:
//   risk_score = 0.40 · critical_flags_factor
//              + 0.25 · (1 - reachability)
//              + 0.20 · decline_factor
//              + 0.15 · uncertainty_factor
//
// All factors are ∈ [0, 1] continuous. Defaults are neutral (0) when the
// corresponding input is missing — unknown signals don't inflate risk.
//
// Mapping:
//   < 0.15 → green
//   < 0.35 → yellow
//   < 0.60 → orange
//   ≥ 0.60 → red
import type {
  Advisory,
  AdvisoryCode,
  AdvisoryLevel,
  AdvisoryReport,
  VerdictFlag,
} from '../types';
import type { OperatorResourceLookup } from './operatorService';

/** Weights frozen in P2. Sum to 1.0 so risk_score stays in [0, 1]. */
const W_CRITICAL = 0.40;
const W_REACHABILITY = 0.25;
const W_DECLINE = 0.20;
const W_UNCERTAINTY = 0.15;

/** Axe 1 — freshness gate. Aligned with the hot-tier probe cadence so a
 *  green level is backed by a probe within the last hot-cycle window. */
const FRESHNESS_THRESHOLD_SEC = 60 * 60;

/** Palier thresholds — bumping these shifts the entire population across levels. */
const LEVEL_THRESHOLDS = { yellow: 0.15, orange: 0.35, red: 0.60 } as const;

/** Sim 8 fix (2026-04-30) — independent escalation thresholds for `p_e2e`,
 *  the chain-product of meaningful L402 stages. The legacy risk_score formula
 *  is challenge-only (computed from `bayesian.*` which aggregates HEAD probe
 *  outcomes) and structurally blind to post-payment failures. When stage
 *  posteriors expose a low `p_e2e`, we escalate the advisory level via an
 *  independent override rather than re-weighting the existing factors —
 *  preserves backwards compat with every freeze-tested formula coefficient
 *  while plugging the gap that surfaced "green badge + lost sats" in Sim 8.
 *  Thresholds chosen so:
 *    p_e2e ≥ 0.70 → no override (challenge signal carries)
 *    0.50 ≤ p_e2e < 0.70 → at least yellow
 *    0.30 ≤ p_e2e < 0.50 → at least orange
 *    p_e2e < 0.30 → red */
const E2E_THRESHOLDS = { yellow: 0.70, orange: 0.50, red: 0.30 } as const;

/** Total ordering used to merge two AdvisoryLevel candidates (legacy formula
 *  vs e2e override). `insufficient_freshness` sits just above `green` because
 *  the freshness gate only ever fires on a would-be green; if a real evidence
 *  channel (e2e) escalates higher, we trust the evidence. */
const LEVEL_ORDER: Record<AdvisoryLevel, number> = {
  green: 0,
  insufficient_freshness: 1,
  yellow: 2,
  orange: 3,
  red: 4,
};

/** Flags that make `critical_flags_factor` fire at 1.0. Chosen to match the
 *  overlay path that still escalates the Bayesian verdict to RISKY
 *  (`verdictService.ts` — fraud_reported, negative_reputation) plus the
 *  positional/reputation signals that represent evidence of harm.
 *  Ordered by severity for the chosen advisory message. */
const CRITICAL_FLAGS: VerdictFlag[] = [
  'fraud_reported',
  'negative_reputation',
  'dispute_reported',
  'unreachable',
];

/** Inputs shared by all callers. Missing fields default to neutral — the
 *  report is valid even on cold agents where only `bayesian` is available. */
export interface AdvisoryInput {
  /** Bayesian posterior — core signal. Missing → treat as maximal uncertainty. */
  bayesian: {
    p_success: number;
    ci95_low: number;
    ci95_high: number;
    n_obs: number;
  };
  /** Current base/overlay flags (from verdictService.computeBaseFlags + probe overlay). */
  flags?: VerdictFlag[];
  /** Reachability ∈ [0, 1], typically derived from probe uptime. Missing → assume healthy (1). */
  reachability?: number;
  /** Delta of p_success over 7d (see trendService.computeDeltas). Missing → 0 (neutral). */
  delta7d?: number | null;
  /** Phase 7 C12 — lookup operator pour la ressource considérée. Emits
   *  OPERATOR_UNVERIFIED quand présent ET status ≠ 'verified'.
   *  Missing/null → pas de rattachement operator, aucun advisory. */
  operatorLookup?: OperatorResourceLookup | null;
  /** Axe 1 — age in seconds since the last successful HTTP probe.
   *  Only callers that own the probe pipeline (/api/intent, /api/decide)
   *  populate this; verdict/nostr callers leave it undefined and skip the
   *  freshness gate. `null` is treated as "never probed" → stale. */
  lastProbeAgeSec?: number | null;
  /** Sim 8 fix — chain-product end-to-end success probability across the
   *  L402 stages with n_obs ≥ 3. Source: stagePosteriorComposition.compose…
   *  Null/undefined when no stage is yet meaningful; the override no-ops in
   *  that case so cold endpoints keep their legacy classification. */
  pE2e?: number | null;
}

/** Resolve a low-p_e2e signal into an escalation level (or null when the
 *  signal is missing or too high to escalate). Pure helper — exported for
 *  test ergonomics. Audit L4 — Number.isFinite excludes NaN/Infinity that
 *  pass `== null` but would otherwise return null silently and mask a bug
 *  in the upstream composer. Treating non-finite as "no signal" is correct
 *  but should be explicit. */
export function advisoryLevelFromE2e(pE2e: number | null | undefined): AdvisoryLevel | null {
  if (pE2e == null || !Number.isFinite(pE2e)) return null;
  if (pE2e < E2E_THRESHOLDS.red)    return 'red';
  if (pE2e < E2E_THRESHOLDS.orange) return 'orange';
  if (pE2e < E2E_THRESHOLDS.yellow) return 'yellow';
  return null;
}

function escalateLevel(base: AdvisoryLevel, override: AdvisoryLevel | null): AdvisoryLevel {
  if (override === null) return base;
  return LEVEL_ORDER[override] > LEVEL_ORDER[base] ? override : base;
}

/** Continuous critical-flags factor — 1.0 when *any* critical flag fires.
 *  We intentionally use max() rather than sum: having fraud AND neg_reputation
 *  at once shouldn't push past 1.0, and the critical path is already covered
 *  by the dedicated flag messages. */
function criticalFlagsFactor(flags: VerdictFlag[]): number {
  for (const f of CRITICAL_FLAGS) if (flags.includes(f)) return 1.0;
  return 0.0;
}

/** Decline factor — clamps negative p_success deltas into [0, 1].
 *  delta7d = -0.20 or worse → 1.0 (full decline signal).
 *  delta7d ≥ 0 → 0.0. */
function declineFactor(delta7d: number | null | undefined): number {
  if (delta7d == null || delta7d >= 0) return 0;
  return Math.min(1, -delta7d / 0.20);
}

/** Uncertainty factor — width of the 95% CI mapped into [0, 1]. CI width of
 *  0.50 or more → 1.0. CI width of 0 → 0. Anchors to 0.5 because for a
 *  centered posterior with n=0 the flat prior produces a ~0.5-wide interval. */
function uncertaintyFactor(ci95Low: number, ci95High: number): number {
  const width = Math.max(0, ci95High - ci95Low);
  return Math.min(1, width / 0.5);
}

/** 1 - reachability, clamped. Missing reachability → assume healthy (factor 0). */
function unreachableFactor(reachability: number | undefined): number {
  if (reachability == null) return 0;
  return Math.max(0, Math.min(1, 1 - reachability));
}

function riskScoreToLevel(riskScore: number): AdvisoryLevel {
  if (riskScore >= LEVEL_THRESHOLDS.red)    return 'red';
  if (riskScore >= LEVEL_THRESHOLDS.orange) return 'orange';
  if (riskScore >= LEVEL_THRESHOLDS.yellow) return 'yellow';
  return 'green';
}

/** Build the list of human-readable advisories based on which factors fired.
 *  Order: critical → reachability → decline → uncertainty (worst first). */
function buildAdvisories(
  flags: VerdictFlag[],
  reachability: number | undefined,
  delta7d: number | null | undefined,
  ci95Low: number,
  ci95High: number,
  operatorLookup: OperatorResourceLookup | null | undefined,
  pE2e: number | null | undefined,
): Advisory[] {
  const advisories: Advisory[] = [];

  const critFlag = CRITICAL_FLAGS.find(f => flags.includes(f));
  if (critFlag) {
    advisories.push(critical('CRITICAL_FLAG', `Critical flag: ${critFlag}`, 1.0, { flag: critFlag }));
  }

  if (reachability != null && reachability < 0.5) {
    const strength = 1 - reachability;
    advisories.push(
      reachability < 0.1
        ? critical('LOW_REACHABILITY', `Reachability=${reachability.toFixed(2)} — probes rarely succeed`, strength, { reachability })
        : warning('INTERMITTENT',     `Reachability=${reachability.toFixed(2)} — intermittent probes`,   strength, { reachability }),
    );
  }

  if (delta7d != null && delta7d < -0.05) {
    const strength = declineFactor(delta7d);
    advisories.push(warning('POSTERIOR_DECLINE', `p_success dropped ${(delta7d * 100).toFixed(1)}% in 7d`, strength, { delta7d }));
  }

  const ciWidth = Math.max(0, ci95High - ci95Low);
  if (ciWidth >= 0.25) {
    advisories.push(info('UNCERTAIN_POSTERIOR', `CI95 width=${ciWidth.toFixed(2)} — low confidence`, uncertaintyFactor(ci95Low, ci95High), { ci95_width: round3(ciWidth) }));
  }

  // Sim 8 fix — surface low end-to-end success even when the legacy formula
  // would still grade green. CRITICAL_E2E fires below 0.30 (most paid calls
  // never deliver), LOW_E2E covers the 0.30-0.60 yellow/orange band. The
  // override on advisory_level happens in computeAdvisoryReport; this just
  // emits the human-readable reason so agents can see *why* the level moved.
  // Audit L4 — Number.isFinite mirrors advisoryLevelFromE2e so NaN/Infinity
  // don't silently slip past the threshold comparison.
  if (pE2e != null && Number.isFinite(pE2e) && pE2e < E2E_THRESHOLDS.yellow) {
    const strength = Math.min(1, Math.max(0, 1 - pE2e));
    if (pE2e < E2E_THRESHOLDS.red) {
      advisories.push(critical(
        'CRITICAL_E2E',
        `End-to-end p=${pE2e.toFixed(2)} — payments rarely fulfill`,
        strength,
        { p_e2e: round3(pE2e) },
      ));
    } else {
      advisories.push(warning(
        'LOW_E2E',
        `End-to-end p=${pE2e.toFixed(2)} — measured post-payment success below safe threshold`,
        strength,
        { p_e2e: round3(pE2e) },
      ));
    }
  }

  // Phase 7 C12 — operator rattaché mais non-vérifié. 'pending' = info (l'operator
  // pourrait finaliser sa vérification), 'rejected' = warning (un opérateur
  // explicitement rejeté ne doit pas bénéficier du doute).
  if (operatorLookup && operatorLookup.status !== 'verified') {
    const strength = operatorLookup.status === 'rejected' ? 0.6 : 0.3;
    const factory = operatorLookup.status === 'rejected' ? warning : info;
    advisories.push(
      factory(
        'OPERATOR_UNVERIFIED',
        `Operator ${operatorLookup.operatorId.slice(0, 12)}… status=${operatorLookup.status} — identity not (yet) cryptographically proven`,
        strength,
        { operator_id: operatorLookup.operatorId, operator_status: operatorLookup.status },
      ),
    );
  }

  return advisories;
}

/** Public entry point. Pure function — no DB, no clock side-effects.
 *  Deterministic given identical input. */
export function computeAdvisoryReport(input: AdvisoryInput): AdvisoryReport {
  const flags = input.flags ?? [];

  const critical = criticalFlagsFactor(flags);
  const unreach  = unreachableFactor(input.reachability);
  const decline  = declineFactor(input.delta7d);
  const uncertain = uncertaintyFactor(input.bayesian.ci95_low, input.bayesian.ci95_high);

  const riskScore =
      W_CRITICAL     * critical
    + W_REACHABILITY * unreach
    + W_DECLINE      * decline
    + W_UNCERTAINTY  * uncertain;

  const riskScoreClamped = Math.max(0, Math.min(1, riskScore));
  const baseLevel = riskScoreToLevel(riskScoreClamped);

  const advisories = buildAdvisories(
    flags,
    input.reachability,
    input.delta7d,
    input.bayesian.ci95_low,
    input.bayesian.ci95_high,
    input.operatorLookup,
    input.pE2e,
  );

  // Sim 8 fix — independent escalation channel. We compute the legacy
  // formula's level first (challenge-only signals) then take the max with
  // the e2e-derived level. This keeps every existing test invariant on
  // pE2e=undefined while plugging the surfaced "green badge + lost sats"
  // pattern when stage_posteriors expose a low post-payment p.
  const e2eLevel = advisoryLevelFromE2e(input.pE2e);
  let advisoryLevel: AdvisoryLevel = escalateLevel(baseLevel, e2eLevel);

  // Axe 1 — freshness gate. Stale probes downgrade an otherwise green
  // verdict to `insufficient_freshness`. We check the post-escalation level
  // so a low-p_e2e endpoint stays escalated (yellow/orange/red) rather than
  // getting clobbered back to `insufficient_freshness` by the gate.
  if (input.lastProbeAgeSec !== undefined) {
    const stale = input.lastProbeAgeSec === null || input.lastProbeAgeSec >= FRESHNESS_THRESHOLD_SEC;
    if (stale && advisoryLevel === 'green') {
      advisoryLevel = 'insufficient_freshness';
      const ageSec = input.lastProbeAgeSec ?? Number.POSITIVE_INFINITY;
      const strength = Number.isFinite(ageSec)
        ? Math.min(1, ageSec / (24 * 3600))
        : 1;
      advisories.push(
        warning(
          'INSUFFICIENT_FRESHNESS',
          input.lastProbeAgeSec === null
            ? 'No HTTP probe on record — verdict cannot be confirmed'
            : `Last HTTP probe ${Math.round(ageSec / 60)} min ago — older than hot-tier cadence`,
          strength,
          { last_probe_age_sec: input.lastProbeAgeSec },
        ),
      );
    }
  }

  return {
    advisory_level: advisoryLevel,
    risk_score: round3(riskScoreClamped),
    advisories,
  };
}

/** Axe 1 — apply the same freshness gate to an already-computed report.
 *  Used by call sites that don't own the full advisory pipeline (decide
 *  reuses the verdict service's report rather than recomputing).
 *  Returns a new report; never mutates input. */
export function applyFreshnessGate(
  report: AdvisoryReport,
  lastProbeAgeSec: number | null | undefined,
): AdvisoryReport {
  if (lastProbeAgeSec === undefined) return report;
  const stale = lastProbeAgeSec === null || lastProbeAgeSec >= FRESHNESS_THRESHOLD_SEC;
  if (!stale || report.advisory_level !== 'green') return report;

  const ageSec = lastProbeAgeSec ?? Number.POSITIVE_INFINITY;
  const strength = Number.isFinite(ageSec)
    ? Math.min(1, ageSec / (24 * 3600))
    : 1;
  return {
    ...report,
    advisory_level: 'insufficient_freshness',
    advisories: [
      ...report.advisories,
      warning(
        'INSUFFICIENT_FRESHNESS',
        lastProbeAgeSec === null
          ? 'No HTTP probe on record — verdict cannot be confirmed'
          : `Last HTTP probe ${Math.round(ageSec / 60)} min ago — older than hot-tier cadence`,
        strength,
        { last_probe_age_sec: lastProbeAgeSec },
      ),
    ],
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function critical(code: AdvisoryCode, msg: string, strength: number, data?: Record<string, unknown>): Advisory {
  return { code, level: 'critical', msg, signal_strength: round3(Math.max(0, Math.min(1, strength))), ...(data ? { data } : {}) };
}

function warning(code: AdvisoryCode, msg: string, strength: number, data?: Record<string, unknown>): Advisory {
  return { code, level: 'warning', msg, signal_strength: round3(Math.max(0, Math.min(1, strength))), ...(data ? { data } : {}) };
}

function info(code: AdvisoryCode, msg: string, strength: number, data?: Record<string, unknown>): Advisory {
  return { code, level: 'info', msg, signal_strength: round3(Math.max(0, Math.min(1, strength))), ...(data ? { data } : {}) };
}
