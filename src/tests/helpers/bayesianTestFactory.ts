// Shared factory for tests that need a BayesianVerdictService.
// Keeps the wiring in one place so signature changes to BayesianScoringService
// propagate in a single edit instead of across ~20 test files.
import type { Database } from 'better-sqlite3';
import {
  BayesianScoringService,
  type StreamingIngestionInput,
} from '../../services/bayesianScoringService';
import { BayesianVerdictService } from '../../services/bayesianVerdictService';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../../repositories/aggregatesRepository';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../../repositories/dailyBucketsRepository';
import { sha256 } from '../../utils/crypto';

/** Construit un BayesianScoringService test-friendly (tous les 15 repos câblés
 *  sur la même DB). Utilisé par les tests qui ont besoin d'ingérer directement
 *  via `ingestStreaming` sans passer par les crawlers. */
export function createBayesianScoringService(db: Database): BayesianScoringService {
  return new BayesianScoringService(
    new EndpointAggregateRepository(db),
    new ServiceAggregateRepository(db),
    new OperatorAggregateRepository(db),
    new NodeAggregateRepository(db),
    new RouteAggregateRepository(db),
    new EndpointStreamingPosteriorRepository(db),
    new ServiceStreamingPosteriorRepository(db),
    new OperatorStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new RouteStreamingPosteriorRepository(db),
    new EndpointDailyBucketsRepository(db),
    new ServiceDailyBucketsRepository(db),
    new OperatorDailyBucketsRepository(db),
    new NodeDailyBucketsRepository(db),
    new RouteDailyBucketsRepository(db),
  );
}

/** Ingère une observation bayésienne streaming via BayesianScoringService
 *  (un seul call wire l'ensemble streaming_posteriors + daily_buckets).
 *  À utiliser depuis les tests qui veulent seed un posterior sans passer
 *  par les crawlers ou par la table `transactions`. */
export function ingestBayesianObservation(
  db: Database,
  input: StreamingIngestionInput,
): void {
  createBayesianScoringService(db).ingestStreaming(input);
}

export function createBayesianVerdictService(db: Database): BayesianVerdictService {
  const endpointAggRepo = new EndpointAggregateRepository(db);
  const serviceAggRepo = new ServiceAggregateRepository(db);
  const operatorAggRepo = new OperatorAggregateRepository(db);
  const nodeAggRepo = new NodeAggregateRepository(db);
  const routeAggRepo = new RouteAggregateRepository(db);
  const endpointStreamingRepo = new EndpointStreamingPosteriorRepository(db);
  const serviceStreamingRepo = new ServiceStreamingPosteriorRepository(db);
  const operatorStreamingRepo = new OperatorStreamingPosteriorRepository(db);
  const nodeStreamingRepo = new NodeStreamingPosteriorRepository(db);
  const routeStreamingRepo = new RouteStreamingPosteriorRepository(db);
  const endpointBucketsRepo = new EndpointDailyBucketsRepository(db);
  const serviceBucketsRepo = new ServiceDailyBucketsRepository(db);
  const operatorBucketsRepo = new OperatorDailyBucketsRepository(db);
  const nodeBucketsRepo = new NodeDailyBucketsRepository(db);
  const routeBucketsRepo = new RouteDailyBucketsRepository(db);
  const bayesianScoringService = new BayesianScoringService(
    endpointAggRepo, serviceAggRepo, operatorAggRepo, nodeAggRepo, routeAggRepo,
    endpointStreamingRepo, serviceStreamingRepo, operatorStreamingRepo, nodeStreamingRepo, routeStreamingRepo,
    endpointBucketsRepo, serviceBucketsRepo, operatorBucketsRepo, nodeBucketsRepo, routeBucketsRepo,
  );
  return new BayesianVerdictService(
    db, bayesianScoringService, endpointStreamingRepo, endpointBucketsRepo,
  );
}

/** Seed enough Bayesian observations into the streaming_posteriors + daily_buckets
 *  tables to produce a SAFE verdict for `targetHash` (≥2 converging sources,
 *  p≥0.80, ci95_low≥0.65, n_obs≥10). Use in integration tests that care about
 *  the overlay layer on top of a known-good posterior. The target agent must
 *  exist in `agents`.
 *
 *  Writes both transactions (legacy compat for tests that still read raw rows)
 *  AND streaming_posteriors (the new verdict source since C9). */
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

  // Streaming path — direct ingest par le scoring service pour avoir posteriors + buckets.
  const streamingEndpoint = new EndpointStreamingPosteriorRepository(db);
  const bucketsEndpoint = new EndpointDailyBucketsRepository(db);
  const scoring = new BayesianScoringService(
    new EndpointAggregateRepository(db),
    new ServiceAggregateRepository(db),
    new OperatorAggregateRepository(db),
    new NodeAggregateRepository(db),
    new RouteAggregateRepository(db),
    streamingEndpoint,
    new ServiceStreamingPosteriorRepository(db),
    new OperatorStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new RouteStreamingPosteriorRepository(db),
    bucketsEndpoint,
    new ServiceDailyBucketsRepository(db),
    new OperatorDailyBucketsRepository(db),
    new NodeDailyBucketsRepository(db),
    new RouteDailyBucketsRepository(db),
  );
  for (let i = 0; i < nProbe; i++) {
    scoring.ingestStreaming({
      success: true,
      timestamp: now - i * 60,
      source: 'probe',
      endpointHash: targetHash,
    });
  }
  for (let i = 0; i < nReport; i++) {
    scoring.ingestStreaming({
      success: true,
      timestamp: now - i * 60,
      source: 'report',
      tier: 'nip98',
      endpointHash: targetHash,
    });
  }
}
