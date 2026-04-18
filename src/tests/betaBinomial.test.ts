// Tests unitaires pour le moteur Beta-Binomial.
// Couvre : conjugaison du posterior, monotonie du PPF, bornes, régimes
// normale vs bisection, décroissance exponentielle.

import { describe, it, expect } from 'vitest';
import {
  computePosterior,
  computeFlatPosterior,
  betaPPF,
  betaCDF,
  exponentialDecay,
  logGamma,
  normalPPF,
} from '../utils/betaBinomial';
import { DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA } from '../config/bayesianConfig';

describe('computePosterior', () => {
  it('applique la conjugaison Beta-Binomial : α = α₀ + succès, β = β₀ + échecs', () => {
    const p = computePosterior(2, 2, 10, 5);
    expect(p.alpha).toBe(12);
    expect(p.beta).toBe(7);
    expect(p.pSuccess).toBeCloseTo(12 / 19, 6);
    expect(p.nObs).toBe(15);
  });

  it('sans observations, retourne le prior pur (p = α₀/(α₀+β₀))', () => {
    const p = computePosterior(2, 3, 0, 0);
    expect(p.alpha).toBe(2);
    expect(p.beta).toBe(3);
    expect(p.pSuccess).toBeCloseTo(0.4, 6);
    expect(p.nObs).toBe(0);
  });

  it('supporte les poids non-entiers (report tier scaling)', () => {
    const p = computePosterior(1.5, 1.5, 3.5, 1.5);
    expect(p.alpha).toBeCloseTo(5.0, 6);
    expect(p.beta).toBeCloseTo(3.0, 6);
    expect(p.pSuccess).toBeCloseTo(5 / 8, 6);
  });

  it('ci95_low < pSuccess < ci95_high pour un cas non-dégénéré', () => {
    const p = computePosterior(2, 2, 20, 5);
    expect(p.ci95Low).toBeLessThan(p.pSuccess);
    expect(p.pSuccess).toBeLessThan(p.ci95High);
    expect(p.ci95Low).toBeGreaterThan(0);
    expect(p.ci95High).toBeLessThan(1);
  });

  it('computeFlatPosterior utilise les priors de bayesianConfig (α₀=β₀=1.5)', () => {
    const p = computeFlatPosterior(10, 10);
    expect(p.alpha).toBe(10 + DEFAULT_PRIOR_ALPHA);
    expect(p.beta).toBe(10 + DEFAULT_PRIOR_BETA);
  });

  it('l\'intervalle rétrécit quand n_obs augmente (sharper posterior)', () => {
    const pSmall = computePosterior(1.5, 1.5, 3, 2); // n=5
    const pLarge = computePosterior(1.5, 1.5, 60, 40); // n=100
    const widthSmall = pSmall.ci95High - pSmall.ci95Low;
    const widthLarge = pLarge.ci95High - pLarge.ci95Low;
    expect(widthLarge).toBeLessThan(widthSmall);
  });
});

describe('betaPPF', () => {
  it('p=0.5 sur Beta(α, α) symétrique retourne 0.5', () => {
    expect(betaPPF(10, 10, 0.5)).toBeCloseTo(0.5, 2);
    expect(betaPPF(50, 50, 0.5)).toBeCloseTo(0.5, 2);
  });

  it('est monotone croissante en p', () => {
    const q1 = betaPPF(5, 5, 0.1);
    const q2 = betaPPF(5, 5, 0.5);
    const q3 = betaPPF(5, 5, 0.9);
    expect(q1).toBeLessThan(q2);
    expect(q2).toBeLessThan(q3);
  });

  it('retourne des valeurs dans [0, 1]', () => {
    for (const p of [0.025, 0.1, 0.5, 0.9, 0.975]) {
      const q = betaPPF(3, 7, p);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });

  it('gère les bornes p=0 et p=1 sans throw', () => {
    expect(betaPPF(3, 3, 0)).toBe(0);
    expect(betaPPF(3, 3, 1)).toBe(1);
  });

  it('régime normale (n≥30) cohérent avec le régime bisection (n<30) à la frontière', () => {
    // Même posterior proche de n=30 : les deux régimes doivent donner des valeurs proches.
    const below = betaPPF(14, 14, 0.975); // n=28, bisection
    const above = betaPPF(16, 16, 0.975); // n=32, normale
    expect(Math.abs(below - above)).toBeLessThan(0.05);
  });

  it('throw sur α ou β non-positif', () => {
    expect(() => betaPPF(0, 5, 0.5)).toThrow();
    expect(() => betaPPF(5, -1, 0.5)).toThrow();
  });

  it('betaCDF et betaPPF sont inverses (CDF(PPF(p)) ≈ p)', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const q = betaPPF(10, 10, p);
      const pBack = betaCDF(q, 10, 10);
      expect(pBack).toBeCloseTo(p, 3);
    }
  });
});

describe('exponentialDecay', () => {
  it('à t=0 retourne 1 (pas de décroissance)', () => {
    expect(exponentialDecay(0, 100)).toBe(1);
  });

  it('à t=τ retourne e⁻¹ ≈ 0.368', () => {
    expect(exponentialDecay(100, 100)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('à t=3τ retourne ≈ e⁻³ ≈ 0.0498', () => {
    expect(exponentialDecay(300, 100)).toBeCloseTo(Math.exp(-3), 6);
  });

  it('est monotone décroissant en t', () => {
    const ages = [0, 10, 50, 100, 200, 500, 1000];
    let prev = Infinity;
    for (const a of ages) {
      const w = exponentialDecay(a, 100);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });

  it('τ=0 dégénéré : tout t>0 retourne 0, t=0 retourne 1', () => {
    expect(exponentialDecay(0, 0)).toBe(1);
    expect(exponentialDecay(1, 0)).toBe(0);
  });

  it('âge négatif (horloge futur) retourne 1 (poids plein, pas d\'amplification)', () => {
    expect(exponentialDecay(-100, 100)).toBe(1);
  });
});

describe('logGamma sanity', () => {
  it('logGamma(1) = logGamma(2) = 0 (Γ(1)=Γ(2)=1)', () => {
    expect(logGamma(1)).toBeCloseTo(0, 5);
    expect(logGamma(2)).toBeCloseTo(0, 5);
  });

  it('logGamma(n+1) = log(n!) pour entiers', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 5); // 4! = 24
    expect(logGamma(6)).toBeCloseTo(Math.log(120), 5); // 5! = 120
  });
});

describe('normalPPF', () => {
  it('retourne 0 pour p=0.5 (médiane de N(0,1))', () => {
    expect(normalPPF(0.5)).toBeCloseTo(0, 4);
  });

  it('quantiles 0.025 et 0.975 correspondent à ±1.96', () => {
    expect(normalPPF(0.025)).toBeCloseTo(-1.96, 2);
    expect(normalPPF(0.975)).toBeCloseTo(1.96, 2);
  });
});
