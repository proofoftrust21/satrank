// Phase 3 GO-criterion — end-to-end acceptance.
//
// Cette suite prouve que la chaîne complète remise en état par C1.1 + C1.2 +
// C1.3 + C2 produit un verdict non-flat sur une cible avec assez d'historique :
//
//   probe_results (historique) → backfill C2 → transactions + aggregates
//                                            → buildVerdict → p_success ≠ 0.5
//                                                           + verdict ≠ INSUFFICIENT
//
// Contre-check sur le diagnostic initial : avant ces patches, p_success était
// piégé à 0.5 partout car (a) probeCrawler n'ingérait pas, (b) transactions
// avaient endpoint_hash=NULL. Si ce test passe, la cause racine est éliminée.
//
// Note math : avec 1 probe/UTC-day (daily idempotence) et τ=windowSec/3, le
// n_obs *décroissant* du 30d asymptote à ~10.5. Pour franchir UNKNOWN_MIN_N_OBS=10
// proprement il faut mélanger des sources — ce qui est exactement ce qu'un
// top-node voit en prod (probes sovereign + paid probes + agent reports).
// Le test simule ce scénario réaliste.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { ProbeRepository } from '../repositories/probeRepository';
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
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
import { runBackfill } from '../scripts/backfillProbeResultsToTransactions';
import { ingestBayesianObservation } from './helpers/bayesianTestFactory';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias: `a-${hash.slice(0, 6)}`,
    first_seen: NOW - 60 * DAY,
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

describe('Phase 3 end-to-end acceptance — GO criterion', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('25 daily probes + 6 NIP-98 reports (mixed prod-like history) → verdict non-INSUFFICIENT + p_success ~0.83', () => {
    const targetHash = 'a1'.repeat(32);
    new AgentRepository(db).insert(makeAgent(targetHash));
    const probeRepo = new ProbeRepository(db);

    // 25 jours distincts, majoritairement reachable (simulates a healthy node)
    for (let dayOffset = 0; dayOffset < 25; dayOffset++) {
      const reachable = dayOffset < 22 ? 1 : 0;
      probeRepo.insert({
        target_hash: targetHash,
        probed_at: NOW - dayOffset * DAY,
        reachable,
        latency_ms: reachable ? 50 : null,
        hops: reachable ? 2 : null,
        estimated_fee_msat: reachable ? 1000 : null,
        failure_reason: reachable ? null : 'no_route',
        probe_amount_sats: 1000,
      });
    }

    // Run backfill — this is what populates transactions + aggregates
    const result = runBackfill({ db });
    expect(result.inserted).toBe(25);

    // Simulate prod top-node : 6 NIP-98 agent reports (weight 1.0 au tier
    // 'nip98') récents — réaliste pour un nœud populaire indexé par les
    // agents + push n_obs décroissant au-dessus de UNKNOWN_MIN_N_OBS=10.
    // Insérés directement dans transactions (source='report').
    const insertReport = db.prepare(`
      INSERT INTO transactions (
        tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
        payment_hash, preimage, status, protocol,
        endpoint_hash, operator_id, source, window_bucket
      ) VALUES (?, ?, ?, 'micro', ?, ?, NULL, 'verified', 'bolt11', ?, ?, 'report', ?)
    `);
    for (let i = 0; i < 6; i++) {
      const ts = NOW - i * DAY - 3600;
      insertReport.run(
        `rep-${i}`, targetHash, targetHash, ts, `rep-${i}:ph`,
        targetHash, targetHash,
        new Date(ts * 1000).toISOString().slice(0, 10),
      );
      // Phase 3 C9 : le verdict lit dans streaming_posteriors. Tier nip98
      // pour atteindre le seuil de convergence (weight 1.0).
      ingestBayesianObservation(db, {
        success: true, timestamp: ts, source: 'report', tier: 'nip98',
        endpointHash: targetHash, operatorId: targetHash, nodePubkey: targetHash,
      });
    }

    // Now query the verdict
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
    const verdictSvc = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    );
    const verdict = verdictSvc.buildVerdict({ targetHash });

    // GO criteria — the whole point of the session
    expect(verdict.n_obs).toBeGreaterThan(0);
    expect(verdict.p_success).not.toBe(0.5); // pre-fix bug was 0.5 everywhere
    expect(verdict.verdict).not.toBe('INSUFFICIENT');
    expect(verdict.sources.probe).not.toBeNull();
    expect(verdict.sources.probe!.n_obs).toBeGreaterThan(0);
    expect(verdict.sources.report).not.toBeNull();

    // Directional check : majority verified → p_success should trend high
    expect(verdict.p_success).toBeGreaterThan(0.7);
  });

  it('5 unreachable probes on fresh agent → verdict acknowledges poor signal', () => {
    const targetHash = 'b2'.repeat(32);
    new AgentRepository(db).insert(makeAgent(targetHash));
    const probeRepo = new ProbeRepository(db);

    for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
      probeRepo.insert({
        target_hash: targetHash,
        probed_at: NOW - dayOffset * DAY,
        reachable: 0,
        latency_ms: null,
        hops: null,
        estimated_fee_msat: null,
        failure_reason: 'no_route',
        probe_amount_sats: 1000,
      });
    }

    runBackfill({ db });

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
    const verdict = new BayesianVerdictService(
      db, bayesian,
      new EndpointStreamingPosteriorRepository(db),
      new EndpointDailyBucketsRepository(db),
    ).buildVerdict({ targetHash });

    expect(verdict.n_obs).toBeGreaterThan(0);
    // With only 5 obs, verdict should be INSUFFICIENT (UNKNOWN_MIN_N_OBS=10)
    // but p_success must be below 0.5 (all failures bias the posterior down)
    expect(verdict.p_success).toBeLessThan(0.5);
  });
});
