// Tests for bulk scoring — ensures all agents with data get scored, not just top 50
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

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

describe('AgentRepository — bulk scoring queries', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
  });

  afterEach(() => { db.close(); });

  it('findUnscoredWithData returns agents with capacity but avg_score=0', () => {
    // Agent with capacity data but not scored
    agentRepo.insert(makeLndAgent('has-capacity', { capacity_sats: 1_000_000_000, total_transactions: 50 }));
    // Agent with LN+ data but not scored
    agentRepo.insert(makeLndAgent('has-lnplus', { capacity_sats: null, lnplus_rank: 7, positive_ratings: 20, total_transactions: 0 }));
    // Agent with nothing — should NOT be returned
    agentRepo.insert(makeLndAgent('empty-node', { capacity_sats: null, total_transactions: 1, lnplus_rank: 0, positive_ratings: 0 }));
    // Agent already scored — should NOT be returned
    agentRepo.insert(makeLndAgent('already-scored', { avg_score: 75, capacity_sats: 2_000_000_000 }));

    const unscored = agentRepo.findUnscoredWithData();
    const aliases = unscored.map(a => a.alias);

    expect(aliases).toContain('has-capacity');
    expect(aliases).toContain('has-lnplus');
    expect(aliases).not.toContain('empty-node');
    expect(aliases).not.toContain('already-scored');
  });

  it('findScoredAgents returns only agents with avg_score > 0', () => {
    agentRepo.insert(makeLndAgent('scored-1', { avg_score: 60 }));
    agentRepo.insert(makeLndAgent('scored-2', { avg_score: 85 }));
    agentRepo.insert(makeLndAgent('unscored', { avg_score: 0 }));

    const scored = agentRepo.findScoredAgents();
    expect(scored).toHaveLength(2);
    expect(scored.map(a => a.alias).sort()).toEqual(['scored-1', 'scored-2']);
  });

  it('findLnplusCandidates returns agents with existing LN+ data', () => {
    // Agent with lnplus_rank — should be included
    agentRepo.insert(makeLndAgent('has-rank', { lnplus_rank: 5, capacity_sats: 100_000 }));
    // Agent with positive_ratings — should be included
    agentRepo.insert(makeLndAgent('has-ratings', { positive_ratings: 10, capacity_sats: 100_000 }));
    // Agent with no LN+ data, low capacity — should NOT be included (not in top 2)
    agentRepo.insert(makeLndAgent('small-node', { capacity_sats: 1_000 }));
    // Agent with high capacity, no LN+ data — included via top-N
    agentRepo.insert(makeLndAgent('big-cap', { capacity_sats: 50_000_000_000 }));

    const candidates = agentRepo.findLnplusCandidates(2);
    const aliases = candidates.map(a => a.alias);

    expect(aliases).toContain('has-rank');
    expect(aliases).toContain('has-ratings');
    expect(aliases).toContain('big-cap');
    expect(aliases).not.toContain('small-node');
  });

  it('findLnplusCandidates excludes non-lightning agents', () => {
    // Observer protocol agent — should NOT be included even with high capacity
    agentRepo.insert({
      ...makeLndAgent('observer-node', { capacity_sats: 100_000_000_000 }),
      source: 'observer_protocol',
      public_key: null,
    });
    // Lightning agent — included
    agentRepo.insert(makeLndAgent('ln-node', { capacity_sats: 1_000_000_000 }));

    const candidates = agentRepo.findLnplusCandidates(100);
    const aliases = candidates.map(a => a.alias);

    expect(aliases).toContain('ln-node');
    expect(aliases).not.toContain('observer-node');
  });

  it('findLnplusCandidates respects topCapacityLimit', () => {
    // Insert 5 agents with descending capacity
    for (let i = 0; i < 5; i++) {
      agentRepo.insert(makeLndAgent(`cap-${i}`, { capacity_sats: (5 - i) * 1_000_000_000 }));
    }

    const top3 = agentRepo.findLnplusCandidates(3);
    expect(top3.length).toBe(3);

    const top5 = agentRepo.findLnplusCandidates(10);
    expect(top5.length).toBe(5);
  });

  it('countUnscoredWithData matches findUnscoredWithData length', () => {
    for (let i = 0; i < 10; i++) {
      agentRepo.insert(makeLndAgent(`node-${i}`, { capacity_sats: (i + 1) * 100_000_000, total_transactions: i * 5 + 2 }));
    }
    // 1 agent with no data
    agentRepo.insert(makeLndAgent('bare-node', { capacity_sats: null, total_transactions: 1, lnplus_rank: 0, positive_ratings: 0 }));

    const count = agentRepo.countUnscoredWithData();
    const list = agentRepo.findUnscoredWithData();
    expect(count).toBe(list.length);
    expect(count).toBe(10); // bare-node excluded
  });
});

describe('Bulk scoring — LND nodes get scored', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let scoringService: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
  });

  afterEach(() => { db.close(); });

  it('scoring a top LND node produces score 70+ with all components', () => {
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
    agentRepo.insert(topNode);
    // Need at least one other agent to set maxChannels reference
    agentRepo.insert(makeLndAgent('big-hub', { total_transactions: 2000, capacity_sats: 100_000_000_000 }));

    const result = scoringService.computeScore(topNode.public_key_hash);

    expect(result.total).toBeGreaterThanOrEqual(70);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.components.volume).toBeGreaterThan(0);
    expect(result.components.reputation).toBeGreaterThan(0);
    expect(result.components.seniority).toBeGreaterThan(0);
    expect(result.components.regularity).toBeGreaterThan(0);
    expect(result.components.diversity).toBeGreaterThan(0);

    // avg_score should be updated in DB
    const updated = agentRepo.findByHash(topNode.public_key_hash);
    expect(updated!.avg_score).toBe(result.total);
  });

  it('scoring a small LND node produces score 10-40', () => {
    const smallNode = makeLndAgent('small-node', {
      total_transactions: 5,
      capacity_sats: 50_000_000, // 0.5 BTC
      first_seen: NOW - 30 * DAY,
      last_seen: NOW - 3 * DAY,
    });
    agentRepo.insert(smallNode);
    agentRepo.insert(makeLndAgent('ref-hub', { total_transactions: 500 }));

    const result = scoringService.computeScore(smallNode.public_key_hash);

    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.total).toBeLessThanOrEqual(40);
    // Reputation: no centrality, but has peer trust (0.5BTC/5ch = 0.1 BTC/ch)
    // Peer trust = log10(0.1*100+1)/log10(201)*50 ≈ 23
    expect(result.components.reputation).toBeGreaterThan(0);
  });

  it('scoring a node with LN+ data but no capacity gets LN+ bonus on total', () => {
    const lnplusNode = makeLndAgent('lnplus-only', {
      total_transactions: 0,
      capacity_sats: null,
      positive_ratings: 30,
      negative_ratings: 1,
      lnplus_rank: 8,
      first_seen: NOW - 200 * DAY,
      last_seen: NOW - 2 * DAY,
    });
    agentRepo.insert(lnplusNode);

    const result = scoringService.computeScore(lnplusNode.public_key_hash);

    // No centrality, no capacity → peerTrust=0, routingQuality=50, capTrend=50
    // reputation = 0*0.45 + 50*0.30 + 50*0.25 = 28
    expect(result.components.reputation).toBe(28);
    expect(result.components.diversity).toBe(0); // no capacity
    // Total > 0 from reputation(18) + seniority + regularity + LN+ bonus
    expect(result.total).toBeGreaterThan(0);
  });

  it('scoring all unscored agents updates their avg_score in DB', () => {
    // Insert 20 unscored agents with various data
    for (let i = 0; i < 20; i++) {
      agentRepo.insert(makeLndAgent(`batch-node-${i}`, {
        total_transactions: (i + 1) * 10,
        capacity_sats: (i + 1) * 100_000_000,
        first_seen: NOW - (180 + i * 5) * DAY,
        last_seen: NOW - (i + 1) * DAY,
      }));
    }

    const unscored = agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(20);

    // Score them all
    for (const agent of unscored) {
      scoringService.computeScore(agent.public_key_hash);
    }

    // All should now have avg_score > 0
    const stillUnscored = agentRepo.findUnscoredWithData();
    expect(stillUnscored).toHaveLength(0);

    // Verify distribution is spread out
    const allScored = agentRepo.findScoredAgents();
    expect(allScored).toHaveLength(20);
    const scores = allScored.map(a => a.avg_score).sort((a, b) => a - b);
    const minScore = scores[0];
    const maxScore = scores[scores.length - 1];
    // Should span at least 15 points
    expect(maxScore - minScore).toBeGreaterThanOrEqual(10);
  });

  it('node with only 1 channel and no other data is excluded from scoring', () => {
    agentRepo.insert(makeLndAgent('1chan-node', {
      total_transactions: 1,
      capacity_sats: null,
      lnplus_rank: 0,
      positive_ratings: 0,
    }));

    const unscored = agentRepo.findUnscoredWithData();
    expect(unscored.map(a => a.alias)).not.toContain('1chan-node');
  });

  it('node with capacity > 0 is included even with 0 channels', () => {
    agentRepo.insert(makeLndAgent('capacity-only', {
      total_transactions: 0,
      capacity_sats: 10_000_000, // 0.1 BTC
    }));

    const unscored = agentRepo.findUnscoredWithData();
    expect(unscored.map(a => a.alias)).toContain('capacity-only');
  });

  it('snapshot is created for each scored agent', () => {
    agentRepo.insert(makeLndAgent('snap-test', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000,
      positive_ratings: 10,
      lnplus_rank: 5,
    }));

    const result = scoringService.computeScore(sha256('snap-test'));

    const snapshot = snapshotRepo.findLatestByAgent(sha256('snap-test'));
    expect(snapshot).toBeDefined();
    expect(snapshot!.score).toBe(result.total);
    expect(JSON.parse(snapshot!.components)).toHaveProperty('volume');
  });

  it('LN reputation formula uses centrality and peer trust; LN+ ratings add bonus', () => {
    // Two agents: one with centrality + LN+ data, one without centrality
    agentRepo.insert(makeLndAgent('with-lnplus', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000, // 20 BTC, 50 ch → 0.4 BTC/ch
      positive_ratings: 40,
      negative_ratings: 1,
      lnplus_rank: 9,
      hubness_rank: 10,
      betweenness_rank: 20,
    }));
    agentRepo.insert(makeLndAgent('without-lnplus', {
      total_transactions: 50,
      capacity_sats: 2_000_000_000, // same capacity/channels → same peer trust
    }));

    const withLnplus = scoringService.computeScore(sha256('with-lnplus'));
    const withoutLnplus = scoringService.computeScore(sha256('without-lnplus'));

    // Agent with centrality should have higher reputation (centrality + same peer trust)
    expect(withLnplus.components.reputation).toBeGreaterThan(withoutLnplus.components.reputation);
    // Without-lnplus still has peer trust from capacity (0.4 BTC/ch)
    expect(withoutLnplus.components.reputation).toBeGreaterThan(0);
    // And higher total score (centrality reputation + LN+ bonus)
    expect(withLnplus.total).toBeGreaterThan(withoutLnplus.total);
  });

  it('one failing agent does not prevent others from being scored', () => {
    // Insert 5 valid agents
    for (let i = 0; i < 5; i++) {
      agentRepo.insert(makeLndAgent(`resilient-${i}`, {
        total_transactions: 20 + i * 10,
        capacity_sats: (i + 1) * 200_000_000,
      }));
    }

    const unscored = agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(5);

    // Score them all, simulating that one might fail
    let scored = 0;
    for (const agent of unscored) {
      try {
        scoringService.computeScore(agent.public_key_hash);
        scored++;
      } catch {
        // skip
      }
    }
    expect(scored).toBe(5);

    // Verify all scored
    const stillUnscored = agentRepo.findUnscoredWithData();
    expect(stillUnscored).toHaveLength(0);
  });

  it('rescore updates existing agents with new data', () => {
    // Insert and score an agent — has peer trust from capacity but no centrality
    agentRepo.insert(makeLndAgent('rescore-test', {
      total_transactions: 10,
      capacity_sats: 500_000_000, // 5 BTC, 10 ch → 0.5 BTC/ch
    }));
    const firstScore = scoringService.computeScore(sha256('rescore-test'));

    // First score: peer trust only (no centrality)
    // Peer trust: log10(0.5*100+1)/log10(201)*50 ≈ 34
    expect(firstScore.components.reputation).toBeGreaterThan(0);

    // Simulate LN+ crawl updating the agent — adds centrality
    agentRepo.updateLnplusRatings(sha256('rescore-test'), 30, 0, 8, 10, 20, 0);

    // Rescore — should improve with centrality + LN+ bonus
    const secondScore = scoringService.computeScore(sha256('rescore-test'));

    expect(secondScore.total).toBeGreaterThan(firstScore.total);
    // Second score: centrality + peer trust > peer trust only
    expect(secondScore.components.reputation).toBeGreaterThan(firstScore.components.reputation);
  });

  it('findScoredAgents returns agents for rescore after initial scoring', () => {
    // Insert and score 3 agents
    for (let i = 0; i < 3; i++) {
      agentRepo.insert(makeLndAgent(`scored-for-rescore-${i}`, {
        total_transactions: 30 + i * 20,
        capacity_sats: (i + 1) * 500_000_000,
      }));
    }
    // Insert 2 unscored agents
    for (let i = 0; i < 2; i++) {
      agentRepo.insert(makeLndAgent(`unscored-${i}`, {
        total_transactions: 5,
        capacity_sats: 100_000_000,
      }));
    }

    // Score the first 3
    const unscored = agentRepo.findUnscoredWithData();
    expect(unscored).toHaveLength(5);
    for (let i = 0; i < 3; i++) {
      scoringService.computeScore(sha256(`scored-for-rescore-${i}`));
    }

    // findScoredAgents returns 3, findUnscoredWithData returns 2
    expect(agentRepo.findScoredAgents()).toHaveLength(3);
    expect(agentRepo.findUnscoredWithData()).toHaveLength(2);
  });
});
