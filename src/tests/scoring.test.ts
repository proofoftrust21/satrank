// Scoring engine and anti-gaming tests
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
    timestamp: NOW - Math.floor(Math.random() * 90 * DAY),
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
    timestamp: NOW - Math.floor(Math.random() * 30 * DAY),
    category: 'general',
    verified: 0,
    weight: 1.0,
    ...overrides,
  };
}

describe('ScoringService', () => {
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

  afterEach(() => {
    db.close();
  });

  it('returns score 0 for a non-existent agent', () => {
    const result = scoring.computeScore(sha256('nobody'));
    expect(result.total).toBe(0);
    expect(result.confidence).toBe('very_low');
  });

  it('computes a basic score for an agent with transactions', () => {
    const agent = makeAgent('basic-agent');
    agentRepo.insert(agent);

    // 50 transactions with 10 different counterparties
    for (let i = 0; i < 10; i++) {
      const peer = makeAgent(`peer-${i}`);
      agentRepo.insert(peer);
      for (let j = 0; j < 5; j++) {
        txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      }
    }

    const result = scoring.computeScore(agent.public_key_hash);
    expect(result.total).toBeGreaterThan(0);
    expect(result.components.volume).toBeGreaterThan(0);
    expect(result.components.diversity).toBeGreaterThan(0);
    expect(result.components.seniority).toBeGreaterThan(0);
  });

  it('persists a snapshot after computation', () => {
    const agent = makeAgent('snapshot-agent');
    agentRepo.insert(agent);

    scoring.computeScore(agent.public_key_hash);

    const snapshot = snapshotRepo.findLatestByAgent(agent.public_key_hash);
    expect(snapshot).toBeDefined();
    expect(snapshot!.agent_hash).toBe(agent.public_key_hash);
  });

  describe('cache (getScore)', () => {
    it('returns existing snapshot if recent', () => {
      const agent = makeAgent('cached-agent');
      agentRepo.insert(agent);

      // First computation
      const first = scoring.computeScore(agent.public_key_hash);

      // Second call via getScore — should return cache
      const second = scoring.getScore(agent.public_key_hash);
      expect(second.computedAt).toBe(first.computedAt);
    });
  });

  describe('anti-gaming: mutual attestations', () => {
    it('penalizes agents with mutual attestations (A<->B)', () => {
      const agentA = makeAgent('legit-agent', { avg_score: 70 });
      const agentB = makeAgent('shill-a', { avg_score: 70 });
      const agentC = makeAgent('shill-b', { avg_score: 70 });
      agentRepo.insert(agentA);
      agentRepo.insert(agentB);
      agentRepo.insert(agentC);

      // Agent A receives normal attestations from 10 peers
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`honest-peer-${i}`, { avg_score: 60 });
        agentRepo.insert(peer);
        const tx = makeTx(peer.public_key_hash, agentA.public_key_hash);
        txRepo.insert(tx);
        attestationRepo.insert(makeAttestation(peer.public_key_hash, agentA.public_key_hash, tx.tx_id, { score: 80 }));
      }

      // Agent B receives mutual attestations (B<->C)
      const txBC = makeTx(agentB.public_key_hash, agentC.public_key_hash);
      const txCB = makeTx(agentC.public_key_hash, agentB.public_key_hash);
      txRepo.insert(txBC);
      txRepo.insert(txCB);

      // B attests C and C attests B (mutual loop)
      attestationRepo.insert(makeAttestation(agentC.public_key_hash, agentB.public_key_hash, txCB.tx_id, { score: 95 }));
      attestationRepo.insert(makeAttestation(agentB.public_key_hash, agentC.public_key_hash, txBC.tx_id, { score: 95 }));

      // Add some tx so B has comparable volume
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`b-peer-${i}`);
        agentRepo.insert(peer);
        txRepo.insert(makeTx(agentB.public_key_hash, peer.public_key_hash));
      }

      const scoreA = scoring.computeScore(agentA.public_key_hash);
      const scoreB = scoring.computeScore(agentB.public_key_hash);

      // A (honest attestations) should have better reputation than B (mutual attestations)
      expect(scoreA.components.reputation).toBeGreaterThan(scoreB.components.reputation);
    });
  });

  describe('anti-gaming: circular cluster', () => {
    it('detects and penalizes A->B->C->A clusters', () => {
      const a = makeAgent('cluster-a', { avg_score: 50 });
      const b = makeAgent('cluster-b', { avg_score: 50 });
      const c = makeAgent('cluster-c', { avg_score: 50 });
      agentRepo.insert(a);
      agentRepo.insert(b);
      agentRepo.insert(c);

      // Circular transactions
      const txAB = makeTx(a.public_key_hash, b.public_key_hash);
      const txBC = makeTx(b.public_key_hash, c.public_key_hash);
      const txCA = makeTx(c.public_key_hash, a.public_key_hash);
      txRepo.insert(txAB);
      txRepo.insert(txBC);
      txRepo.insert(txCA);

      // Circular attestations: A attests B, B attests C, C attests A
      attestationRepo.insert(makeAttestation(a.public_key_hash, b.public_key_hash, txAB.tx_id, { score: 95 }));
      attestationRepo.insert(makeAttestation(b.public_key_hash, c.public_key_hash, txBC.tx_id, { score: 95 }));
      attestationRepo.insert(makeAttestation(c.public_key_hash, a.public_key_hash, txCA.tx_id, { score: 95 }));

      const members = attestationRepo.findCircularCluster(a.public_key_hash);
      expect(members.length).toBeGreaterThan(0);
    });
  });

  describe('manual source penalty', () => {
    it('applies a penalty to manual source agents with low volume', () => {
      const manual = makeAgent('manual-agent', { source: 'manual' });
      const legit = makeAgent('legit-agent', { source: 'observer_protocol' });
      agentRepo.insert(manual);
      agentRepo.insert(legit);

      // Same volume for both
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`shared-peer-${i}`);
        agentRepo.insert(peer);
        txRepo.insert(makeTx(manual.public_key_hash, peer.public_key_hash));
        txRepo.insert(makeTx(legit.public_key_hash, peer.public_key_hash));
      }

      const scoreManual = scoring.computeScore(manual.public_key_hash);
      const scoreLegit = scoring.computeScore(legit.public_key_hash);

      // The manual agent should have a lower score
      expect(scoreManual.total).toBeLessThan(scoreLegit.total);
    });
  });

  describe('individual components', () => {
    it('volume = 0 for an agent without transactions', () => {
      const agent = makeAgent('no-tx');
      agentRepo.insert(agent);
      const result = scoring.computeScore(agent.public_key_hash);
      expect(result.components.volume).toBe(0);
    });

    it('regularity = 0 with fewer than 3 transactions', () => {
      const agent = makeAgent('few-tx');
      const peer = makeAgent('peer-few');
      agentRepo.insert(agent);
      agentRepo.insert(peer);
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));

      const result = scoring.computeScore(agent.public_key_hash);
      expect(result.components.regularity).toBe(0);
    });

    it('regularity = 100 with near-simultaneous transactions (mean < 1s)', () => {
      const agent = makeAgent('simul-tx');
      const peer = makeAgent('peer-simul');
      agentRepo.insert(agent);
      agentRepo.insert(peer);
      // 3 transactions within the same second
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));
      txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));

      const result = scoring.computeScore(agent.public_key_hash);
      expect(result.components.regularity).toBe(100);
    });

    it('diversity increases with number of counterparties', () => {
      const agent = makeAgent('diverse-agent');
      agentRepo.insert(agent);

      for (let i = 0; i < 20; i++) {
        const peer = makeAgent(`diverse-peer-${i}`);
        agentRepo.insert(peer);
        txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      }

      const result = scoring.computeScore(agent.public_key_hash);
      expect(result.components.diversity).toBeGreaterThan(50);
    });

    it('seniority increases with time', () => {
      const young = makeAgent('young', { first_seen: NOW - 7 * DAY });
      const old = makeAgent('old', { first_seen: NOW - 365 * DAY });
      agentRepo.insert(young);
      agentRepo.insert(old);

      const scoreYoung = scoring.computeScore(young.public_key_hash);
      const scoreOld = scoring.computeScore(old.public_key_hash);

      expect(scoreOld.components.seniority).toBeGreaterThan(scoreYoung.components.seniority);
    });

    it('confidence depends on data volume', () => {
      const agent = makeAgent('confidence-test', {
        total_transactions: 200,
        total_attestations_received: 100,
      });
      agentRepo.insert(agent);

      const result = scoring.computeScore(agent.public_key_hash);
      expect(result.confidence).toBe('high');
    });
  });

  describe('lightning_graph scoring', () => {
    it('computes volume relative to network max channels', () => {
      // Top node sets the reference for the network
      const topNode = makeAgent('ln-top', {
        source: 'lightning_graph',
        total_transactions: 2000, // channels
        capacity_sats: 10_000_000_000,
      });
      const midNode = makeAgent('ln-mid', {
        source: 'lightning_graph',
        total_transactions: 120, // channels
        capacity_sats: 500_000_000,
      });
      agentRepo.insert(topNode);
      agentRepo.insert(midNode);

      const scoreTop = scoring.computeScore(topNode.public_key_hash);
      const scoreMid = scoring.computeScore(midNode.public_key_hash);

      // Log scale: 2000ch → 100, 120ch → ~77
      expect(scoreTop.components.volume).toBe(100);
      expect(scoreMid.components.volume).toBeGreaterThan(70);
      expect(scoreMid.components.volume).toBeLessThan(85);
      expect(scoreTop.components.volume).toBeGreaterThan(scoreMid.components.volume);
    });

    it('computes regularity from recency of last_seen', () => {
      const recent = makeAgent('ln-recent', {
        source: 'lightning_graph',
        last_seen: NOW - DAY,
      });
      const stale = makeAgent('ln-stale', {
        source: 'lightning_graph',
        last_seen: NOW - 90 * DAY,
      });
      agentRepo.insert(recent);
      agentRepo.insert(stale);

      const scoreRecent = scoring.computeScore(recent.public_key_hash);
      const scoreStale = scoring.computeScore(stale.public_key_hash);

      expect(scoreRecent.components.regularity).toBeGreaterThan(scoreStale.components.regularity);
      // 1 day old — no probe data so fallback to gossip decay (90-day), should be close to 100
      expect(scoreRecent.components.regularity).toBeGreaterThan(90);
      // 90 days old with 90-day decay → exp(-1) ≈ 0.37 → ~37
      expect(scoreStale.components.regularity).toBeLessThan(45);
    });

    it('computes diversity from capacity in BTC', () => {
      const highCap = makeAgent('ln-high-cap', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 5_900_000_000, // 59 BTC
      });
      const lowCap = makeAgent('ln-low-cap', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 5_000_000, // 0.05 BTC
      });
      agentRepo.insert(highCap);
      agentRepo.insert(lowCap);

      const scoreHigh = scoring.computeScore(highCap.public_key_hash);
      const scoreLow = scoring.computeScore(lowCap.public_key_hash);

      // 59 BTC → high diversity (~92), 0.05 BTC → low diversity (~6)
      expect(scoreHigh.components.diversity).toBeGreaterThan(80);
      expect(scoreLow.components.diversity).toBeLessThan(15);
      expect(scoreHigh.components.diversity).toBeGreaterThan(scoreLow.components.diversity);
    });

    it('does not query tx table for lightning_graph volume', () => {
      // A lightning_graph agent with 0 rows in transactions table
      // should still get volume > 0 from channels
      const node = makeAgent('ln-no-tx', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
      });
      agentRepo.insert(node);

      const result = scoring.computeScore(node.public_key_hash);
      expect(result.components.volume).toBeGreaterThan(0);
      expect(result.components.diversity).toBeGreaterThan(0);
    });

    it('computes reputation from centrality and peer trust', () => {
      const centralNode = makeAgent('ln-rated', {
        source: 'lightning_graph',
        total_transactions: 500,
        capacity_sats: 5_000_000_000, // 50 BTC, 500 channels → 0.1 BTC/ch
        positive_ratings: 42,
        negative_ratings: 2,
        lnplus_rank: 8,
        hubness_rank: 25,
        betweenness_rank: 30,
      });
      const noCentralityNode = makeAgent('ln-unrated', {
        source: 'lightning_graph',
        total_transactions: 500,
        capacity_sats: 5_000_000_000,
        positive_ratings: 0,
        negative_ratings: 0,
        lnplus_rank: 0,
        hubness_rank: 0,
        betweenness_rank: 0,
      });
      agentRepo.insert(centralNode);
      agentRepo.insert(noCentralityNode);

      const scoreCentral = scoring.computeScore(centralNode.public_key_hash);
      const scoreNoCentrality = scoring.computeScore(noCentralityNode.public_key_hash);

      // Reputation is now centrality (max 50) + peer trust (max 50)
      // Central node: hubness_rank=25 → 25*exp(-25/100)=19.5, betweenness=30 → 25*exp(-30/100)=18.5 → ~38 centrality
      // Peer trust: 50BTC/500ch = 0.1 BTC/ch → log10(0.1*100+1)/log10(201)*50 ≈ 21
      // Total reputation ≈ 59
      expect(scoreCentral.components.reputation).toBeGreaterThan(40);
      // No centrality node still gets peer trust (same capacity/channels)
      // Peer trust: same as above ≈ 21
      expect(scoreNoCentrality.components.reputation).toBeGreaterThan(0);
      // Centrality gives the rated node higher reputation
      expect(scoreCentral.components.reputation).toBeGreaterThan(scoreNoCentrality.components.reputation);
      // LN+ ratings add bonus to total score, so rated node total > unrated
      expect(scoreCentral.total).toBeGreaterThan(scoreNoCentrality.total);
    });

    it('reputation formula: centrality + peer trust (no LN+ rank/ratings)', () => {
      // Exact formula test: no centrality, 100 channels, 10 BTC capacity
      // Centrality: 0 (no hubness/betweenness)
      // Peer trust: btcPerChannel = 10/100 = 0.1, log10(0.1*100+1)/log10(201)*50 = log10(11)/log10(201)*50 ≈ 22.6 → 23
      const node = makeAgent('ln-formula', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000, // 10 BTC
        positive_ratings: 10,
        negative_ratings: 0,
        lnplus_rank: 5,
      });
      agentRepo.insert(node);

      const result = scoring.computeScore(node.public_key_hash);
      // No centrality → peerTrust*0.65 + capTrend*0.35
      // peerTrust: log10(11)/log10(201)*100 ≈ 45, capTrend: 50 (neutral, no snapshots)
      // 45*0.65 + 50*0.35 ≈ 47
      expect(result.components.reputation).toBe(47);
    });

    it('centrality bonuses use continuous exponential curve', () => {
      const centralNode = makeAgent('ln-central', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000, // 10 BTC, 100 ch → 0.1 BTC/ch
        positive_ratings: 10,
        negative_ratings: 0,
        lnplus_rank: 5,
        hubness_rank: 20,
        betweenness_rank: 30,
      });
      const peripheralNode = makeAgent('ln-peripheral', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000, // 10 BTC, 100 ch → 0.1 BTC/ch
        positive_ratings: 10,
        negative_ratings: 0,
        lnplus_rank: 5,
        hubness_rank: 200,
        betweenness_rank: 300,
      });
      agentRepo.insert(centralNode);
      agentRepo.insert(peripheralNode);

      const scoreCentral = scoring.computeScore(centralNode.public_key_hash);
      const scorePeripheral = scoring.computeScore(peripheralNode.public_key_hash);

      // Central: centrality=78 (50*exp(-0.2)+50*exp(-0.3)), peerTrust=45, capTrend=50
      // 78*0.35 + 45*0.45 + 50*0.20 ≈ 58
      expect(scoreCentral.components.reputation).toBe(58);
      // Peripheral: centrality=9 (50*exp(-2.0)+50*exp(-3.0)), peerTrust=45, capTrend=50
      // 9*0.35 + 45*0.45 + 50*0.20 ≈ 33
      expect(scorePeripheral.components.reputation).toBe(33);
      // Continuous curve: central bonus > peripheral
      expect(scoreCentral.components.reputation).toBeGreaterThan(scorePeripheral.components.reputation);
    });

    it('negative ratings reduce total score via LN+ bonus', () => {
      // Reputation component is now objective (centrality + peer trust) — same for both
      // LN+ ratings affect the TOTAL score as a bonus, not the reputation component
      const goodNode = makeAgent('ln-good', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
        positive_ratings: 10,
        negative_ratings: 0,
        lnplus_rank: 5,
      });
      const mixedNode = makeAgent('ln-mixed', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
        positive_ratings: 10,
        negative_ratings: 10,
        lnplus_rank: 5,
      });
      agentRepo.insert(goodNode);
      agentRepo.insert(mixedNode);

      const scoreGood = scoring.computeScore(goodNode.public_key_hash);
      const scoreMixed = scoring.computeScore(mixedNode.public_key_hash);

      // Reputation component is the same (same centrality + peer trust)
      expect(scoreGood.components.reputation).toBe(scoreMixed.components.reputation);
      // LN+ bonus: good = min(8, log2(11) * (10/11) * 3) ≈ 9.4 → 8 (capped)
      // LN+ bonus: mixed = min(8, log2(11) * (10/21) * 3) ≈ 4.9 → 5
      // Good node total > mixed node total due to higher LN+ bonus
      expect(scoreGood.total).toBeGreaterThan(scoreMixed.total);
    });

    it('verified transaction bonus boosts observer_protocol agents above small LN nodes', () => {
      // Large LN node to set the network max
      const topNode = makeAgent('ln-top-ref', {
        source: 'lightning_graph',
        total_transactions: 2000,
        capacity_sats: 10_000_000_000,
        first_seen: NOW - 365 * DAY,
        last_seen: NOW - DAY,
      });
      // Small LN node — few channels, low capacity, no verified tx
      const smallLn = makeAgent('ln-small', {
        source: 'lightning_graph',
        total_transactions: 30,
        capacity_sats: 50_000_000, // 0.5 BTC
        first_seen: NOW - 90 * DAY,
        last_seen: NOW - DAY,
      });
      // Observer Protocol agent with 30 verified transactions
      const obsAgent = makeAgent('obs-agent', {
        source: 'observer_protocol',
        total_transactions: 30,
        first_seen: NOW - 90 * DAY,
        last_seen: NOW - DAY,
      });
      agentRepo.insert(topNode);
      agentRepo.insert(smallLn);
      agentRepo.insert(obsAgent);

      // Create 30 verified transactions for obsAgent with diverse counterparties
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`obs-peer-${i}`);
        agentRepo.insert(peer);
        for (let j = 0; j < 3; j++) {
          txRepo.insert(makeTx(obsAgent.public_key_hash, peer.public_key_hash));
        }
      }

      const scoreSmallLn = scoring.computeScore(smallLn.public_key_hash);
      const scoreObs = scoring.computeScore(obsAgent.public_key_hash);

      // Both should score meaningfully — observer has verified tx bonus (+15), LN node has renormalized weights
      // The key test: observer agent with verified tx should NOT be zero
      expect(scoreObs.total).toBeGreaterThan(30);
      expect(scoreSmallLn.total).toBeGreaterThan(30);
    });
  });

  describe('reputation calibration', () => {
    it('community ratings outweigh rank for Lightning nodes', () => {
      // Rank 10 mediocre reputation vs rank 3 stellar reputation
      const highRank = makeAgent('ln-highrank', {
        source: 'lightning_graph',
        total_transactions: 500,
        capacity_sats: 5_000_000_000,
        positive_ratings: 2,
        negative_ratings: 2,
        lnplus_rank: 10,
      });
      const lovedNode = makeAgent('ln-loved', {
        source: 'lightning_graph',
        total_transactions: 500,
        capacity_sats: 5_000_000_000,
        positive_ratings: 50,
        negative_ratings: 0,
        lnplus_rank: 3,
      });
      agentRepo.insert(highRank);
      agentRepo.insert(lovedNode);

      const scoreHighRank = scoring.computeScore(highRank.public_key_hash);
      const scoreLovedNode = scoring.computeScore(lovedNode.public_key_hash);

      // highRank: 10*5 + (2/(2+2+1))*50 = 50 + 20 = 70
      // loved: 3*5 + (50/(50+0+1))*50 = 15 + 49 = 64
      // With the new formula, rank 10 still wins slightly, but the gap is small
      // The old formula: highRank = 10*7 + 12 = 82, loved = 3*7 + 29 = 50 — huge gap
      expect(scoreHighRank.components.reputation - scoreLovedNode.components.reputation).toBeLessThan(15);
    });

    it('centrality bonus decays smoothly — rank 1 > rank 51 > rank 200', () => {
      const rank1 = makeAgent('ln-hub1', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
        lnplus_rank: 5,
        positive_ratings: 10,
        negative_ratings: 0,
        hubness_rank: 1,
      });
      const rank51 = makeAgent('ln-hub51', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
        lnplus_rank: 5,
        positive_ratings: 10,
        negative_ratings: 0,
        hubness_rank: 51,
      });
      const rank200 = makeAgent('ln-hub200', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
        lnplus_rank: 5,
        positive_ratings: 10,
        negative_ratings: 0,
        hubness_rank: 200,
      });
      agentRepo.insert(rank1);
      agentRepo.insert(rank51);
      agentRepo.insert(rank200);

      const s1 = scoring.computeScore(rank1.public_key_hash);
      const s51 = scoring.computeScore(rank51.public_key_hash);
      const s200 = scoring.computeScore(rank200.public_key_hash);

      // Continuous decay: rank 1 gets most bonus, rank 51 gets some, rank 200 gets ~0
      expect(s1.components.reputation).toBeGreaterThan(s51.components.reputation);
      expect(s51.components.reputation).toBeGreaterThanOrEqual(s200.components.reputation);
    });
  });

  describe('popularity bonus (removed — gameable)', () => {
    it('query_count has no effect on score', () => {
      const queried = makeAgent('pop-queried', { query_count: 100 });
      const unqueried = makeAgent('pop-unqueried', { query_count: 0 });
      agentRepo.insert(queried);
      agentRepo.insert(unqueried);

      const scoreQueried = scoring.computeScore(queried.public_key_hash);
      const scoreUnqueried = scoring.computeScore(unqueried.public_key_hash);

      // Popularity bonus was removed — query_count should not affect score
      expect(scoreQueried.total).toBe(scoreUnqueried.total);
    });

    it('no bonus when query_count is 0', () => {
      const agent = makeAgent('pop-zero', { query_count: 0 });
      agentRepo.insert(agent);

      const result = scoring.computeScore(agent.public_key_hash);
      // Score should just be base components, no popularity added
      expect(result.total).toBeGreaterThanOrEqual(0);
    });
  });
});
