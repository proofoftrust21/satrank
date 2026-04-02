// Scoring configuration integrity tests
import { describe, it, expect } from 'vitest';
import {
  WEIGHTS,
  WEIGHT_VOLUME,
  WEIGHT_REPUTATION,
  WEIGHT_SENIORITY,
  WEIGHT_REGULARITY,
  WEIGHT_DIVERSITY,
  ATTESTATION_HALF_LIFE,
  MIN_ATTESTER_AGE_DAYS,
  UNKNOWN_ATTESTER_WEIGHT,
  YOUNG_ATTESTER_WEIGHT,
  MUTUAL_ATTESTATION_PENALTY,
  SUSPECT_ATTESTATION_SCORE_CAP,
  CIRCULAR_CLUSTER_PENALTY,
  VERIFIED_TX_BONUS_CAP,
  LNPLUS_RANK_MULTIPLIER,
  LNPLUS_RATINGS_WEIGHT,
  NEGATIVE_RATINGS_PENALTY,
  CENTRALITY_BONUS_MULTIPLIER,
  CENTRALITY_DECAY_CONSTANT,
  SCORE_CACHE_TTL,
  POPULARITY_BONUS_CAP,
  CONFIDENCE_VERY_LOW,
  CONFIDENCE_LOW,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_HIGH,
} from '../config/scoring';

describe('Scoring configuration', () => {
  it('weights sum to 1.0', () => {
    const sum = WEIGHT_VOLUME + WEIGHT_REPUTATION + WEIGHT_SENIORITY + WEIGHT_REGULARITY + WEIGHT_DIVERSITY;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('WEIGHTS object matches individual exports', () => {
    expect(WEIGHTS.volume).toBe(WEIGHT_VOLUME);
    expect(WEIGHTS.reputation).toBe(WEIGHT_REPUTATION);
    expect(WEIGHTS.seniority).toBe(WEIGHT_SENIORITY);
    expect(WEIGHTS.regularity).toBe(WEIGHT_REGULARITY);
    expect(WEIGHTS.diversity).toBe(WEIGHT_DIVERSITY);
  });

  it('all weights are positive', () => {
    for (const [key, value] of Object.entries(WEIGHTS)) {
      expect(value, `${key} weight`).toBeGreaterThan(0);
    }
  });

  it('anti-gaming penalties are between 0 and 1', () => {
    expect(MUTUAL_ATTESTATION_PENALTY).toBeGreaterThan(0);
    expect(MUTUAL_ATTESTATION_PENALTY).toBeLessThan(1);
    expect(CIRCULAR_CLUSTER_PENALTY).toBeGreaterThan(0);
    expect(CIRCULAR_CLUSTER_PENALTY).toBeLessThan(1);
    expect(UNKNOWN_ATTESTER_WEIGHT).toBeGreaterThan(0);
    expect(UNKNOWN_ATTESTER_WEIGHT).toBeLessThan(1);
    expect(YOUNG_ATTESTER_WEIGHT).toBeGreaterThan(0);
    expect(YOUNG_ATTESTER_WEIGHT).toBeLessThan(1);
  });

  it('score cap is within 0-100 range', () => {
    expect(SUSPECT_ATTESTATION_SCORE_CAP).toBeGreaterThanOrEqual(0);
    expect(SUSPECT_ATTESTATION_SCORE_CAP).toBeLessThanOrEqual(100);
  });

  it('LN+ rank multiplier produces max 50 points at rank 10', () => {
    expect(LNPLUS_RANK_MULTIPLIER * 10).toBe(50);
  });

  it('LN+ ratings + rank can reach 100', () => {
    // rank 10 * multiplier + ratio(1.0) * weight = max possible reputation
    const maxReputation = LNPLUS_RANK_MULTIPLIER * 10 + LNPLUS_RATINGS_WEIGHT;
    expect(maxReputation).toBe(100);
  });

  it('negative ratings penalty is positive and bounded', () => {
    expect(NEGATIVE_RATINGS_PENALTY).toBeGreaterThan(0);
    expect(NEGATIVE_RATINGS_PENALTY).toBeLessThanOrEqual(50);
  });

  it('confidence thresholds are strictly increasing', () => {
    expect(CONFIDENCE_VERY_LOW).toBeLessThan(CONFIDENCE_LOW);
    expect(CONFIDENCE_LOW).toBeLessThan(CONFIDENCE_MEDIUM);
    expect(CONFIDENCE_MEDIUM).toBeLessThan(CONFIDENCE_HIGH);
  });

  it('cache TTL is positive', () => {
    expect(SCORE_CACHE_TTL).toBeGreaterThan(0);
  });

  it('attestation half-life is positive', () => {
    expect(ATTESTATION_HALF_LIFE).toBeGreaterThan(0);
  });

  it('popularity bonus cap is reasonable', () => {
    expect(POPULARITY_BONUS_CAP).toBeGreaterThan(0);
    expect(POPULARITY_BONUS_CAP).toBeLessThanOrEqual(20);
  });

  it('verified tx bonus cap is reasonable', () => {
    expect(VERIFIED_TX_BONUS_CAP).toBeGreaterThan(0);
    expect(VERIFIED_TX_BONUS_CAP).toBeLessThanOrEqual(25);
  });

  it('centrality decay constant is positive', () => {
    expect(CENTRALITY_DECAY_CONSTANT).toBeGreaterThan(0);
    expect(CENTRALITY_BONUS_MULTIPLIER).toBeGreaterThan(0);
  });

  it('min attester age is at least 1 day', () => {
    expect(MIN_ATTESTER_AGE_DAYS).toBeGreaterThanOrEqual(1);
  });
});
