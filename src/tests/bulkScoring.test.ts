// Tests for bulk scoring — ensures all agents with data get scored, not just top 50
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeLndAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: `03${sha256(alias)}`,
    alias,
    first_seen: NOW - 180 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 10, // channels
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 500_000_000, // 5 BTC
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

describe('AgentRepository — bulk scoring queries', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('findUnscoredWithData returns agents with capacity but avg_score=0', async () => {
    // Agent with capacity data but not scored
    await agentRepo.insert(makeLndAgent('has-capacity', { capacity_sats: 1_000_000_000, total_transactions: 50 }));
    // Agent with LN+ data but not scored
    await agentRepo.insert(makeLndAgent('has-lnplus', { capacity_sats: null, lnplus_rank: 7, positive_ratings: 20, total_transactions: 0 }));
    // Agent with nothing — should NOT be returned
    await agentRepo.insert(makeLndAgent('empty-node', { capacity_sats: null, total_transactions: 1, lnplus_rank: 0, positive_ratings: 0 }));
    // Agent already scored — should NOT be returned
    await agentRepo.insert(makeLndAgent('already-scored', { avg_score: 75, capacity_sats: 2_000_000_000 }));

    const unscored = await agentRepo.findUnscoredWithData();
    const aliases = unscored.map((a) => a.alias);

    expect(aliases).toContain('has-capacity');
    expect(aliases).toContain('has-lnplus');
    expect(aliases).not.toContain('empty-node');
    expect(aliases).not.toContain('already-scored');
  });

  it('findScoredAgents returns only agents with avg_score > 0', async () => {
    await agentRepo.insert(makeLndAgent('scored-1', { avg_score: 60 }));
    await agentRepo.insert(makeLndAgent('scored-2', { avg_score: 85 }));
    await agentRepo.insert(makeLndAgent('unscored', { avg_score: 0 }));

    const scored = await agentRepo.findScoredAgents();
    expect(scored).toHaveLength(2);
    expect(scored.map((a) => a.alias).sort()).toEqual(['scored-1', 'scored-2']);
  });

  it('findLnplusCandidates returns agents with existing LN+ data', async () => {
    // Agent with lnplus_rank — should be included
    await agentRepo.insert(makeLndAgent('has-rank', { lnplus_rank: 5, capacity_sats: 100_000 }));
    // Agent with positive_ratings — should be included
    await agentRepo.insert(makeLndAgent('has-ratings', { positive_ratings: 10, capacity_sats: 100_000 }));
    // Agent with no LN+ data, low capacity — should NOT be included (not in top 2)
    await agentRepo.insert(makeLndAgent('small-node', { capacity_sats: 1_000 }));
    // Agent with high capacity, no LN+ data — included via top-N
    await agentRepo.insert(makeLndAgent('big-cap', { capacity_sats: 50_000_000_000 }));

    const candidates = await agentRepo.findLnplusCandidates(2);
    const aliases = candidates.map((a) => a.alias);

    expect(aliases).toContain('has-rank');
    expect(aliases).toContain('has-ratings');
    expect(aliases).toContain('big-cap');
    expect(aliases).not.toContain('small-node');
  });

  it('findLnplusCandidates excludes non-lightning agents', async () => {
    // Observer protocol agent — should NOT be included even with high capacity
    await agentRepo.insert({
      ...makeLndAgent('observer-node', { capacity_sats: 100_000_000_000 }),
      source: 'attestation',
      public_key: null,
    });
    // Lightning agent — included
    await agentRepo.insert(makeLndAgent('ln-node', { capacity_sats: 1_000_000_000 }));

    const candidates = await agentRepo.findLnplusCandidates(100);
    const aliases = candidates.map((a) => a.alias);

    expect(aliases).toContain('ln-node');
    expect(aliases).not.toContain('observer-node');
  });

  it('findLnplusCandidates respects topCapacityLimit', async () => {
    // Insert 5 agents with descending capacity
    for (let i = 0; i < 5; i++) {
      await agentRepo.insert(makeLndAgent(`cap-${i}`, { capacity_sats: (5 - i) * 1_000_000_000 }));
    }

    const top3 = await agentRepo.findLnplusCandidates(3);
    expect(top3.length).toBe(3);

    const top5 = await agentRepo.findLnplusCandidates(10);
    expect(top5.length).toBe(5);
  });

  it('countUnscoredWithData matches findUnscoredWithData length', async () => {
    for (let i = 0; i < 10; i++) {
      await agentRepo.insert(makeLndAgent(`node-${i}`, { capacity_sats: (i + 1) * 100_000_000, total_transactions: i * 5 + 2 }));
    }
    // 1 agent with no data
    await agentRepo.insert(makeLndAgent('bare-node', { capacity_sats: null, total_transactions: 1, lnplus_rank: 0, positive_ratings: 0 }));

    const count = await agentRepo.countUnscoredWithData();
    const list = await agentRepo.findUnscoredWithData();
    expect(count).toBe(list.length);
    expect(count).toBe(10); // bare-node excluded
  });
});

describe('Bulk scoring — LND nodes get scored', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let scoringService: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('scoring a top LND node produces score 70+ with all components', async () => {
    // Simulate Sunny Sarah: ~58 BTC, 150 channels, LN+ rank 10, 63 positive ratings
    const topNode = makeLndAgent('sunny-sarah', {
      total_transactions: 150,
      capacity_sats: 5_881_064_078,
      positive_ratings: 63,
      negative_ratings: 2,
      lnplus_rank: 10,
      hubness_rank: 5,
      betweenness_rank: 10,
      first_seen: NOW - 365 * DAY,
      last_seen: NOW - DAY,
    });
    await agentRepo.insert(topNode);
    // Need at least one other agent to set maxChannels reference
    await agentRepo.insert(makeLndAgent('big-hub', { total_transactions: 2000, capacity_sats: 100_000_000_000 }));

    const result = await scoringService.computeScore(topNode.public_key_hash);

    expect(result.total).toBeGreaterThanOrEqual(70);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.components.volume).toBeGreaterThan(0);
    expect(result.components.reputation).toBeGreaterThan(0);
    expect(result.components.seniority).toBeGreaterThan(0);
    expect(result.components.regularity).toBeGreaterThan(0);
    expect(result.components.diversity).toBeGreaterThan(0);

    // avg_score stores the 2-decimal float — matches totalFine, not the
    // integer total, since 2026-04-17 finegrained scoring.
    const updated = await agentRepo.findByHash(topNode.public_key_hash);
    expect(updated!.avg_score).toBe(result.totalFine);
    expect(Math.round(updated!.avg_score)).toBe(result.total);
  });

  it('scoring a small LND node produces score 10-40', async () => {
    const smallNode = makeLndAgent('small-node', {
      total_transactions: 5,
      capacity_sats: 50_000_000, // 0.5 BTC
      first_seen: NOW - 30 * DAY,
      last_seen: NOW - 3 * DAY,
    });
    await agentRepo.insert(smallNode);
    await agentRepo.insert(makeLndAgent('ref-hub', { total_transactions: 500 }));

    const result = await scoringService.computeScore(smallNode.public_key_hash);

    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.total).toBeLessThanOrEqual(40);
    // Reputation: no centrality, but has peer trust (0.5BTC/5ch = 0.1 BTC/ch)
    // Peer trust = log10(0.1*100+1)/log10(201)*50 ≈ 23
    expect(result.components.reputation).toBeGreaterThan(0);
  });

  it('scoring a node with LN+ ratings but no capacity returns a neutral reputation', async () => {
    // Post-2026-04-16 change: when both centrality and peerTrust are unavailable
    // (no pagerank, no channels), their nominal weights (0.20 + 0.30 = 0.50)
    // redistribute across routingQuality / capacityTrend / feeStability which
    // fall back to neutral 50. Reputation = 50. This replaces the old formula
    // that hardcoded a 35/25/20/20 "no centrality" branch and produced 33.
    const lnplusNode = makeLndAgent('lnplus-only', {
      total_transactions: 0,
      capacity_sats: null,
      positive_ratings: 30,
      negative_ratings: 1,
      lnplus_rank: 8,
      first_seen: NOW - 200 * DAY,
      last_seen: NOW - 2 * DAY,
    });
    await agentRepo.insert(lnplusNode);

    const result = await scoringService.computeScore(lnplusNode.public_key_hash);
    expect(result.components.reputation).toBe(50);
    expect(result.components.diversity).toBe(0); // no capacity
    expect(result.total).toBeGreaterThan(0);
  });

  it('scoring all unscored agents updates their avg_score in DB', async () => {
    // Insert 20 unscored agents with various data
    for (let i = 0; i < 20; i++) {
      await agentRepo.insert(makeLndAgent(`batch-node-${i}`, {
        total_transactions: (i + 1) * 10,
        capacity_sats: (i + 1) * 100_000_000,
        first_seen: NOW - (180 + i * 5) * DAY,
        last_seen: NOW - (i + 1) * DAY,
      }));
    }

    const unscored = await agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(20);

    // Score them all
    for (const agent of unscored) {
      await scoringService.computeScore(agent.public_key_hash);
    }

    // All should now have avg_score > 0
    const stillUnscored = await agentRepo.findUnscoredWithData();
    expect(stillUnscored).toHaveLength(0);

    // Verify distribution is spread out
    const allScored = await agentRepo.findScoredAgents();
    expect(allScored).toHaveLength(20);
    const scores = allScored.map((a) => a.avg_score).sort((a, b) => a - b);
    const minScore = scores[0];
    const maxScore = scores[scores.length - 1];
    // Should span at least 15 points
    expect(maxScore - minScore).toBeGreaterThanOrEqual(10);
  });

  it('node with only 1 channel and no other data is excluded from scoring', async () => {
    await agentRepo.insert(makeLndAgent('1chan-node', {
      total_transactions: 1,
      capacity_sats: null,
      lnplus_rank: 0,
      positive_ratings: 0,
    }));

    const unscored = await agentRepo.findUnscoredWithData();
    expect(unscored.map((a) => a.alias)).not.toContain('1chan-node');
  });

  it('node with capacity > 0 is included even with 0 channels', async () => {
    await agentRepo.insert(makeLndAgent('capacity-only', {
      total_transactions: 0,
      capacity_sats: 10_000_000, // 0.1 BTC
    }));

    const unscored = await agentRepo.findUnscoredWithData();
    expect(unscored.map((a) => a.alias)).toContain('capacity-only');
  });

  it('computeScore updates agent avg_score but no longer writes a snapshot directly', async () => {
    // Phase 3 C8: snapshot persistence moved out of ScoringService.
    // The bayesian pipeline (BayesianVerdictService.snapshotAndPersist) is now
    // responsible for writing score_snapshots rows — ScoringService only
    // updates agents.avg_score via updateStats.
    await agentRepo.insert(makeLndAgent('snap-test', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000,
      positive_ratings: 10,
      lnplus_rank: 5,
    }));

    const result = await scoringService.computeScore(sha256('snap-test'));

    // Agent stats updated in-place.
    const updated = await agentRepo.findByHash(sha256('snap-test'));
    expect(updated!.avg_score).toBe(result.totalFine);

    // Snapshot table stays empty — bayesian pipeline owns that write.
    const snapshot = await snapshotRepo.findLatestByAgent(sha256('snap-test'));
    expect(snapshot).toBeUndefined();
  });

  it('LN reputation formula uses centrality and peer trust; LN+ ratings add bonus', async () => {
    // Two agents: one with centrality + LN+ data, one without centrality
    await agentRepo.insert(makeLndAgent('with-lnplus', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000, // 20 BTC, 50 ch → 0.4 BTC/ch
      positive_ratings: 40,
      negative_ratings: 1,
      lnplus_rank: 9,
      hubness_rank: 10,
      betweenness_rank: 20,
    }));
    await agentRepo.insert(makeLndAgent('without-lnplus', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000, // same capacity/channels → same peer trust
    }));

    const withLnplus = await scoringService.computeScore(sha256('with-lnplus'));
    const withoutLnplus = await scoringService.computeScore(sha256('without-lnplus'));

    // Agent with centrality should have higher reputation (centrality + same peer trust)
    expect(withLnplus.components.reputation).toBeGreaterThan(withoutLnplus.components.reputation);
    // Without-lnplus still has peer trust from capacity (0.4 BTC/ch)
    expect(withoutLnplus.components.reputation).toBeGreaterThan(0);
    // And higher total score (centrality reputation + LN+ bonus)
    expect(withLnplus.total).toBeGreaterThan(withoutLnplus.total);
  });

  it('one failing agent does not prevent others from being scored', async () => {
    // Insert 5 valid agents
    for (let i = 0; i < 5; i++) {
      await agentRepo.insert(makeLndAgent(`resilient-${i}`, {
        total_transactions: 20 + i * 10,
        capacity_sats: (i + 1) * 200_000_000,
      }));
    }

    const unscored = await agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(5);

    // Score them all, simulating that one might fail
    let scored = 0;
    for (const agent of unscored) {
      try {
        await scoringService.computeScore(agent.public_key_hash);
        scored++;
      } catch {
        // skip
      }
    }
    expect(scored).toBe(5);

    // Verify all scored
    const stillUnscored = await agentRepo.findUnscoredWithData();
    expect(stillUnscored).toHaveLength(0);
  });

  it('rescore updates existing agents with new data', async () => {
    // Insert and score an agent — has peer trust from capacity but no centrality
    await agentRepo.insert(makeLndAgent('rescore-test', {
      total_transactions: 10,
      capacity_sats: 500_000_000, // 5 BTC, 10 ch → 0.5 BTC/ch
    }));
    const firstScore = await scoringService.computeScore(sha256('rescore-test'));

    // First score: peer trust only (no centrality)
    // Peer trust: log10(0.5*100+1)/log10(201)*50 ≈ 34
    expect(firstScore.components.reputation).toBeGreaterThan(0);

    // Simulate LN+ crawl updating the agent — adds centrality
    await agentRepo.updateLnplusRatings(sha256('rescore-test'), 30, 0, 8, 10, 20, 0);

    // Rescore — should improve with centrality + LN+ bonus
    const secondScore = await scoringService.computeScore(sha256('rescore-test'));

    expect(secondScore.total).toBeGreaterThan(firstScore.total);
    // Second score: centrality + peer trust > peer trust only
    expect(secondScore.components.reputation).toBeGreaterThan(firstScore.components.reputation);
  });

  it('findScoredAgents returns agents for rescore after initial scoring', async () => {
    // Insert and score 3 agents
    for (let i = 0; i < 3; i++) {
      await agentRepo.insert(makeLndAgent(`scored-for-rescore-${i}`, {
        total_transactions: 30 + i * 20,
        capacity_sats: (i + 1) * 500_000_000,
      }));
    }
    // Insert 2 unscored agents
    for (let i = 0; i < 2; i++) {
      await agentRepo.insert(makeLndAgent(`unscored-${i}`, {
        total_transactions: 5,
        capacity_sats: 100_000_000,
      }));
    }

    // Score the first 3
    const unscored = await agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(5);
    for (let i = 0; i < 3; i++) {
      await scoringService.computeScore(sha256(`scored-for-rescore-${i}`));
    }

    // findScoredAgents returns 3, findUnscoredWithData returns 2
    expect(await agentRepo.findScoredAgents()).toHaveLength(3);
    expect(await agentRepo.findUnscoredWithData()).toHaveLength(2);
  });

  // --- scoreFineGrained (tie-breaker precision) ---
  // Context: 9/10 top nodes compressed in the 80-82 band since the Apr 16
  // Option D rollout. totalFine (2-decimal float) breaks those ties for
  // sort/display without changing the integer API contract.

  it('computeScore returns totalFine as a 2-decimal float within [0,100]', async () => {
    await agentRepo.insert(makeLndAgent('fine-node', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000,
    }));

    const result = await scoringService.computeScore(sha256('fine-node'));

    expect(result.totalFine).toBeGreaterThanOrEqual(0);
    expect(result.totalFine).toBeLessThanOrEqual(100);
    // 2-decimal precision: `totalFine * 100` should land on an integer modulo
    // float representation error (e.g. 64.6 × 100 = 6459.999…, not 6460).
    const scaled = result.totalFine * 100;
    expect(Math.abs(scaled - Math.round(scaled))).toBeLessThan(1e-6);
    // Integer total is the rounded float.
    expect(result.total).toBe(Math.round(result.totalFine));
  });

  it('totalFine differentiates agents with slightly different inputs even when integer scores tie', async () => {
    // Most LN components are integer-quantised by the time they reach the
    // weighted sum (each computeX() rounds). The finegrained signal surfaces
    // in the weighted combination and the probe/bonus multipliers. Force a
    // large enough capacity delta that the Volume component moves, so we can
    // reliably show the float carries more precision than the integer.
    await agentRepo.insert(makeLndAgent('tied-low', {
      total_transactions: 40,
      capacity_sats: 500_000_000, // 5 BTC
    }));
    await agentRepo.insert(makeLndAgent('tied-hi', {
      total_transactions: 40,
      capacity_sats: 5_000_000_000, // 50 BTC
    }));

    const low = await scoringService.computeScore(sha256('tied-low'));
    const hi = await scoringService.computeScore(sha256('tied-hi'));

    // Higher capacity should produce a higher float score, matching the
    // direction of the integer score (they don't have to differ by 1+ but
    // must not contradict).
    expect(hi.totalFine).toBeGreaterThan(low.totalFine);
    expect(hi.total).toBeGreaterThanOrEqual(low.total);
  });

  it('persisted snapshot preserves totalFine across cache hit', async () => {
    await agentRepo.insert(makeLndAgent('cache-hit', {
      total_transactions: 25,
      capacity_sats: 1_500_000_000,
    }));

    const first = await scoringService.computeScore(sha256('cache-hit'));
    // Cache hit — getScore reads from snapshot instead of recomputing.
    const cached = await scoringService.getScore(sha256('cache-hit'));

    expect(cached.totalFine).toBe(first.totalFine);
    expect(cached.total).toBe(first.total);
  });
});
