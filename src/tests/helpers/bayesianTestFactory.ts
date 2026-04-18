// Shared factory for tests that need a BayesianVerdictService.
// Keeps the wiring in one place so signature changes to BayesianScoringService
// propagate in a single edit instead of across ~20 test files.
import type { Database } from 'better-sqlite3';
import { BayesianScoringService } from '../../services/bayesianScoringService';
import { BayesianVerdictService } from '../../services/bayesianVerdictService';
import { EndpointAggregateRepository } from '../../repositories/aggregatesRepository';
import { ServiceAggregateRepository } from '../../repositories/aggregatesRepository';
import { OperatorAggregateRepository } from '../../repositories/aggregatesRepository';
import { NodeAggregateRepository } from '../../repositories/aggregatesRepository';
import { RouteAggregateRepository } from '../../repositories/aggregatesRepository';
import { sha256 } from '../../utils/crypto';

export function createBayesianVerdictService(db: Database): BayesianVerdictService {
  const endpointAggRepo = new EndpointAggregateRepository(db);
  const serviceAggRepo = new ServiceAggregateRepository(db);
  const operatorAggRepo = new OperatorAggregateRepository(db);
  const nodeAggRepo = new NodeAggregateRepository(db);
  const routeAggRepo = new RouteAggregateRepository(db);
  const bayesianScoringService = new BayesianScoringService(
    endpointAggRepo, serviceAggRepo, operatorAggRepo, nodeAggRepo, routeAggRepo,
  );
  return new BayesianVerdictService(db, bayesianScoringService);
}

/** Seed enough Bayesian observations into the `transactions` table to produce a
 *  SAFE verdict for `targetHash` (≥2 converging sources, p≥0.80, ci95_low≥0.65,
 *  n_obs≥10). Use in integration tests that care about the overlay layer on top
 *  of a known-good posterior. The target agent must exist in `agents`. */
export function seedSafeBayesianObservations(
  db: Database,
  targetHash: string,
  options: { now?: number; nProbe?: number; nReport?: number } = {},
): void {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const nProbe = options.nProbe ?? 30;
  const nReport = options.nReport ?? 30;

  const callerHash = sha256(`bayes-caller-${targetHash.slice(0, 8)}`);
  db.prepare(`
    INSERT OR IGNORE INTO agents (public_key_hash, first_seen, last_seen, source)
    VALUES (?, ?, ?, 'manual')
  `).run(callerHash, now - 365 * 86400, now);

  const insert = db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol, endpoint_hash, source)
    VALUES (?, ?, ?, 'small', ?, ?, 'verified', 'l402', ?, ?)
  `);
  for (let i = 0; i < nProbe; i++) {
    const txId = `bayes-probe-${targetHash.slice(0, 8)}-${i}`;
    insert.run(txId, callerHash, targetHash, now - i * 60, sha256(txId), targetHash, 'probe');
  }
  for (let i = 0; i < nReport; i++) {
    const txId = `bayes-report-${targetHash.slice(0, 8)}-${i}`;
    insert.run(txId, callerHash, targetHash, now - i * 60, sha256(txId), targetHash, 'report');
  }
}
