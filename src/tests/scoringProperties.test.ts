// Scoring property tests — logical invariants that must hold regardless of tuning
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { v4 as uuid } from 'uuid';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction, Attestation } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
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
    ...overrides,
  };
}

function makeTx(sender: string, receiver: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    tx_id: uuid(),
    sender_hash: sender,
    receiver_hash: receiver,
    amount_bucket: 'small',
    timestamp: NOW - Math.floor(Math.random() * 30 * DAY),
    payment_hash: sha256(uuid()),
    preimage: sha256(uuid()),
    status: 'verified',
    protocol: 'l402',
    ...overrides,
  };
}

function makeAttestation(attester: string, subject: string, txId: string, overrides: Partial<Attestation> = {}): Attestation {
  return {
    attestation_id: uuid(),
    tx_id: txId,
    attester_hash: attester,
    subject_hash: subject,
    score: 85,
    tags: null,
    evidence_hash: null,
    timestamp: NOW - Math.floor(Math.random() * 10 * DAY),
    category: 'general',
    verified: 0,
    weight: 1.0,
    ...overrides,
  };
}

describe('Scoring properties', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let scoring: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  // --- Volume ---

  it('agent with 1000 channels > agent with 10 channels in volume', async () => {
    await agentRepo.insert(makeAgent('big-node', {
      source: 'lightning_graph',
      total_transactions: 1000,
      first_seen: NOW - 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('small-node', {
      source: 'lightning_graph',
      total_transactions: 10,
      first_seen: NOW - 365 * DAY,
    }));

    const big = await scoring.computeScore(sha256('big-node'));
    const small = await scoring.computeScore(sha256('small-node'));

    expect(big.components.volume).toBeGreaterThan(small.components.volume);
  });

  // --- Reputation ---

  it('agent with centrality and capacity > agent without in reputation; LN+ ratings boost total', async () => {
    // Reputation now depends on centrality + peer trust, not LN+ rank/ratings
    await agentRepo.insert(makeAgent('top-rated', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 5_000_000_000, // 50 BTC, 100 ch → 0.5 BTC/ch
      positive_ratings: 50,
      negative_ratings: 2,
      lnplus_rank: 10,
      hubness_rank: 10,
      betweenness_rank: 20,
      first_seen: NOW - 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('low-rated', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 500_000_000, // 5 BTC, 100 ch → 0.05 BTC/ch
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 3,
      first_seen: NOW - 365 * DAY,
    }));

    const top = await scoring.computeScore(sha256('top-rated'));
    const low = await scoring.computeScore(sha256('low-rated'));

    // Top has centrality + higher peer trust → higher reputation
    expect(top.components.reputation).toBeGreaterThan(low.components.reputation);
    // Top also has LN+ bonus → higher total
    expect(top.total).toBeGreaterThan(low.total);
  });

  it('agent with only negative ratings has lower reputation than agent with no ratings', async () => {
    await agentRepo.insert(makeAgent('neg-only', {
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 5,
      lnplus_rank: 0,
      first_seen: NOW - 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('no-ratings', {
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      first_seen: NOW - 365 * DAY,
    }));

    const neg = await scoring.computeScore(sha256('neg-only'));
    const none = await scoring.computeScore(sha256('no-ratings'));

    // Negative-only should be penalized at or below zero-data baseline.
    // Post-2026-04-16 change: both agents have no centrality (no PageRank, no
    // LN+ ranks) AND no peerTrust (no capacity). Their two nominal weights
    // (0.20 + 0.30) redistribute to the neutral-fallback signals, so Reputation
    // = 50 for both. The flag `negative_reputation` in src/utils/flags.ts still
    // captures the negative-ratings asymmetry, but it no longer moves the
    // numeric reputation sub-score (LN+ positive-ratings bonus was retired
    // in the same audit).
    expect(neg.components.reputation).toBeLessThanOrEqual(none.components.reputation);
    expect(neg.components.reputation).toBe(50);
  });

  // --- Seniority ---

  it('agent active 3 years > agent active 1 month in seniority', async () => {
    await agentRepo.insert(makeAgent('veteran', {
      source: 'lightning_graph',
      first_seen: NOW - 3 * 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('newcomer', {
      source: 'lightning_graph',
      first_seen: NOW - 30 * DAY,
    }));

    const vet = await scoring.computeScore(sha256('veteran'));
    const newb = await scoring.computeScore(sha256('newcomer'));

    expect(vet.components.seniority).toBeGreaterThan(newb.components.seniority);
  });

  // --- Regularity ---

  it('inactive agent (last tx 2 years ago) < active agent (last tx this month) in regularity', async () => {
    await agentRepo.insert(makeAgent('stale-ln', {
      source: 'lightning_graph',
      total_transactions: 50,
      last_seen: NOW - 2 * 365 * DAY,
      first_seen: NOW - 3 * 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('active-ln', {
      source: 'lightning_graph',
      total_transactions: 50,
      last_seen: NOW - DAY,
      first_seen: NOW - 365 * DAY,
    }));

    const stale = await scoring.computeScore(sha256('stale-ln'));
    const active = await scoring.computeScore(sha256('active-ln'));

    expect(active.components.regularity).toBeGreaterThan(stale.components.regularity);
  });

  // --- Total score bounds ---

  it('total score is between 0 and 110 (100 base + 10 popularity max)', async () => {
    await agentRepo.insert(makeAgent('bounded', {
      source: 'lightning_graph',
      total_transactions: 500,
      positive_ratings: 100,
      lnplus_rank: 10,
      first_seen: NOW - 3 * 365 * DAY,
      last_seen: NOW - DAY,
      capacity_sats: 50_000_000_000,
      hubness_rank: 1,
      betweenness_rank: 1,
      query_count: 10000,
    }));

    const result = await scoring.computeScore(sha256('bounded'));
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(110);
  });

  it('all 5 components are between 0 and 100', async () => {
    await agentRepo.insert(makeAgent('comp-bounds', {
      source: 'lightning_graph',
      total_transactions: 500,
      positive_ratings: 80,
      lnplus_rank: 9,
      first_seen: NOW - 2 * 365 * DAY,
      last_seen: NOW - DAY,
      capacity_sats: 10_000_000_000,
      hubness_rank: 5,
      betweenness_rank: 10,
    }));

    const result = await scoring.computeScore(sha256('comp-bounds'));
    // Skip the non-numeric `reputationBreakdown` audit-trail field which was
    // added to ScoreComponents alongside the numeric slots in 2026-04-16.
    const numericSlots: (keyof typeof result.components)[] = ['volume', 'reputation', 'seniority', 'regularity', 'diversity'];
    for (const name of numericSlots) {
      const value = result.components[name] as number;
      expect(value, `${String(name)} component`).toBeGreaterThanOrEqual(0);
      expect(value, `${String(name)} component`).toBeLessThanOrEqual(100);
    }
  });

  // --- Anti-gaming ---

  it('mutual attestations (A<->B) reduce reputation vs one-way', async () => {
    // Setup: agent A with attestation from B (credible, scored attester)
    const aHash = sha256('mutual-a');
    const bHash = sha256('mutual-b');
    const cHash = sha256('oneway-c');
    const dHash = sha256('oneway-d');

    // One-way scenario: D attests C
    await agentRepo.insert(makeAgent('oneway-c', { total_transactions: 50 }));
    await agentRepo.insert(makeAgent('oneway-d', { total_transactions: 50, avg_score: 70, first_seen: NOW - 180 * DAY }));
    const txCD = makeTx(dHash, cHash);
    await txRepo.insert(txCD);
    await attestationRepo.insert(makeAttestation(dHash, cHash, txCD.tx_id, { score: 90, timestamp: NOW - DAY }));

    // Mutual scenario: A attests B AND B attests A
    await agentRepo.insert(makeAgent('mutual-a', { total_transactions: 50 }));
    await agentRepo.insert(makeAgent('mutual-b', { total_transactions: 50, avg_score: 70, first_seen: NOW - 180 * DAY }));
    const txAB = makeTx(aHash, bHash);
    const txBA = makeTx(bHash, aHash);
    await txRepo.insert(txAB);
    await txRepo.insert(txBA);
    await attestationRepo.insert(makeAttestation(bHash, aHash, txAB.tx_id, { score: 90, timestamp: NOW - DAY }));
    await attestationRepo.insert(makeAttestation(aHash, bHash, txBA.tx_id, { score: 90, timestamp: NOW - DAY }));

    const mutual = await scoring.computeScore(aHash);
    const oneway = await scoring.computeScore(cHash);

    expect(mutual.components.reputation).toBeLessThan(oneway.components.reputation);
  });

  // --- Popularity ---

  it('popularity bonus at query_count 0 is exactly 0', async () => {
    await agentRepo.insert(makeAgent('no-queries', {
      source: 'lightning_graph',
      total_transactions: 100,
      query_count: 0,
    }));

    const result = await scoring.computeScore(sha256('no-queries'));
    // With 0 queries, the popularity bonus should not have been added
    // Compute base score — standard weights (no renormalization)
    const c = result.components;
    const base = Math.round(
      c.volume * 0.25 + c.reputation * 0.30 + c.seniority * 0.15 + c.regularity * 0.15 + c.diversity * 0.15
    );
    // Total should equal base (no popularity bonus, no verified tx bonus for LN agents without observer tx)
    expect(result.total).toBe(base);
  });

  // --- Edge cases ---

  it('brand new agent with zero data scores between 0 and 15', async () => {
    await agentRepo.insert(makeAgent('empty-agent', {
      first_seen: NOW - DAY,
      last_seen: NOW,
      total_transactions: 0,
    }));

    const result = await scoring.computeScore(sha256('empty-agent'));
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(15);
    expect(result.confidence).toBe('very_low');
  });

  it('maximal Lightning agent scores > 85', async () => {
    // Insert another agent with fewer channels to establish maxChannels reference
    await agentRepo.insert(makeAgent('ref-node', {
      source: 'lightning_graph',
      total_transactions: 50,
      first_seen: NOW - 365 * DAY,
    }));

    await agentRepo.insert(makeAgent('max-agent', {
      source: 'lightning_graph',
      total_transactions: 1500,
      positive_ratings: 100,
      negative_ratings: 2,
      lnplus_rank: 10,
      first_seen: NOW - 3 * 365 * DAY,
      last_seen: NOW - DAY,
      capacity_sats: 50_000_000_000,
      hubness_rank: 1,
      betweenness_rank: 1,
    }));

    const result = await scoring.computeScore(sha256('max-agent'));
    expect(result.total).toBeGreaterThan(85);
  });

  it('score components are deterministic for same input', async () => {
    await agentRepo.insert(makeAgent('deterministic', {
      source: 'lightning_graph',
      total_transactions: 200,
      positive_ratings: 30,
      lnplus_rank: 6,
      first_seen: NOW - 365 * DAY,
      last_seen: NOW - DAY,
      capacity_sats: 5_000_000_000,
    }));

    const hash = sha256('deterministic');
    const first = await scoring.computeScore(hash);

    // Clear snapshot cache so it recomputes
    await db.query('DELETE FROM score_snapshots');

    const second = await scoring.computeScore(hash);

    expect(first.components).toEqual(second.components);
    expect(first.total).toBe(second.total);
  });

  it('positive/negative ratio no longer affects total score (LN+ bonus deprecated 2026-04-16)', async () => {
    // LN+ positive ratings used to drive a ×1.0-1.05 post-composite multiplier
    // but the scoring audit flagged them as near-noise (r=0.25 with Reputation,
    // 14% coverage). With the multiplier removed, two agents identical in every
    // objective dimension should score the same regardless of their LN+ ratio.
    await agentRepo.insert(makeAgent('good-ratio', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 1_000_000_000, // 10 BTC, 100 ch
      positive_ratings: 50,
      negative_ratings: 2,
      lnplus_rank: 5,
      first_seen: NOW - 365 * DAY,
    }));
    await agentRepo.insert(makeAgent('bad-ratio', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 1_000_000_000,
      positive_ratings: 10,
      negative_ratings: 8,
      lnplus_rank: 5,
      first_seen: NOW - 365 * DAY,
    }));

    const good = await scoring.computeScore(sha256('good-ratio'));
    const bad = await scoring.computeScore(sha256('bad-ratio'));

    // Same reputation component (same centrality + peer trust)
    expect(good.components.reputation).toBe(bad.components.reputation);
    // Same total — LN+ ratio no longer a multiplier
    expect(good.total).toBe(bad.total);
  });
});
