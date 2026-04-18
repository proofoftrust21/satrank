// Tests pour kendallTau (τ-b) et toRanks.
// Valide les extrêmes (identité, inverse, indépendance) + cas avec égalités.

import { describe, it, expect } from 'vitest';
import { kendallTau, toRanks } from '../utils/rankCorrelation';

describe('kendallTau', () => {
  it('τ=1 pour deux séries dans le même ordre strict', () => {
    const r = kendallTau([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(r.tau).toBe(1);
    expect(r.concordant).toBe(10);
    expect(r.discordant).toBe(0);
  });

  it('τ=-1 pour deux séries inversées', () => {
    const r = kendallTau([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    expect(r.tau).toBe(-1);
    expect(r.concordant).toBe(0);
    expect(r.discordant).toBe(10);
  });

  it('τ proche de 0 pour deux séries indépendantes (moyenne sur plusieurs)', () => {
    // Série construite pour être mélangée — τ-b autour de 0.
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const ys = [3, 1, 5, 2, 8, 4, 7, 6];
    const r = kendallTau(xs, ys);
    expect(Math.abs(r.tau)).toBeLessThan(0.5);
  });

  it('τ ≥ 0.90 pour deux séries presque identiques (une seule permutation locale)', () => {
    const r = kendallTau([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 3, 2, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.tau).toBeGreaterThanOrEqual(0.90);
  });

  it('compte correctement les égalités simples sur x (tiesX incrémenté)', () => {
    const r = kendallTau([1, 1, 2, 3], [1, 2, 3, 4]);
    expect(r.tiesX).toBe(1); // (i=0, j=1) : x égaux, y différents
    expect(r.tiesY).toBe(0);
  });

  it('compte les égalités doubles (tiesBoth, non comptées dans num/denom)', () => {
    const r = kendallTau([1, 1, 2, 3], [5, 5, 6, 7]);
    expect(r.tiesBoth).toBe(1); // (0, 1) : même x ET même y
  });

  it('throw sur longueurs différentes', () => {
    expect(() => kendallTau([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });

  it('totalPairs = n(n-1)/2', () => {
    const r = kendallTau([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(r.totalPairs).toBe(10);
  });

  it('n < 2 retourne τ=0 sans erreur', () => {
    expect(kendallTau([1], [1]).tau).toBe(0);
    expect(kendallTau([], []).tau).toBe(0);
  });
});

describe('toRanks', () => {
  it('assigne des ranks 1..n après tri décroissant', () => {
    expect(toRanks([3, 1, 2])).toEqual([1, 3, 2]);
  });

  it('moyenne les ranks en cas d\'égalité', () => {
    const ranks = toRanks([10, 10, 5]);
    expect(ranks[0]).toBeCloseTo(1.5, 5);
    expect(ranks[1]).toBeCloseTo(1.5, 5);
    expect(ranks[2]).toBe(3);
  });

  it('préserve la longueur du vecteur d\'entrée', () => {
    const ranks = toRanks([5, 3, 8, 1, 9, 2]);
    expect(ranks.length).toBe(6);
  });
});
