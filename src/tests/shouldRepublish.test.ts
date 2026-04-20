// Phase 8 — C4 : tests de la décision shouldRepublish().
//
// On couvre chaque critère en isolation + combinaisons + cas limites :
//   - previous == null → first_publish (toujours true)
//   - verdict change → verdict_change
//   - advisory_level palier change → advisory_change
//   - |Δ p_success| ≥ 0.05 → p_success_shift
//   - n_obs croissance ≥ 20 % → n_obs_growth
//   - n_obs 0→positif → croissance "infinie" → republish
//   - aucun critère → no_significant_change, false
//   - priorité des raisons : verdict > advisory > p_success > n_obs
import { describe, it, expect } from 'vitest';
import {
  shouldRepublish,
  P_SUCCESS_DELTA_THRESHOLD,
  N_OBS_GROWTH_THRESHOLD,
  type EndorsementSnapshot,
} from '../nostr/shouldRepublish';

const base: EndorsementSnapshot = {
  verdict: 'SAFE',
  advisory_level: 'green',
  p_success: 0.80,
  n_obs_effective: 100,
};

describe('Phase 8 — C4 shouldRepublish', () => {
  it('first_publish when previous is null', () => {
    const d = shouldRepublish(null, base);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('first_publish');
  });

  it('verdict_change triggers republish', () => {
    const current = { ...base, verdict: 'RISKY' as const };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('verdict_change');
    expect(d.details.verdict_changed).toBe(true);
  });

  it('advisory_level palier change triggers republish (green → yellow)', () => {
    const current = { ...base, advisory_level: 'yellow' as const };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('advisory_change');
    expect(d.details.advisory_changed).toBe(true);
  });

  it('advisory_level palier change triggers republish (orange → red)', () => {
    const prev = { ...base, advisory_level: 'orange' as const };
    const current = { ...base, advisory_level: 'red' as const };
    const d = shouldRepublish(prev, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('advisory_change');
  });

  it('p_success shift ≥ 0.05 triggers republish', () => {
    const current = { ...base, p_success: base.p_success + P_SUCCESS_DELTA_THRESHOLD + 0.001 };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('p_success_shift');
    expect(d.details.p_success_delta).toBeGreaterThanOrEqual(P_SUCCESS_DELTA_THRESHOLD);
  });

  it('p_success shift exactly at threshold triggers republish (≥ inclusive)', () => {
    const current = { ...base, p_success: base.p_success + P_SUCCESS_DELTA_THRESHOLD };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
  });

  it('p_success micro-variation < 0.05 is ignored', () => {
    const current = { ...base, p_success: base.p_success + 0.04 };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(false);
    expect(d.reason).toBe('no_significant_change');
  });

  it('p_success shift works in both directions', () => {
    const current = { ...base, p_success: base.p_success - 0.07 };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('p_success_shift');
  });

  it('n_obs growth ≥ 20 % triggers republish', () => {
    const current = { ...base, n_obs_effective: base.n_obs_effective * (1 + N_OBS_GROWTH_THRESHOLD) };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('n_obs_growth');
  });

  it('n_obs growth < 20 % is ignored', () => {
    const current = { ...base, n_obs_effective: base.n_obs_effective * 1.10 };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(false);
    expect(d.reason).toBe('no_significant_change');
  });

  it('n_obs decrease is ignored (decay τ=7j ne trigger pas un republish)', () => {
    const current = { ...base, n_obs_effective: base.n_obs_effective * 0.9 };
    const d = shouldRepublish(base, current);
    expect(d.shouldRepublish).toBe(false);
  });

  it('n_obs 0 → positif triggers republish (croissance infinie)', () => {
    const prev = { ...base, n_obs_effective: 0 };
    const current = { ...base, n_obs_effective: 5 };
    const d = shouldRepublish(prev, current);
    expect(d.shouldRepublish).toBe(true);
    expect(d.reason).toBe('n_obs_growth');
    expect(d.details.n_obs_growth_pct).toBe(Number.POSITIVE_INFINITY);
  });

  it('no change → no republish', () => {
    const d = shouldRepublish(base, { ...base });
    expect(d.shouldRepublish).toBe(false);
    expect(d.reason).toBe('no_significant_change');
    expect(d.details.verdict_changed).toBe(false);
    expect(d.details.advisory_changed).toBe(false);
    expect(d.details.p_success_delta).toBe(0);
  });

  it('priority: verdict_change wins over p_success_shift and advisory_change', () => {
    const current = {
      verdict: 'RISKY' as const,
      advisory_level: 'red' as const,
      p_success: 0.2,
      n_obs_effective: 500,
    };
    const d = shouldRepublish(base, current);
    expect(d.reason).toBe('verdict_change');
    expect(d.details.verdict_changed).toBe(true);
    expect(d.details.advisory_changed).toBe(true); // les deux ont changé, mais verdict prime
  });

  it('priority: advisory_change wins over p_success_shift when verdict inchangé', () => {
    const current = {
      ...base,
      advisory_level: 'yellow' as const,
      p_success: 0.9,
    };
    const d = shouldRepublish(base, current);
    expect(d.reason).toBe('advisory_change');
  });

  it('priority: p_success_shift wins over n_obs_growth when seuls les quantitatifs changent', () => {
    const current = {
      ...base,
      p_success: 0.86,
      n_obs_effective: base.n_obs_effective * 1.5,
    };
    const d = shouldRepublish(base, current);
    expect(d.reason).toBe('p_success_shift');
  });
});
