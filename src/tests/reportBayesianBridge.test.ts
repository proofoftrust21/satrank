// ReportService bayesian bridge — prove both submit() paths ingest into
// operator/endpoint streaming_posteriors + daily_buckets regardless of
// dualWriteMode.
//   (a) identified report (submit) → endpoint_hash=target + streaming ingestion
//   (b) anonymous report (submitAnonymous) → same
//   (c) Q1 contract: mode='off' must still ingest into streaming (scoring
//       signal decoupled from dualWriteMode flag).
//   (d) Q3 neighbor: intent (token_query_log hit) is classified source='intent'
//       and MUST NOT ingest (intent is not an observation of success/failure).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { ReportService } from '../services/reportService';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(hash: string, pubkey: string | null = null): Agent {
  return {
    public_key_hash: hash,
    public_key: pubkey,
    alias: `node-${hash.slice(0, 6)}`,
    first_seen: NOW - 30 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

function buildReportService(db: Database.Database, mode: 'off' | 'dry_run' | 'active') {
  const agentRepo = new AgentRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const txRepo = new TransactionRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
  const bayesian = new BayesianScoringService(
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
  const service = new ReportService(
    attestationRepo, agentRepo, txRepo, scoringService, db, mode, undefined, bayesian,
  );
  return { service, agentRepo };
}

describe('ReportService bayesian bridge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('submit() writes tx with endpoint_hash=target and bumps operator+endpoint streaming', () => {
    const reporterHash = 'aa'.repeat(32);
    const targetHash = 'bb'.repeat(32);
    const { service, agentRepo } = buildReportService(db, 'active');
    agentRepo.insert(makeAgent(reporterHash));
    agentRepo.insert(makeAgent(targetHash));

    service.submit({
      reporter: reporterHash,
      target: targetHash,
      outcome: 'success',
    });

    const tx = db.prepare(
      `SELECT endpoint_hash, operator_id, source, status FROM transactions WHERE receiver_hash = ?`,
    ).get(targetHash) as any;
    expect(tx.endpoint_hash).toBe(targetHash);
    expect(tx.operator_id).toBe(targetHash);
    expect(tx.source).toBe('report');
    expect(tx.status).toBe('verified');

    // Phase 3 streaming — le report identifié sans preimage produit une row
    // streaming source='report' ET bump les daily_buckets (operator + endpoint).
    const streamingOp = db.prepare(
      `SELECT source, total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(targetHash) as any;
    expect(streamingOp.source).toBe('report');
    expect(streamingOp.total_ingestions).toBe(1);

    const streamingEp = db.prepare(
      `SELECT source, total_ingestions FROM endpoint_streaming_posteriors WHERE url_hash = ?`,
    ).get(targetHash) as any;
    expect(streamingEp.source).toBe('report');
    expect(streamingEp.total_ingestions).toBe(1);

    const bucketOp = db.prepare(
      `SELECT n_obs, n_success FROM operator_daily_buckets WHERE operator_id = ? AND source = 'report'`,
    ).get(targetHash) as any;
    expect(bucketOp.n_obs).toBe(1);
    expect(bucketOp.n_success).toBe(1);
  });

  it('Q1 contract: mode=off still ingests streaming (decoupled from flag)', () => {
    const reporterHash = '11'.repeat(32);
    const targetHash = '22'.repeat(32);
    const { service, agentRepo } = buildReportService(db, 'off');
    agentRepo.insert(makeAgent(reporterHash));
    agentRepo.insert(makeAgent(targetHash));

    service.submit({
      reporter: reporterHash,
      target: targetHash,
      outcome: 'success',
    });

    // v31 enrichment NULL in legacy mode…
    const tx = db.prepare(
      `SELECT endpoint_hash, operator_id, source FROM transactions WHERE receiver_hash = ?`,
    ).get(targetHash) as any;
    expect(tx.endpoint_hash).toBeNull();
    expect(tx.operator_id).toBeNull();
    expect(tx.source).toBeNull();

    // …mais le streaming ingère quand même (scoring signal découplé du flag).
    const streaming = db.prepare(
      `SELECT total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(targetHash) as any;
    expect(streaming.total_ingestions).toBe(1);
  });

  it('failure outcome increments failure counter in daily_buckets', () => {
    const reporterHash = '33'.repeat(32);
    const targetHash = '44'.repeat(32);
    const { service, agentRepo } = buildReportService(db, 'active');
    agentRepo.insert(makeAgent(reporterHash));
    agentRepo.insert(makeAgent(targetHash));

    service.submit({
      reporter: reporterHash,
      target: targetHash,
      outcome: 'failure',
    });

    const bucket = db.prepare(
      `SELECT n_success, n_failure FROM operator_daily_buckets WHERE operator_id = ? AND source = 'report'`,
    ).get(targetHash) as any;
    expect(bucket.n_success).toBe(0);
    expect(bucket.n_failure).toBe(1);
  });

  it('intent classification skips ingestion (token_query_log hit → source=intent, no streaming)', () => {
    const reporterHash = '55'.repeat(32);
    const targetHash = '66'.repeat(32);
    const l402PaymentHash = Buffer.from('77'.repeat(32), 'hex');
    const { service, agentRepo } = buildReportService(db, 'active');
    agentRepo.insert(makeAgent(reporterHash));
    agentRepo.insert(makeAgent(targetHash));

    // Seed a token_query_log row so classifySource returns 'intent'
    db.prepare(`
      INSERT INTO token_query_log (payment_hash, target_hash, decided_at)
      VALUES (?, ?, ?)
    `).run(l402PaymentHash, targetHash, NOW);

    service.submit({
      reporter: reporterHash,
      target: targetHash,
      outcome: 'success',
      l402PaymentHash,
    });

    const tx = db.prepare(
      `SELECT source FROM transactions WHERE receiver_hash = ?`,
    ).get(targetHash) as any;
    expect(tx.source).toBe('intent');

    // intent must NOT contribute to streaming_posteriors ET daily_buckets :
    // un intent n'est pas une observation de succès/échec.
    const streamingCount = db.prepare(
      `SELECT COUNT(*) AS c FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(targetHash) as any;
    expect(streamingCount.c).toBe(0);
    const bucketsCount = db.prepare(
      `SELECT COUNT(*) AS c FROM operator_daily_buckets WHERE operator_id = ?`,
    ).get(targetHash) as any;
    expect(bucketsCount.c).toBe(0);
  });

  it('absent bayesian dep — legacy tx row only, no streaming', () => {
    const reporterHash = '88'.repeat(32);
    const targetHash = '99'.repeat(32);
    const agentRepo = new AgentRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const txRepo = new TransactionRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
    agentRepo.insert(makeAgent(reporterHash));
    agentRepo.insert(makeAgent(targetHash));

    const service = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    ); // no bayesian dep
    service.submit({
      reporter: reporterHash,
      target: targetHash,
      outcome: 'success',
    });

    const txCount = (db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get() as any).c;
    expect(txCount).toBe(1);

    const streamingCount = (db.prepare(`SELECT COUNT(*) AS c FROM operator_streaming_posteriors`).get() as any).c;
    expect(streamingCount).toBe(0);
  });
});
