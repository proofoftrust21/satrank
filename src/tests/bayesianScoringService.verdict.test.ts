// Tests C7 : computeVerdict (SAFE / RISKY / UNKNOWN / INSUFFICIENT).
// Focus : boundary tests, priorité RISKY > UNKNOWN, garde-fou convergence.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import {
  SAFE_P_THRESHOLD,
  SAFE_CI95_LOW_MIN,
  SAFE_MIN_N_OBS,
  RISKY_P_THRESHOLD,
  RISKY_CI95_HIGH_MAX,
  UNKNOWN_CI95_INTERVAL_MAX,
  UNKNOWN_MIN_N_OBS,
  CONVERGENCE_P_THRESHOLD,
} from '../config/bayesianConfig';

function makeService() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const svc = new BayesianScoringService(
    new EndpointAggregateRepository(db),
    new ServiceAggregateRepository(db),
    new OperatorAggregateRepository(db),
    new NodeAggregateRepository(db),
  );
  return { db, svc };
}

const CONVERGED = { converged: true, sourcesAboveThreshold: ['probe' as const, 'paid' as const], threshold: CONVERGENCE_P_THRESHOLD };
const NOT_CONVERGED = { converged: false, sourcesAboveThreshold: ['probe' as const], threshold: CONVERGENCE_P_THRESHOLD };
const NONE_CONVERGED = { converged: false, sourcesAboveThreshold: [], threshold: CONVERGENCE_P_THRESHOLD };

describe('computeVerdict', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => { env.db.close(); });

  describe('INSUFFICIENT', () => {
    it('verdict INSUFFICIENT quand n_obs < UNKNOWN_MIN_N_OBS', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.95, ci95Low: 0.85, ci95High: 0.99, nObs: UNKNOWN_MIN_N_OBS - 1 },
        CONVERGED,
      );
      expect(r.verdict).toBe('INSUFFICIENT');
    });

    it('INSUFFICIENT prime sur SAFE même avec p=1.0 et convergence', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 1.0, ci95Low: 0.95, ci95High: 1.0, nObs: 5 },
        CONVERGED,
      );
      expect(r.verdict).toBe('INSUFFICIENT');
    });
  });

  describe('RISKY', () => {
    it('RISKY quand p_success < RISKY_P_THRESHOLD (0.50)', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: RISKY_P_THRESHOLD - 0.01, ci95Low: 0.30, ci95High: 0.55, nObs: 50 },
        CONVERGED,
      );
      expect(r.verdict).toBe('RISKY');
      expect(r.reason).toMatch(/p_success/);
    });

    it('RISKY quand ci95_high < RISKY_CI95_HIGH_MAX (0.65)', () => {
      // p ≥ 0.50 pour ne pas matcher la première règle, mais ci95_high < 0.65
      const r = env.svc.computeVerdict(
        { pSuccess: 0.55, ci95Low: 0.45, ci95High: RISKY_CI95_HIGH_MAX - 0.01, nObs: 50 },
        CONVERGED,
      );
      expect(r.verdict).toBe('RISKY');
      expect(r.reason).toMatch(/ci95_high/);
    });

    it('RISKY prime sur UNKNOWN (IC large MAIS signal négatif clair)', () => {
      // IC très large (> 0.40) ET p < 0.50 → doit être RISKY, pas UNKNOWN
      const r = env.svc.computeVerdict(
        { pSuccess: 0.30, ci95Low: 0.10, ci95High: 0.60, nObs: 50 },
        CONVERGED,
      );
      expect(r.verdict).toBe('RISKY');
    });
  });

  describe('UNKNOWN', () => {
    it('UNKNOWN quand IC > UNKNOWN_CI95_INTERVAL_MAX (0.40)', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.70, ci95Low: 0.40, ci95High: 0.95, nObs: 50 }, // IC = 0.55
        CONVERGED,
      );
      expect(r.verdict).toBe('UNKNOWN');
      expect(r.reason).toMatch(/ci95_width/);
    });

    it('UNKNOWN fallback quand pas de convergence même avec p haut', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.90, ci95Low: 0.80, ci95High: 0.95, nObs: 50 },
        NOT_CONVERGED,
      );
      expect(r.verdict).toBe('UNKNOWN');
      expect(r.reason).toMatch(/convergence/);
    });

    it('UNKNOWN zone grise (p ok mais ci95_low insuffisant)', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.85, ci95Low: 0.60, ci95High: 0.92, nObs: 50 }, // p=0.85 ≥ 0.80 mais ci95_low=0.60 < 0.65
        CONVERGED,
      );
      expect(r.verdict).toBe('UNKNOWN');
    });
  });

  describe('SAFE', () => {
    it('SAFE si toutes les conditions alignées', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.92, ci95Low: 0.78, ci95High: 0.97, nObs: 50 },
        CONVERGED,
      );
      expect(r.verdict).toBe('SAFE');
    });

    it('SAFE boundary : p exactement égal au seuil', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: SAFE_P_THRESHOLD, ci95Low: SAFE_CI95_LOW_MIN, ci95High: 0.95, nObs: SAFE_MIN_N_OBS },
        CONVERGED,
      );
      expect(r.verdict).toBe('SAFE');
    });

    it('SAFE refusé si juste au-dessus mais non-convergence', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: SAFE_P_THRESHOLD, ci95Low: SAFE_CI95_LOW_MIN, ci95High: 0.95, nObs: SAFE_MIN_N_OBS },
        NONE_CONVERGED,
      );
      expect(r.verdict).not.toBe('SAFE');
    });

    it('SAFE refusé si n_obs boundary mais p manque', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: SAFE_P_THRESHOLD - 0.05, ci95Low: 0.70, ci95High: 0.95, nObs: SAFE_MIN_N_OBS },
        CONVERGED,
      );
      expect(r.verdict).toBe('UNKNOWN'); // p < 0.80 mais p ≥ 0.50 → zone grise
    });
  });

  describe('ordre de priorité', () => {
    it('INSUFFICIENT > RISKY (n_obs trop faible → INSUFFICIENT même si signal négatif)', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.20, ci95Low: 0.05, ci95High: 0.50, nObs: UNKNOWN_MIN_N_OBS - 1 },
        CONVERGED,
      );
      expect(r.verdict).toBe('INSUFFICIENT');
    });

    it('RISKY > UNKNOWN (signal négatif mais IC large → RISKY)', () => {
      const r = env.svc.computeVerdict(
        { pSuccess: 0.40, ci95Low: 0.10, ci95High: 0.75, nObs: 50 }, // p < 0.50 ET IC > 0.40
        CONVERGED,
      );
      expect(r.verdict).toBe('RISKY');
    });
  });
});
