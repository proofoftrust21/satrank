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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
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
import { ingestBayesianObservation } from './helpers/bayesianTestFactory';
import type { Agent } from '../types';
let testDb: TestDb;

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
async function insertTx(
  db: Pool,
  txId: string,
  senderHash: string,
  receiverHash: string,
  endpointHash: string,
  source: 'probe' | 'observer' | 'report' | 'intent',
  ts: number,
  status: 'verified' | 'failed' = 'verified',
): Promise<void> {
  await db.query(
    `INSERT INTO transactions (
       tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
       payment_hash, preimage, status, protocol,
       endpoint_hash, operator_id, source, window_bucket
     ) VALUES ($1, $2, $3, 'micro', $4, $5, NULL, $6, 'bolt11', $7, $8, $9, $10)`,
    [
      txId, senderHash, receiverHash, ts,
      `${txId}:ph`, status,
      endpointHash, endpointHash, source,
      new Date(ts * 1000).toISOString().slice(0, 10),
    ],
  );
  // Phase 3 C9 : le verdict lit dans streaming_posteriors. intent reste exclu
  // par contrat (jamais ingéré) ; observer n'alimente que les daily_buckets
  // (CHECK constraint SQL sur streaming_posteriors).
  if (source !== 'intent') {
    await ingestBayesianObservation(db, {
      success: status === 'verified',
      timestamp: ts,
      source,
      endpointHash,
    });
  }
}

describe('mapTransactionSourceToBayesian — Q3 observer skip', async () => {
  let db: Pool;

  beforeAll(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  function makeVerdictService(): BayesianVerdictService {
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
    return new BayesianVerdictService(
      bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );
  }

  it('observer rows are NOT counted in verdict observations', async () => {
    const targetHash = 'ab'.repeat(32);
    const senderHash = 'cd'.repeat(32);
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(targetHash));
    await agentRepo.insert(makeAgent(senderHash));

    // Insert 10 observer rows — should all be invisible to verdict
    for (let i = 0; i < 10; i++) {
      await insertTx(db, `obs-${i}`, senderHash, targetHash, targetHash, 'observer', NOW - 60 - i);
    }

    const result = await makeVerdictService().buildVerdict({ targetHash });
    expect(result.n_obs).toBe(0);
    expect(result.sources.probe).toBeNull();
    expect(result.verdict).toBe('INSUFFICIENT');
  });

  it('probe rows ARE counted (observer rows do not shadow them)', async () => {
    const targetHash = 'ef'.repeat(32);
    const senderHash = 'aa'.repeat(32);
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(targetHash));
    await agentRepo.insert(makeAgent(senderHash));

    // 5 observer (ignored) + 3 probe (counted) rows on the same endpoint
    for (let i = 0; i < 5; i++) {
      await insertTx(db, `obs-mix-${i}`, senderHash, targetHash, targetHash, 'observer', NOW - 60 - i);
    }
    for (let i = 0; i < 3; i++) {
      await insertTx(db, `probe-mix-${i}`, senderHash, targetHash, targetHash, 'probe', NOW - 30 - i);
    }

    const result = await makeVerdictService().buildVerdict({ targetHash });
    expect(result.sources.probe).not.toBeNull();
    expect(result.sources.probe!.n_obs).toBeGreaterThan(0);
  });

  it('report rows remain counted under Q3 filter (probe/report/paid whitelist)', async () => {
    const targetHash = '11'.repeat(32);
    const senderHash = '22'.repeat(32);
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(targetHash));
    await agentRepo.insert(makeAgent(senderHash));

    for (let i = 0; i < 2; i++) {
      await insertTx(db, `rep-${i}`, senderHash, targetHash, targetHash, 'report', NOW - 10 - i);
    }

    const result = await makeVerdictService().buildVerdict({ targetHash });
    expect(result.sources.report).not.toBeNull();
    expect(result.sources.report!.n_obs).toBeGreaterThan(0);
  });

  it('intent rows are NOT counted (existing contract unchanged)', async () => {
    const targetHash = '33'.repeat(32);
    const senderHash = '44'.repeat(32);
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent(targetHash));
    await agentRepo.insert(makeAgent(senderHash));

    for (let i = 0; i < 10; i++) {
      await insertTx(db, `int-${i}`, senderHash, targetHash, targetHash, 'intent', NOW - 10 - i);
    }

    const result = await makeVerdictService().buildVerdict({ targetHash });
    expect(result.n_obs).toBe(0);
  });
});
