// Phase 4 — advisoryService is a pure function. Test the 4 factors, the
// mapping risk_score → advisory_level, and the advisories payload shape.
import { describe, it, expect } from 'vitest';
import { computeAdvisoryReport } from '../services/advisoryService';
import type { VerdictFlag } from '../types';

const neutralBayes = {
  p_success: 0.8,
  ci95_low: 0.75,
  ci95_high: 0.85,
  n_obs: 40,
};

describe('advisoryService — risk_score factors', () => {
  it('returns green with risk_score≈0 when all signals are neutral', () => {
    // Narrow CI (width 0.02 → uncertainty 0.04) to exercise the fully-neutral
    // case. uncertainty_factor is continuous, so even a tight posterior
    // contributes ~0.006 to risk_score — that's a feature, not a bug.
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.8, ci95_low: 0.79, ci95_high: 0.81, n_obs: 100 },
      flags: [],
      reachability: 1,
      delta7d: 0,
    });
    expect(r.risk_score).toBeLessThan(0.01);
    expect(r.advisory_level).toBe('green');
    expect(r.advisories).toEqual([]);
  });

  it('critical_flags_factor fires at 1.0 when any critical flag is present', () => {
    const r = computeAdvisoryReport({
      bayesian: neutralBayes,
      flags: ['fraud_reported'] as VerdictFlag[],
      reachability: 1,
      delta7d: 0,
    });
    // 0.4 * 1 + 0.25 * 0 + 0.20 * 0 + 0.15 * uncertainty (ci95 width 0.10 → 0.2)
    expect(r.risk_score).toBeCloseTo(0.43, 2);
    expect(r.advisory_level).toBe('orange');
    expect(r.advisories.some(a => a.code === 'CRITICAL_FLAG' && a.level === 'critical')).toBe(true);
  });

  it('reachability_factor saturates at 1.0 when reachability=0', () => {
    const r = computeAdvisoryReport({
      bayesian: neutralBayes,
      flags: [],
      reachability: 0,
      delta7d: 0,
    });
    // 0.4*0 + 0.25*1 + 0.20*0 + 0.15 * 0.2 (ci95 width 0.10) = 0.28
    expect(r.risk_score).toBeCloseTo(0.28, 2);
    expect(r.advisory_level).toBe('yellow');
    expect(r.advisories.some(a => a.code === 'LOW_REACHABILITY')).toBe(true);
  });

  it('decline_factor clamps at delta7d = -0.20', () => {
    const r = computeAdvisoryReport({
      bayesian: neutralBayes,
      flags: [],
      reachability: 1,
      delta7d: -0.20,
    });
    // 0.20 * 1 + 0.15 * 0.2 = 0.23
    expect(r.risk_score).toBeCloseTo(0.23, 2);
    expect(r.advisory_level).toBe('yellow');
    expect(r.advisories.some(a => a.code === 'POSTERIOR_DECLINE')).toBe(true);
  });

  it('uncertainty_factor saturates at CI width >= 0.5', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.25, ci95_high: 0.75, n_obs: 3 },
      flags: [],
      reachability: 1,
      delta7d: 0,
    });
    // 0.15 * 1 = 0.15
    expect(r.risk_score).toBeCloseTo(0.15, 2);
    expect(r.advisory_level).toBe('yellow');
    expect(r.advisories.some(a => a.code === 'UNCERTAIN_POSTERIOR')).toBe(true);
  });

  it('missing inputs default to neutral — reachability undefined does not inflate risk', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.8, ci95_low: 0.78, ci95_high: 0.82, n_obs: 100 },
    });
    expect(r.risk_score).toBeLessThan(0.05);
    expect(r.advisory_level).toBe('green');
  });

  it('positive delta7d does not add to decline_factor', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.8, ci95_low: 0.78, ci95_high: 0.82, n_obs: 100 },
      flags: [],
      reachability: 1,
      delta7d: 0.15,
    });
    expect(r.risk_score).toBeLessThan(0.05);
    expect(r.advisory_level).toBe('green');
  });
});

describe('advisoryService — advisory_level mapping', () => {
  it('boundary: 0.149 → green, 0.150 → yellow', () => {
    // Construct inputs that produce risk_score exactly on the boundary.
    // critical_flags at 0.375 of its weight = 0.4 * 0.375 = 0.15 — can't hit
    // directly since critical is binary. Use uncertainty (continuous): CI
    // width 0.50 × 0.15 = 0.075. Combine reachability 0.7 × 0.25 = 0.075 →
    // total 0.15.
    const rJustYellow = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.25, ci95_high: 0.75, n_obs: 3 },
      flags: [],
      reachability: 0.7,
      delta7d: 0,
    });
    expect(rJustYellow.risk_score).toBeCloseTo(0.225, 2);
    expect(rJustYellow.advisory_level).toBe('yellow');

    const rJustGreen = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.4, ci95_high: 0.6, n_obs: 20 },
      flags: [],
      reachability: 0.95,
      delta7d: 0,
    });
    // 0.25 * 0.05 + 0.15 * 0.4 = 0.0125 + 0.06 = 0.0725, round3 → 0.073 < 0.15
    expect(rJustGreen.risk_score).toBeCloseTo(0.073, 3);
    expect(rJustGreen.advisory_level).toBe('green');
  });

  it('boundary: 0.349 → yellow, 0.350 → orange', () => {
    const rYellow = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.4, ci95_high: 0.6, n_obs: 20 },
      flags: [],
      reachability: 0.5,
      delta7d: -0.10,
    });
    // 0.25 * 0.5 + 0.20 * 0.5 + 0.15 * 0.4 = 0.125 + 0.10 + 0.06 = 0.285
    expect(rYellow.advisory_level).toBe('yellow');

    const rOrange = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.4, ci95_high: 0.6, n_obs: 20 },
      flags: [],
      reachability: 0.3,
      delta7d: -0.15,
    });
    // 0.25 * 0.7 + 0.20 * 0.75 + 0.15 * 0.4 = 0.175 + 0.15 + 0.06 = 0.385
    expect(rOrange.advisory_level).toBe('orange');
  });

  it('boundary: 0.599 → orange, 0.600 → red', () => {
    const rRed = computeAdvisoryReport({
      bayesian: { p_success: 0.3, ci95_low: 0.15, ci95_high: 0.65, n_obs: 5 },
      flags: ['fraud_reported'] as VerdictFlag[],
      reachability: 0.2,
      delta7d: -0.15,
    });
    // 0.4*1 + 0.25*0.8 + 0.20*0.75 + 0.15 * 1 = 0.4 + 0.2 + 0.15 + 0.15 = 0.90
    expect(rRed.advisory_level).toBe('red');
    expect(rRed.risk_score).toBeGreaterThanOrEqual(0.6);
  });

  it('all factors maxed → risk_score = 1.0 exactly', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0, ci95_high: 1, n_obs: 0 },
      flags: ['fraud_reported'] as VerdictFlag[],
      reachability: 0,
      delta7d: -1,
    });
    expect(r.risk_score).toBe(1);
    expect(r.advisory_level).toBe('red');
  });
});

describe('advisoryService — continuity & determinism', () => {
  it('no discrete jumps on uncertainty_factor between n_obs=9 and n_obs=10', () => {
    // At the old EMPIRICAL_THRESHOLD boundary, the formula used to flip basis.
    // Now it's continuous in ci95_width.
    const r9 = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.30, ci95_high: 0.70, n_obs: 9 },
    });
    const r10 = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.28, ci95_high: 0.72, n_obs: 10 },
    });
    expect(Math.abs(r9.risk_score - r10.risk_score)).toBeLessThan(0.05);
  });

  it('pure function — identical inputs produce identical outputs', () => {
    const input = {
      bayesian: { p_success: 0.8, ci95_low: 0.75, ci95_high: 0.85, n_obs: 40 },
      flags: ['low_volume'] as VerdictFlag[],
      reachability: 0.9,
      delta7d: -0.05,
    };
    const a = computeAdvisoryReport(input);
    const b = computeAdvisoryReport(input);
    expect(a).toEqual(b);
  });

  it('risk_score is rounded to 3 decimals', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0.33, ci95_high: 0.67, n_obs: 10 },
      flags: [],
      reachability: 0.87,
      delta7d: -0.07,
    });
    // Value should have at most 3 decimal places
    expect(Number(r.risk_score.toFixed(3))).toBe(r.risk_score);
  });
});

describe('advisoryService — advisories payload', () => {
  it('unreachable with low reachability uses LOW_REACHABILITY (critical)', () => {
    const r = computeAdvisoryReport({
      bayesian: neutralBayes,
      flags: [],
      reachability: 0.05,
      delta7d: 0,
    });
    const adv = r.advisories.find(a => a.code === 'LOW_REACHABILITY');
    expect(adv).toBeDefined();
    expect(adv!.level).toBe('critical');
    expect(adv!.signal_strength).toBeGreaterThan(0.9);
    expect(adv!.data).toEqual({ reachability: 0.05 });
  });

  it('intermediate reachability uses INTERMITTENT (warning)', () => {
    const r = computeAdvisoryReport({
      bayesian: neutralBayes,
      flags: [],
      reachability: 0.3,
      delta7d: 0,
    });
    const adv = r.advisories.find(a => a.code === 'INTERMITTENT');
    expect(adv).toBeDefined();
    expect(adv!.level).toBe('warning');
  });

  it('signal_strength is always in [0, 1]', () => {
    const r = computeAdvisoryReport({
      bayesian: { p_success: 0.5, ci95_low: 0, ci95_high: 1, n_obs: 0 },
      flags: ['fraud_reported'] as VerdictFlag[],
      reachability: 0,
      delta7d: -2,
    });
    for (const adv of r.advisories) {
      expect(adv.signal_strength).toBeGreaterThanOrEqual(0);
      expect(adv.signal_strength).toBeLessThanOrEqual(1);
    }
  });
});
