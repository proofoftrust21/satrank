// Score evidence transparency tests — "Don't trust, verify."
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { TrendService } from '../services/trendService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`agent-${Math.random()}`),
    public_key: null,
    alias: 'test-agent',
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

describe('Score evidence', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let agentService: AgentService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);

    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('returns transaction evidence with sample of 5 most recent', () => {
    const agent = makeAgent({ public_key_hash: sha256('evidence-tx'), total_transactions: 8 });
    const peer = makeAgent({ public_key_hash: sha256('peer') });
    agentRepo.insert(agent);
    agentRepo.insert(peer);

    // Insert 8 transactions with known timestamps
    for (let i = 0; i < 8; i++) {
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, {
        timestamp: NOW - i * DAY,
        protocol: i % 2 === 0 ? 'l402' : 'bolt11',
      }));
    }

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.transactions.count).toBe(8);
    expect(result.evidence.transactions.verifiedCount).toBe(8);
    expect(result.evidence.transactions.sample).toHaveLength(5);
    // Most recent first
    expect(result.evidence.transactions.sample[0].timestamp).toBeGreaterThanOrEqual(
      result.evidence.transactions.sample[4].timestamp
    );
    // Each sample has required fields
    for (const tx of result.evidence.transactions.sample) {
      expect(tx.txId).toBeDefined();
      expect(tx.protocol).toBeDefined();
      expect(tx.amountBucket).toBeDefined();
      expect(typeof tx.verified).toBe('boolean');
      expect(tx.verified).toBe(true);
      expect(typeof tx.timestamp).toBe('number');
    }
  });

  it('returns empty transaction sample when no transactions exist', () => {
    const agent = makeAgent({ public_key_hash: sha256('no-tx-agent') });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.transactions.count).toBe(0);
    expect(result.evidence.transactions.verifiedCount).toBe(0);
    expect(result.evidence.transactions.sample).toHaveLength(0);
  });

  it('returns lightning_graph evidence for Lightning nodes', () => {
    const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      source: 'lightning_graph',
      total_transactions: 1988,
      capacity_sats: 37_065_909_294,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.lightningGraph).not.toBeNull();
    expect(result.evidence.lightningGraph!.publicKey).toBe(pubkey);
    expect(result.evidence.lightningGraph!.channels).toBe(1988);
    expect(result.evidence.lightningGraph!.capacitySats).toBe(37_065_909_294);
    expect(result.evidence.lightningGraph!.sourceUrl).toBe(
      `https://mempool.space/lightning/node/${pubkey}`
    );
  });

  it('returns null lightning_graph for observer_protocol agents', () => {
    const agent = makeAgent({
      public_key_hash: sha256('obs-no-ln'),
      source: 'observer_protocol',
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.lightningGraph).toBeNull();
  });

  it('returns LN+ reputation evidence when ratings exist', () => {
    const pubkey = 'pk-rated-node';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      source: 'lightning_graph',
      total_transactions: 500,
      capacity_sats: 5_000_000_000,
      positive_ratings: 47,
      negative_ratings: 2,
      lnplus_rank: 9,
      hubness_rank: 15,
      betweenness_rank: 22,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.reputation).not.toBeNull();
    expect(result.evidence.reputation!.positiveRatings).toBe(47);
    expect(result.evidence.reputation!.negativeRatings).toBe(2);
    expect(result.evidence.reputation!.lnplusRank).toBe(9);
    expect(result.evidence.reputation!.hubnessRank).toBe(15);
    expect(result.evidence.reputation!.betweennessRank).toBe(22);
    expect(result.evidence.reputation!.sourceUrl).toBe(
      `https://lightningnetwork.plus/nodes/${pubkey}`
    );
  });

  it('returns null reputation when no LN+ ratings', () => {
    const pubkey = 'pk-unrated';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.reputation).toBeNull();
  });

  it('returns reputation evidence when only centrality ranks exist', () => {
    const pubkey = 'pk-centrality-only';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      source: 'lightning_graph',
      total_transactions: 100,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 25,
      betweenness_rank: 0,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.reputation).not.toBeNull();
    expect(result.evidence.reputation!.hubnessRank).toBe(25);
    expect(result.evidence.reputation!.betweennessRank).toBe(0);
  });

  it('returns popularity evidence with bonus calculation', () => {
    const agent = makeAgent({
      public_key_hash: sha256('pop-evidence'),
      query_count: 100,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.popularity.queryCount).toBe(100);
    // log2(101) * 2 ≈ 13.3 → capped at 10
    expect(result.evidence.popularity.bonusApplied).toBe(10);
  });

  it('returns 0 popularity bonus when query_count is 0', () => {
    const agent = makeAgent({
      public_key_hash: sha256('no-pop'),
      query_count: 0,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.popularity.queryCount).toBe(0);
    expect(result.evidence.popularity.bonusApplied).toBe(0);
  });

  it('includes verified=false for pending transactions in sample', () => {
    const agent = makeAgent({ public_key_hash: sha256('mixed-status') });
    const peer = makeAgent({ public_key_hash: sha256('mixed-peer') });
    agentRepo.insert(agent);
    agentRepo.insert(peer);

    txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, {
      status: 'verified',
      timestamp: NOW,
    }));
    txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, {
      status: 'pending',
      timestamp: NOW - DAY,
    }));

    const result = agentService.getAgentScore(agent.public_key_hash);

    expect(result.evidence.transactions.sample).toHaveLength(2);
    const verified = result.evidence.transactions.sample.find(t => t.verified);
    const pending = result.evidence.transactions.sample.find(t => !t.verified);
    expect(verified).toBeDefined();
    expect(pending).toBeDefined();
  });

  it('provides complete evidence for a fully-enriched Lightning node', () => {
    const pubkey = 'pk-full-evidence';
    const agent = makeAgent({
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      alias: 'FullNode',
      source: 'lightning_graph',
      total_transactions: 1500,
      capacity_sats: 20_000_000_000,
      positive_ratings: 30,
      negative_ratings: 1,
      lnplus_rank: 7,
      hubness_rank: 10,
      betweenness_rank: 20,
      query_count: 50,
    });
    agentRepo.insert(agent);

    const result = agentService.getAgentScore(agent.public_key_hash);

    // All sections populated
    expect(result.evidence.transactions).toBeDefined();
    expect(result.evidence.lightningGraph).not.toBeNull();
    expect(result.evidence.reputation).not.toBeNull();
    expect(result.evidence.popularity.queryCount).toBe(50);
    expect(result.evidence.popularity.bonusApplied).toBeGreaterThan(0);

    // Source URLs are verifiable
    expect(result.evidence.lightningGraph!.sourceUrl).toContain('mempool.space');
    expect(result.evidence.reputation!.sourceUrl).toContain('lightningnetwork.plus');
  });
});
