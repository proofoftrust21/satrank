// Q3 Phase 3 — mapTransactionSourceToBayesian filter strict.
//
// Contract : source='observer' rows doivent être ÉCRITES (stats / catalogue)
// mais IGNORÉES par buildVerdict. Sinon les données Observer Protocol
// (bruit de broadcast non filtré) polluent les posteriors bayesiens.
//
// Ce test prouve :
//   (a) une row observer dans transactions n'apparaît pas dans les observations
//       consommées par loadObservations (n_obs = 0 côté verdict)
//   (b) une row probe dans le même test apparaît bien (n_obs >= 1)
//   (c) donc la discrimination entre sources est effective.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../repositories/aggregatesRepository';
import { AgentRepository } from '../repositories/agentRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
import { EndpointStreamingPosteriorRepository } from '../repositories/streamingPosteriorRepository';
import { EndpointDailyBucketsRepository } from '../repositories/dailyBucketsRepository';
import { ingestBayesianObservation } from './helpers/bayesianTestFactory';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias: `node-${hash.slice(0, 6)}`,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
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

/** Insert a raw transactions row with the 13-column enriched INSERT. Bypass
 *  the normal ReportService / ProbeCrawler path so we can unit-test the read
 *  mapping in isolation. */
function insertTx(
  db: Database.Database,
  txId: string,
  senderHash: string,
  receiverHash: string,
  endpointHash: string,
  source: 'probe' | 'observer' | 'report' | 'intent',
  ts: number,
  status: 'verified' | 'failed' = 'verified',
) {
  db.prepare(`
    INSERT INTO transactions (
      tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
      payment_hash, preimage, status, protocol,
      endpoint_hash, operator_id, source, window_bucket
    ) VALUES (?, ?, ?, 'micro', ?, ?, NULL, ?, 'bolt11', ?, ?, ?, ?)
  `).run(
    txId, senderHash, receiverHash, ts,
    `${txId}:ph`, status,
    endpointHash, endpointHash, source,
    new Date(ts * 1000).toISOString().slice(0, 10),
  );
  // Phase 3 C9 : le verdict lit dans streaming_posteriors. intent reste exclu
  // par contrat (jamais ingéré) ; observer n'alimente que les daily_buckets
  // (CHECK constraint SQL sur streaming_posteriors).
  if (source !== 'intent') {
    ingestBayesianObservation(db, {
      success: status === 'verified',
      timestamp: ts,
      source,
      endpointHash,
    });
  }
}

describe('mapTransactionSourceToBayesian — Q3 observer skip', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('observer rows are NOT counted in verdict observations', () => {
    const targetHash = 'ab'.repeat(32);
    const senderHash = 'cd'.repeat(32);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent(targetHash));
    agentRepo.insert(makeAgent(senderHash));

    // Insert 10 observer rows — should all be invisible to verdict
    for (let i = 0; i < 10; i++) {
      insertTx(db, `obs-${i}`, senderHash, targetHash, targetHash, 'observer', NOW - 60 - i);
    }

    const bayesian = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      new RouteAggregateRepository(db),
    );
    const verdict = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );

    const result = verdict.buildVerdict({ targetHash });
    expect(result.n_obs).toBe(0);
    expect(result.sources.probe).toBeNull();
    expect(result.verdict).toBe('INSUFFICIENT');
  });

  it('probe rows ARE counted (observer rows do not shadow them)', () => {
    const targetHash = 'ef'.repeat(32);
    const senderHash = 'aa'.repeat(32);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent(targetHash));
    agentRepo.insert(makeAgent(senderHash));

    // 5 observer (ignored) + 3 probe (counted) rows on the same endpoint
    for (let i = 0; i < 5; i++) {
      insertTx(db, `obs-mix-${i}`, senderHash, targetHash, targetHash, 'observer', NOW - 60 - i);
    }
    for (let i = 0; i < 3; i++) {
      insertTx(db, `probe-mix-${i}`, senderHash, targetHash, targetHash, 'probe', NOW - 30 - i);
    }

    const bayesian = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      new RouteAggregateRepository(db),
    );
    const verdict = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );

    const result = verdict.buildVerdict({ targetHash });
    expect(result.sources.probe).not.toBeNull();
    expect(result.sources.probe!.n_obs).toBeGreaterThan(0);
  });

  it('report rows remain counted under Q3 filter (probe/report/paid whitelist)', () => {
    const targetHash = '11'.repeat(32);
    const senderHash = '22'.repeat(32);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent(targetHash));
    agentRepo.insert(makeAgent(senderHash));

    for (let i = 0; i < 2; i++) {
      insertTx(db, `rep-${i}`, senderHash, targetHash, targetHash, 'report', NOW - 10 - i);
    }

    const bayesian = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      new RouteAggregateRepository(db),
    );
    const verdict = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );

    const result = verdict.buildVerdict({ targetHash });
    expect(result.sources.report).not.toBeNull();
    expect(result.sources.report!.n_obs).toBeGreaterThan(0);
  });

  it('intent rows are NOT counted (existing contract unchanged)', () => {
    const targetHash = '33'.repeat(32);
    const senderHash = '44'.repeat(32);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent(targetHash));
    agentRepo.insert(makeAgent(senderHash));

    for (let i = 0; i < 10; i++) {
      insertTx(db, `int-${i}`, senderHash, targetHash, targetHash, 'intent', NOW - 10 - i);
    }

    const bayesian = new BayesianScoringService(
      new EndpointAggregateRepository(db),
      new ServiceAggregateRepository(db),
      new OperatorAggregateRepository(db),
      new NodeAggregateRepository(db),
      new RouteAggregateRepository(db),
    );
    const verdict = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );

    const result = verdict.buildVerdict({ targetHash });
    expect(result.n_obs).toBe(0);
  });
});
