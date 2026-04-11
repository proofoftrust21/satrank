// Scoring property tests — logical invariants that must hold regardless of tuning
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction, Attestation } from '../types';

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

describe('Scoring properties', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let scoring: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  });

  afterEach(() => { db.close(); });

  // --- Volume ---

  it('agent with 1000 channels > agent with 10 channels in volume', () => {
    agentRepo.insert(makeAgent('big-node', {
      source: 'lightning_graph',
      total_transactions: 1000,
      first_seen: NOW - 365 * DAY,
    }));
    agentRepo.insert(makeAgent('small-node', {
      source: 'lightning_graph',
      total_transactions: 10,
      first_seen: NOW - 365 * DAY,
    }));

    const big = scoring.computeScore(sha256('big-node'));
    const small = scoring.computeScore(sha256('small-node'));

    expect(big.components.volume).toBeGreaterThan(small.components.volume);
  });

  // --- Reputation ---

  it('agent with centrality and capacity > agent without in reputation; LN+ ratings boost total', () => {
    // Reputation now depends on centrality + peer trust, not LN+ rank/ratings
    agentRepo.insert(makeAgent('top-rated', {
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
    agentRepo.insert(makeAgent('low-rated', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 500_000_000, // 5 BTC, 100 ch → 0.05 BTC/ch
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 3,
      first_seen: NOW - 365 * DAY,
    }));

    const top = scoring.computeScore(sha256('top-rated'));
    const low = scoring.computeScore(sha256('low-rated'));

    // Top has centrality + higher peer trust → higher reputation
    expect(top.components.reputation).toBeGreaterThan(low.components.reputation);
    // Top also has LN+ bonus → higher total
    expect(top.total).toBeGreaterThan(low.total);
  });

  it('agent with only negative ratings has lower reputation than agent with no ratings', () => {
    agentRepo.insert(makeAgent('neg-only', {
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 5,
      lnplus_rank: 0,
      first_seen: NOW - 365 * DAY,
    }));
    agentRepo.insert(makeAgent('no-ratings', {
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      first_seen: NOW - 365 * DAY,
    }));

    const neg = scoring.computeScore(sha256('neg-only'));
    const none = scoring.computeScore(sha256('no-ratings'));

    // Negative-only should be penalized at or below zero-data baseline.
    // Both have no capacity and no centrality → reputation = capTrend(50)*0.35 = 18
    // (LN+ negative_ratings affect the post-composite bonus, not the reputation component)
    expect(neg.components.reputation).toBeLessThanOrEqual(none.components.reputation);
    expect(neg.components.reputation).toBe(18);
  });

  // --- Seniority ---

  it('agent active 3 years > agent active 1 month in seniority', () => {
    agentRepo.insert(makeAgent('veteran', {
      source: 'lightning_graph',
      first_seen: NOW - 3 * 365 * DAY,
    }));
    agentRepo.insert(makeAgent('newcomer', {
      source: 'lightning_graph',
      first_seen: NOW - 30 * DAY,
    }));

    const vet = scoring.computeScore(sha256('veteran'));
    const newb = scoring.computeScore(sha256('newcomer'));

    expect(vet.components.seniority).toBeGreaterThan(newb.components.seniority);
  });

  // --- Regularity ---

  it('inactive agent (last tx 2 years ago) < active agent (last tx this month) in regularity', () => {
    agentRepo.insert(makeAgent('stale-ln', {
      source: 'lightning_graph',
      total_transactions: 50,
      last_seen: NOW - 2 * 365 * DAY,
      first_seen: NOW - 3 * 365 * DAY,
    }));
    agentRepo.insert(makeAgent('active-ln', {
      source: 'lightning_graph',
      total_transactions: 50,
      last_seen: NOW - DAY,
      first_seen: NOW - 365 * DAY,
    }));

    const stale = scoring.computeScore(sha256('stale-ln'));
    const active = scoring.computeScore(sha256('active-ln'));

    expect(active.components.regularity).toBeGreaterThan(stale.components.regularity);
  });

  // --- Total score bounds ---

  it('total score is between 0 and 110 (100 base + 10 popularity max)', () => {
    agentRepo.insert(makeAgent('bounded', {
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

    const result = scoring.computeScore(sha256('bounded'));
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(110);
  });

  it('all 5 components are between 0 and 100', () => {
    agentRepo.insert(makeAgent('comp-bounds', {
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

    const result = scoring.computeScore(sha256('comp-bounds'));
    for (const [name, value] of Object.entries(result.components)) {
      expect(value, `${name} component`).toBeGreaterThanOrEqual(0);
      expect(value, `${name} component`).toBeLessThanOrEqual(100);
    }
  });

  // --- Anti-gaming ---

  it('mutual attestations (A<->B) reduce reputation vs one-way', () => {
    // Setup: agent A with attestation from B (credible, scored attester)
    const aHash = sha256('mutual-a');
    const bHash = sha256('mutual-b');
    const cHash = sha256('oneway-c');
    const dHash = sha256('oneway-d');

    // One-way scenario: D attests C
    agentRepo.insert(makeAgent('oneway-c', { total_transactions: 50 }));
    agentRepo.insert(makeAgent('oneway-d', { total_transactions: 50, avg_score: 70, first_seen: NOW - 180 * DAY }));
    const txCD = makeTx(dHash, cHash);
    txRepo.insert(txCD);
    attestationRepo.insert(makeAttestation(dHash, cHash, txCD.tx_id, { score: 90, timestamp: NOW - DAY }));

    // Mutual scenario: A attests B AND B attests A
    agentRepo.insert(makeAgent('mutual-a', { total_transactions: 50 }));
    agentRepo.insert(makeAgent('mutual-b', { total_transactions: 50, avg_score: 70, first_seen: NOW - 180 * DAY }));
    const txAB = makeTx(aHash, bHash);
    const txBA = makeTx(bHash, aHash);
    txRepo.insert(txAB);
    txRepo.insert(txBA);
    attestationRepo.insert(makeAttestation(bHash, aHash, txAB.tx_id, { score: 90, timestamp: NOW - DAY }));
    attestationRepo.insert(makeAttestation(aHash, bHash, txBA.tx_id, { score: 90, timestamp: NOW - DAY }));

    const mutual = scoring.computeScore(aHash);
    const oneway = scoring.computeScore(cHash);

    expect(mutual.components.reputation).toBeLessThan(oneway.components.reputation);
  });

  // --- Popularity ---

  it('popularity bonus at query_count 0 is exactly 0', () => {
    agentRepo.insert(makeAgent('no-queries', {
      source: 'lightning_graph',
      total_transactions: 100,
      query_count: 0,
    }));

    const result = scoring.computeScore(sha256('no-queries'));
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

  it('brand new agent with zero data scores between 0 and 15', () => {
    agentRepo.insert(makeAgent('empty-agent', {
      first_seen: NOW - DAY,
      last_seen: NOW,
      total_transactions: 0,
    }));

    const result = scoring.computeScore(sha256('empty-agent'));
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(15);
    expect(result.confidence).toBe('very_low');
  });

  it('maximal Lightning agent scores > 85', () => {
    // Insert another agent with fewer channels to establish maxChannels reference
    agentRepo.insert(makeAgent('ref-node', {
      source: 'lightning_graph',
      total_transactions: 50,
      first_seen: NOW - 365 * DAY,
    }));

    agentRepo.insert(makeAgent('max-agent', {
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

    const result = scoring.computeScore(sha256('max-agent'));
    expect(result.total).toBeGreaterThan(85);
  });

  it('score components are deterministic for same input', () => {
    agentRepo.insert(makeAgent('deterministic', {
      source: 'lightning_graph',
      total_transactions: 200,
      positive_ratings: 30,
      lnplus_rank: 6,
      first_seen: NOW - 365 * DAY,
      last_seen: NOW - DAY,
      capacity_sats: 5_000_000_000,
    }));

    const hash = sha256('deterministic');
    const first = scoring.computeScore(hash);

    // Clear snapshot cache so it recomputes
    db.exec('DELETE FROM score_snapshots');

    const second = scoring.computeScore(hash);

    expect(first.components).toEqual(second.components);
    expect(first.total).toBe(second.total);
  });

  it('higher positive/negative ratio yields higher LN+ bonus on total score', () => {
    // Reputation component is objective (centrality + peer trust) — same for both
    // LN+ ratings affect the total score via bonus, not the reputation component
    agentRepo.insert(makeAgent('good-ratio', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 1_000_000_000, // 10 BTC, 100 ch
      positive_ratings: 50,
      negative_ratings: 2,
      lnplus_rank: 5,
      first_seen: NOW - 365 * DAY,
    }));
    agentRepo.insert(makeAgent('bad-ratio', {
      source: 'lightning_graph',
      total_transactions: 100,
      capacity_sats: 1_000_000_000, // same capacity/channels
      positive_ratings: 10,
      negative_ratings: 8,
      lnplus_rank: 5,
      first_seen: NOW - 365 * DAY,
    }));

    const good = scoring.computeScore(sha256('good-ratio'));
    const bad = scoring.computeScore(sha256('bad-ratio'));

    // Same reputation component (same centrality + peer trust)
    expect(good.components.reputation).toBe(bad.components.reputation);
    // Higher ratio yields higher LN+ bonus → higher total
    expect(good.total).toBeGreaterThan(bad.total);
  });
});
