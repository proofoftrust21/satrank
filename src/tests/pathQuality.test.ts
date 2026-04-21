import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { TrendService } from '../services/trendService';
import { RiskService } from '../services/riskService';
import { VerdictService } from '../services/verdictService';
import { SurvivalService } from '../services/survivalService';
import { DecideService } from '../services/decideService';
import { createBayesianVerdictService, seedSafeBayesianObservations } from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
let testDb: TestDb;

// --- computePathQuality unit tests (exported for direct testing) ---
// The function is private in decideService — we test it indirectly via
// the decide() response. For the pure algorithm, we replicate the logic
// here to verify edge cases without needing a full wired service.
function computePathQuality(
  pathfinding: { reachable: boolean; hops: number | null; estimatedFeeMsat: number | null; alternatives: number } | null,
  amountSats: number | undefined,
): number {
  if (!pathfinding) return 0.5;
  if (!pathfinding.reachable) return 0.0;
  const hops = pathfinding.hops ?? 1;
  const alternatives = pathfinding.alternatives ?? 1;
  const feeMsat = pathfinding.estimatedFeeMsat ?? 0;
  const hopPenalty = Math.max(0.12, 1 - (hops - 1) * 0.08);
  const altBonus = Math.min(1, 0.8 + alternatives * 0.1);
  const feeBudgetMsat = (amountSats ?? 1000) * 0.01 * 1000;
  const feeScore = feeBudgetMsat > 0 ? 1 - Math.min(1, feeMsat / feeBudgetMsat) : 1.0;
  return hopPenalty * 0.5 + altBonus * 0.3 + feeScore * 0.2;
}

describe('computePathQuality', () => {
  it('returns 0.5 (neutral) when pathfinding is null', async () => {
    expect(computePathQuality(null, undefined)).toBe(0.5);
  });

  it('returns 0.0 when route is not reachable', async () => {
    expect(computePathQuality({ reachable: false, hops: null, estimatedFeeMsat: null, alternatives: 0 }, undefined)).toBe(0.0);
  });

  it('returns near 1.0 for 1-hop direct channel with 0 fee', async () => {
    const pq = computePathQuality({ reachable: true, hops: 1, estimatedFeeMsat: 0, alternatives: 1 }, 1000);
    // hopPenalty=1.0 altBonus=0.9 feeScore=1.0 → 0.5+0.27+0.2=0.97
    expect(pq).toBeCloseTo(0.97, 2);
  });

  it('degrades for 5-hop route', async () => {
    const pq = computePathQuality({ reachable: true, hops: 5, estimatedFeeMsat: 0, alternatives: 1 }, 1000);
    // hopPenalty=0.68 altBonus=0.9 feeScore=1.0 → 0.34+0.27+0.20=0.81
    expect(pq).toBeLessThan(0.85);
    expect(pq).toBeGreaterThan(0.5);
  });

  it('rewards multiple alternatives', async () => {
    const pq1 = computePathQuality({ reachable: true, hops: 3, estimatedFeeMsat: 0, alternatives: 1 }, 1000);
    const pq3 = computePathQuality({ reachable: true, hops: 3, estimatedFeeMsat: 0, alternatives: 3 }, 1000);
    expect(pq3).toBeGreaterThan(pq1);
  });

  it('penalises high fees relative to amount', async () => {
    const pqLow = computePathQuality({ reachable: true, hops: 2, estimatedFeeMsat: 100, alternatives: 1 }, 1000);
    const pqHigh = computePathQuality({ reachable: true, hops: 2, estimatedFeeMsat: 50000, alternatives: 1 }, 1000);
    expect(pqLow).toBeGreaterThan(pqHigh);
  });

  it('uses default 1000 sats when amountSats is undefined', async () => {
    // feeBudget = 1000 * 0.01 * 1000 = 10000 msat = 10 sats
    const pq = computePathQuality({ reachable: true, hops: 1, estimatedFeeMsat: 5000, alternatives: 1 }, undefined);
    // feeScore = 1 - 5000/10000 = 0.5
    expect(pq).toBeLessThan(0.97); // lower than zero-fee
    expect(pq).toBeGreaterThan(0.7);
  });
});

// --- Non-regression: ACINQ-like agent should keep high successRate ---
describe('decide / pathQuality non-regression', async () => {
  let db: Pool;
  let decideService: DecideService;
  const testPubkey = '03aaaa025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
  const testHash = sha256(testPubkey);

  beforeAll(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    const agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const riskService = new RiskService();
    const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, createBayesianVerdictService(db), probeRepo);
    const survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
    decideService = new DecideService({
      agentRepo, attestationRepo, scoringService, trendService, riskService,
      verdictService, probeRepo, survivalService,
    });

    const now = Math.floor(Date.now() / 1000);
    // Directly insert a pre-scored agent via raw SQL to bypass INSERT
    // column requirements that vary across migrations.
    await db.query(
      `INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
        total_transactions, avg_score, capacity_sats, hubness_rank, betweenness_rank, lnplus_rank, unique_peers)
       VALUES ($1, $2, 'ACINQ-test', $3, $4, 'lightning_graph', 2000, 97, 38000000000, 4, 1, 10, 500)`,
      [testHash, testPubkey, now - 8 * 365 * 86400, now],
    );

    // Bayesian posterior snapshot consistent with a high-trust ACINQ-like node.
    await snapshotRepo.insert({
      snapshot_id: 'test-snap-1',
      agent_hash: testHash,
      p_success: 0.97,
      ci95_low: 0.92,
      ci95_high: 0.99,
      n_obs: 50,
      posterior_alpha: 1.5 + 50 * 0.97,
      posterior_beta: 1.5 + 50 * 0.03,
      window: '7d',
      computed_at: now,
      updated_at: now,
    });
    // Reachable probe
    await probeRepo.insert({
      target_hash: testHash,
      probed_at: now,
      reachable: 1,
      latency_ms: 50,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: null,
    });
    // Bayesian posterior: seed converging observations so verdict is SAFE.
    // Under the new decide semantics, go=true requires verdict=SAFE.
    await seedSafeBayesianObservations(db, testHash, { now });
  });

  afterAll(async () => { await teardownTestPool(testDb); });

  it('ACINQ-like agent keeps successRate >= 0.50 and go=true (non-regression)', async () => {
    const callerHash = sha256('test-caller');
    const result = await decideService.decide(testHash, callerHash, 1000);

    expect(result.go).toBe(true);
    expect(result.successRate).toBeGreaterThanOrEqual(0.50);
    // pathQuality = 0.5 (neutral — no LND client, so no pathfinding data)
    expect(result.components.pathQuality).toBe(0.5);
  });

  it('response includes all 3 components as numbers in [0,1]', async () => {
    const callerHash = sha256('test-caller');
    const result = await decideService.decide(testHash, callerHash);

    for (const key of ['routable', 'available', 'pathQuality'] as const) {
      expect(typeof result.components[key]).toBe('number');
      expect(result.components[key]).toBeGreaterThanOrEqual(0);
      expect(result.components[key]).toBeLessThanOrEqual(1);
    }
  });
});
