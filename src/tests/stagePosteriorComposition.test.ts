// Phase 5.14 — composeStagePosteriors : tests purs (pas de DB).
import { describe, it, expect } from 'vitest';
import { composeStagePosteriors } from '../services/stagePosteriorComposition';
import {
  STAGE_CHALLENGE,
  STAGE_INVOICE,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
  STAGE_QUALITY,
  type DecayedStagePosterior,
  type Stage,
} from '../repositories/endpointStagePosteriorsRepository';

function makePosterior(
  stage: Stage,
  alpha: number,
  beta: number,
  options: { meaningful?: boolean } = {},
): DecayedStagePosterior {
  // n_obs_effective = (α + β) − (1.5 + 1.5) = α + β − 3
  // pour rendre meaningful: n_obs_effective >= 3, donc α + β >= 6.
  // Si options.meaningful=true: on ajuste pour passer 3.
  const nObs = alpha + beta - 3;
  return {
    endpoint_url_hash: 'h'.repeat(64),
    stage,
    alpha,
    beta,
    n_obs_effective: nObs,
    p_success: alpha / (alpha + beta),
    last_updated: 1_700_000_000,
  };
}

describe('composeStagePosteriors', () => {
  it('empty map → measured_stages=0 et p_e2e=null', () => {
    const result = composeStagePosteriors(new Map());
    expect(result.measured_stages).toBe(0);
    expect(result.p_e2e).toBeNull();
    expect(result.p_e2e_pessimistic).toBeNull();
    expect(result.p_e2e_optimistic).toBeNull();
    expect(result.meaningful_stages).toEqual([]);
    expect(Object.keys(result.stages)).toHaveLength(0);
  });

  it('un seul stage, meaningful → p_e2e = p_success de ce stage', () => {
    const map = new Map<Stage, DecayedStagePosterior>([
      // α=10, β=2 → p=0.833, n_obs_eff=9 (>=3 → meaningful)
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 10, 2)],
    ]);
    const result = composeStagePosteriors(map);
    expect(result.measured_stages).toBe(1);
    expect(result.meaningful_stages).toEqual(['challenge']);
    expect(result.p_e2e).toBeCloseTo(10 / 12, 4);
    expect(result.stages.challenge.p_success).toBeCloseTo(10 / 12, 4);
    expect(result.stages.challenge.is_meaningful).toBe(true);
  });

  it('un stage non meaningful → présent dans stages mais exclu du produit', () => {
    const map = new Map<Stage, DecayedStagePosterior>([
      // α=2, β=1 → n_obs_eff = 0 (pas meaningful)
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 2, 1)],
    ]);
    const result = composeStagePosteriors(map);
    expect(result.measured_stages).toBe(1);
    expect(result.meaningful_stages).toEqual([]);
    expect(result.p_e2e).toBeNull(); // aucun stage meaningful
    expect(result.stages.challenge.is_meaningful).toBe(false);
    expect(result.stages.challenge.p_success).toBeCloseTo(2 / 3, 4);
  });

  it('cinq stages tous meaningful → p_e2e = produit des p_i', () => {
    // Chaque stage : α=9, β=1 → p=0.9, n_obs_eff=7 (meaningful).
    const map = new Map<Stage, DecayedStagePosterior>([
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 9, 1)],
      [STAGE_INVOICE, makePosterior(STAGE_INVOICE, 9, 1)],
      [STAGE_PAYMENT, makePosterior(STAGE_PAYMENT, 9, 1)],
      [STAGE_DELIVERY, makePosterior(STAGE_DELIVERY, 9, 1)],
      [STAGE_QUALITY, makePosterior(STAGE_QUALITY, 9, 1)],
    ]);
    const result = composeStagePosteriors(map);
    expect(result.measured_stages).toBe(5);
    expect(result.meaningful_stages).toEqual([
      'challenge',
      'invoice',
      'payment',
      'delivery',
      'quality',
    ]);
    // 0.9 ^ 5 ≈ 0.59049
    expect(result.p_e2e).toBeCloseTo(0.9 ** 5, 4);
  });

  it('mix : 3 meaningful + 2 non meaningful → p_e2e produit seulement sur les 3', () => {
    const map = new Map<Stage, DecayedStagePosterior>([
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 9, 1)], // 0.9, meaningful
      [STAGE_INVOICE, makePosterior(STAGE_INVOICE, 9, 1)], // 0.9, meaningful
      [STAGE_PAYMENT, makePosterior(STAGE_PAYMENT, 9, 1)], // 0.9, meaningful
      [STAGE_DELIVERY, makePosterior(STAGE_DELIVERY, 1.5, 1.5)], // 0.5, NON meaningful (n_obs=0)
      [STAGE_QUALITY, makePosterior(STAGE_QUALITY, 2, 1)], // 0.67, NON meaningful (n_obs=0)
    ]);
    const result = composeStagePosteriors(map);
    expect(result.measured_stages).toBe(5);
    expect(result.meaningful_stages).toEqual(['challenge', 'invoice', 'payment']);
    // 0.9 ^ 3 = 0.729 — NON pénalisé par les 2 non-meaningful.
    expect(result.p_e2e).toBeCloseTo(0.9 ** 3, 4);
    expect(result.stages.delivery.is_meaningful).toBe(false);
    expect(result.stages.quality.is_meaningful).toBe(false);
  });

  it('p_e2e_pessimistic <= p_e2e <= p_e2e_optimistic', () => {
    const map = new Map<Stage, DecayedStagePosterior>([
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 50, 5)],
      [STAGE_PAYMENT, makePosterior(STAGE_PAYMENT, 30, 3)],
    ]);
    const result = composeStagePosteriors(map);
    expect(result.p_e2e_pessimistic).not.toBeNull();
    expect(result.p_e2e).not.toBeNull();
    expect(result.p_e2e_optimistic).not.toBeNull();
    expect(result.p_e2e_pessimistic!).toBeLessThanOrEqual(result.p_e2e!);
    expect(result.p_e2e!).toBeLessThanOrEqual(result.p_e2e_optimistic!);
  });

  it('un stage failing (β >> α) → p_e2e dégrade tout le pipeline', () => {
    const map = new Map<Stage, DecayedStagePosterior>([
      [STAGE_CHALLENGE, makePosterior(STAGE_CHALLENGE, 95, 5)], // 0.95
      [STAGE_INVOICE, makePosterior(STAGE_INVOICE, 90, 10)], // 0.90
      [STAGE_PAYMENT, makePosterior(STAGE_PAYMENT, 5, 95)], // 0.05 — payment broken
    ]);
    const result = composeStagePosteriors(map);
    expect(result.meaningful_stages).toEqual(['challenge', 'invoice', 'payment']);
    // Produit ≈ 0.95 × 0.90 × 0.05 ≈ 0.0428
    expect(result.p_e2e).toBeCloseTo(0.95 * 0.9 * 0.05, 4);
    // Le caller voit que stages.payment.p_success est très bas et identifie
    // le maillon faible.
    expect(result.stages.payment.p_success).toBeLessThan(0.1);
  });
});
