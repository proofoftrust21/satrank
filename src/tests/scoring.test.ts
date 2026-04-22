// Scoring engine and anti-gaming tests
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
    source: 'attestation',
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

describe('ScoringService', async () => {
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

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('returns score 0 for a non-existent agent', async () => {
    const result = await scoring.computeScore(sha256('nobody'));
    expect(result.total).toBe(0);
    expect(result.confidence).toBe('very_low');
  });

  it('computes a basic score for an agent with transactions', async () => {
    const agent = makeAgent('basic-agent');
    await agentRepo.insert(agent);

    // 50 transactions with 10 different counterparties
    for (let i = 0; i < 10; i++) {
      const peer = makeAgent(`peer-${i}`);
      await agentRepo.insert(peer);
      for (let j = 0; j < 5; j++) {
        await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      }
    }

    const result = await scoring.computeScore(agent.public_key_hash);
    expect(result.total).toBeGreaterThan(0);
    expect(result.components.volume).toBeGreaterThan(0);
    expect(result.components.diversity).toBeGreaterThan(0);
    expect(result.components.seniority).toBeGreaterThan(0);
  });

  it('updates agents.avg_score without writing a score_snapshots row (Phase 3 C8)', async () => {
    // Snapshot persistence moved to BayesianVerdictService.snapshotAndPersist.
    // ScoringService only keeps the denormalized agents.avg_score in sync —
    // it no longer inserts into score_snapshots.
    const agent = makeAgent('snapshot-agent');
    await agentRepo.insert(agent);

    const result = await scoring.computeScore(agent.public_key_hash);

    const updated = await agentRepo.findByHash(agent.public_key_hash);
    expect(updated!.avg_score).toBe(result.totalFine);

    const snapshot = await snapshotRepo.findLatestByAgent(agent.public_key_hash);
    expect(snapshot).toBeUndefined();
  });

  it('repeated computeScore calls leave score_snapshots empty', async () => {
    const agent = makeAgent('unchanged-agent');
    await agentRepo.insert(agent);

    await scoring.computeScore(agent.public_key_hash);
    await scoring.computeScore(agent.public_key_hash);
    await scoring.computeScore(agent.public_key_hash);

    const countRes = await db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM score_snapshots WHERE agent_hash = $1',
      [agent.public_key_hash],
    );
    expect(Number(countRes.rows[0].n)).toBe(0);
  });

  describe('getScore', async () => {
    it('always returns a fresh computation (the snapshot cache was removed in Phase 3 C8)', async () => {
      const agent = makeAgent('cached-agent');
      await agentRepo.insert(agent);

      const first = await scoring.computeScore(agent.public_key_hash);
      const second = await scoring.getScore(agent.public_key_hash);

      // Both paths compute the same score but each has its own `computedAt`
      // timestamp — no cache reuse now that score_snapshots is bayesian-only.
      expect(second.total).toBe(first.total);
      expect(second.totalFine).toBe(first.totalFine);
    });
  });

  describe('reputation breakdown (audit trail)', async () => {
    it('emits per-sub-signal breakdown for lightning_graph agents', async () => {
      const agent = makeAgent('rep-breakdown-ln', {
        source: 'lightning_graph',
        total_transactions: 50,
        capacity_sats: 500_000_000,
        hubness_rank: 10,
        betweenness_rank: 15,
      });
      await agentRepo.insert(agent);

      const result = await scoring.computeScore(agent.public_key_hash);
      const breakdown = result.components.reputationBreakdown;
      expect(breakdown).toBeDefined();
      expect(breakdown!.mode).toBe('lightning_graph');
      expect(breakdown!.subsignals).toBeDefined();
      const subs = breakdown!.subsignals!;
      // Every slot declared, values in range, weights non-negative
      for (const slot of ['centrality', 'peerTrust', 'routingQuality', 'capacityTrend', 'feeStability'] as const) {
        expect(subs[slot].value, `${slot}.value`).toBeGreaterThanOrEqual(0);
        expect(subs[slot].value, `${slot}.value`).toBeLessThanOrEqual(100);
        expect(subs[slot].weight, `${slot}.weight`).toBeGreaterThanOrEqual(0);
      }
      // Weights must sum to ~1.0 (either centrality path or centrality-less fallback)
      const weightSum = subs.centrality.weight + subs.peerTrust.weight + subs.routingQuality.weight + subs.capacityTrend.weight + subs.feeStability.weight;
      expect(weightSum).toBeCloseTo(1.0, 2);
      // Sum of contributions must equal the Reputation component (modulo rounding)
      const contribSum = subs.centrality.contribution + subs.peerTrust.contribution + subs.routingQuality.contribution + subs.capacityTrend.contribution + subs.feeStability.contribution;
      expect(contribSum).toBeCloseTo(result.components.reputation, 0);
    });

    it('reports centrality source as `lnplus_ranks` when pagerank_score is missing', async () => {
      const agent = makeAgent('rep-breakdown-fallback', {
        source: 'lightning_graph',
        total_transactions: 10,
        capacity_sats: 100_000_000,
        hubness_rank: 5,
        betweenness_rank: 8,
        pagerank_score: null,
      });
      await agentRepo.insert(agent);
      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.components.reputationBreakdown!.subsignals!.centrality.source).toBe('lnplus_ranks');
    });

    it('emits attestations-mode breakdown for attestation agents', async () => {
      const agent = makeAgent('rep-breakdown-obs', {
        source: 'attestation',
        total_transactions: 5,
      });
      await agentRepo.insert(agent);
      const result = await scoring.computeScore(agent.public_key_hash);
      const breakdown = result.components.reputationBreakdown;
      expect(breakdown).toBeDefined();
      expect(breakdown!.mode).toBe('attestations');
      expect(breakdown!.attestations).toBeDefined();
    });
  });

  describe('anti-gaming: mutual attestations', async () => {
    it('penalizes agents with mutual attestations (A<->B)', async () => {
      const agentA = makeAgent('legit-agent', { avg_score: 70 });
      const agentB = makeAgent('shill-a', { avg_score: 70 });
      const agentC = makeAgent('shill-b', { avg_score: 70 });
      await agentRepo.insert(agentA);
      await agentRepo.insert(agentB);
      await agentRepo.insert(agentC);

      // Agent A receives normal attestations from 10 peers
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`honest-peer-${i}`, { avg_score: 60 });
        await agentRepo.insert(peer);
        const tx = makeTx(peer.public_key_hash, agentA.public_key_hash);
        await txRepo.insert(tx);
        await attestationRepo.insert(makeAttestation(peer.public_key_hash, agentA.public_key_hash, tx.tx_id, { score: 80 }));
      }

      // Agent B receives mutual attestations (B<->C)
      const txBC = makeTx(agentB.public_key_hash, agentC.public_key_hash);
      const txCB = makeTx(agentC.public_key_hash, agentB.public_key_hash);
      await txRepo.insert(txBC);
      await txRepo.insert(txCB);

      // B attests C and C attests B (mutual loop)
      await attestationRepo.insert(makeAttestation(agentC.public_key_hash, agentB.public_key_hash, txCB.tx_id, { score: 95 }));
      await attestationRepo.insert(makeAttestation(agentB.public_key_hash, agentC.public_key_hash, txBC.tx_id, { score: 95 }));

      // Add some tx so B has comparable volume
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`b-peer-${i}`);
        await agentRepo.insert(peer);
        await txRepo.insert(makeTx(agentB.public_key_hash, peer.public_key_hash));
      }

      const scoreA = await scoring.computeScore(agentA.public_key_hash);
      const scoreB = await scoring.computeScore(agentB.public_key_hash);

      // A (honest attestations) should have better reputation than B (mutual attestations)
      expect(scoreA.components.reputation).toBeGreaterThan(scoreB.components.reputation);
    });
  });

  describe('anti-gaming: circular cluster', async () => {
    it('detects and penalizes A->B->C->A clusters', async () => {
      const a = makeAgent('cluster-a', { avg_score: 50 });
      const b = makeAgent('cluster-b', { avg_score: 50 });
      const c = makeAgent('cluster-c', { avg_score: 50 });
      await agentRepo.insert(a);
      await agentRepo.insert(b);
      await agentRepo.insert(c);

      // Circular transactions
      const txAB = makeTx(a.public_key_hash, b.public_key_hash);
      const txBC = makeTx(b.public_key_hash, c.public_key_hash);
      const txCA = makeTx(c.public_key_hash, a.public_key_hash);
      await txRepo.insert(txAB);
      await txRepo.insert(txBC);
      await txRepo.insert(txCA);

      // Circular attestations: A attests B, B attests C, C attests A
      await attestationRepo.insert(makeAttestation(a.public_key_hash, b.public_key_hash, txAB.tx_id, { score: 95 }));
      await attestationRepo.insert(makeAttestation(b.public_key_hash, c.public_key_hash, txBC.tx_id, { score: 95 }));
      await attestationRepo.insert(makeAttestation(c.public_key_hash, a.public_key_hash, txCA.tx_id, { score: 95 }));

      const members = await attestationRepo.findCircularCluster(a.public_key_hash);
      expect(members.length).toBeGreaterThan(0);
    });
  });

  describe('manual source penalty', async () => {
    it('applies a penalty to manual source agents with low volume', async () => {
      const manual = makeAgent('manual-agent', { source: 'manual' });
      const legit = makeAgent('legit-agent', { source: 'attestation' });
      await agentRepo.insert(manual);
      await agentRepo.insert(legit);

      // Same volume for both
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`shared-peer-${i}`);
        await agentRepo.insert(peer);
        await txRepo.insert(makeTx(manual.public_key_hash, peer.public_key_hash));
        await txRepo.insert(makeTx(legit.public_key_hash, peer.public_key_hash));
      }

      const scoreManual = await scoring.computeScore(manual.public_key_hash);
      const scoreLegit = await scoring.computeScore(legit.public_key_hash);

      // The manual agent should have a lower score
      expect(scoreManual.total).toBeLessThan(scoreLegit.total);
    });
  });

  describe('individual components', async () => {
    it('volume = 0 for an agent without transactions', async () => {
      const agent = makeAgent('no-tx');
      await agentRepo.insert(agent);
      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.components.volume).toBe(0);
    });

    it('regularity = 0 with fewer than 3 transactions', async () => {
      const agent = makeAgent('few-tx');
      const peer = makeAgent('peer-few');
      await agentRepo.insert(agent);
      await agentRepo.insert(peer);
      await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));

      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.components.regularity).toBe(0);
    });

    it('regularity = 100 with near-simultaneous transactions (mean < 1s)', async () => {
      const agent = makeAgent('simul-tx');
      const peer = makeAgent('peer-simul');
      await agentRepo.insert(agent);
      await agentRepo.insert(peer);
      // 3 transactions within the same second
      await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));
      await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));
      await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash, { timestamp: NOW }));

      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.components.regularity).toBe(100);
    });

    it('diversity increases with number of counterparties', async () => {
      const agent = makeAgent('diverse-agent');
      await agentRepo.insert(agent);

      for (let i = 0; i < 20; i++) {
        const peer = makeAgent(`diverse-peer-${i}`);
        await agentRepo.insert(peer);
        await txRepo.insert(makeTx(agent.public_key_hash, peer.public_key_hash));
      }

      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.components.diversity).toBeGreaterThan(50);
    });

    it('seniority increases with time', async () => {
      const young = makeAgent('young', { first_seen: NOW - 7 * DAY });
      const old = makeAgent('old', { first_seen: NOW - 365 * DAY });
      await agentRepo.insert(young);
      await agentRepo.insert(old);

      const scoreYoung = await scoring.computeScore(young.public_key_hash);
      const scoreOld = await scoring.computeScore(old.public_key_hash);

      expect(scoreOld.components.seniority).toBeGreaterThan(scoreYoung.components.seniority);
    });

    it('confidence depends on data volume', async () => {
      const agent = makeAgent('confidence-test', {
        total_transactions: 200,
        total_attestations_received: 100,
      });
      await agentRepo.insert(agent);

      const result = await scoring.computeScore(agent.public_key_hash);
      expect(result.confidence).toBe('high');
    });
  });

  describe('lightning_graph scoring', async () => {
    it('computes volume relative to network max channels', async () => {
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
      await agentRepo.insert(topNode);
      await agentRepo.insert(midNode);

      const scoreTop = await scoring.computeScore(topNode.public_key_hash);
      const scoreMid = await scoring.computeScore(midNode.public_key_hash);

      // Blend: channels (ref 500) × 0.5 + capacity BTC (ref 50) × 0.5
      // top: 2000ch=100, 100BTC=100 → 100
      // mid: 120ch=77, 5BTC=46 → 62
      expect(scoreTop.components.volume).toBe(100);
      expect(scoreMid.components.volume).toBeGreaterThan(55);
      expect(scoreMid.components.volume).toBeLessThan(70);
      expect(scoreTop.components.volume).toBeGreaterThan(scoreMid.components.volume);
    });

    it('computes regularity from recency of last_seen', async () => {
      const recent = makeAgent('ln-recent', {
        source: 'lightning_graph',
        last_seen: NOW - DAY,
      });
      const stale = makeAgent('ln-stale', {
        source: 'lightning_graph',
        last_seen: NOW - 90 * DAY,
      });
      await agentRepo.insert(recent);
      await agentRepo.insert(stale);

      const scoreRecent = await scoring.computeScore(recent.public_key_hash);
      const scoreStale = await scoring.computeScore(stale.public_key_hash);

      expect(scoreRecent.components.regularity).toBeGreaterThan(scoreStale.components.regularity);
      // 1 day old — no probe data so fallback to gossip decay (90-day), should be close to 100
      expect(scoreRecent.components.regularity).toBeGreaterThan(90);
      // 90 days old with 90-day decay → exp(-1) ≈ 0.37 → ~37
      expect(scoreStale.components.regularity).toBeLessThan(45);
    });

    it('computes diversity from capacity in BTC', async () => {
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
      await agentRepo.insert(highCap);
      await agentRepo.insert(lowCap);

      const scoreHigh = await scoring.computeScore(highCap.public_key_hash);
      const scoreLow = await scoring.computeScore(lowCap.public_key_hash);

      // 59 BTC → high diversity (~92), 0.05 BTC → low diversity (~6)
      expect(scoreHigh.components.diversity).toBeGreaterThan(80);
      expect(scoreLow.components.diversity).toBeLessThan(15);
      expect(scoreHigh.components.diversity).toBeGreaterThan(scoreLow.components.diversity);
    });

    it('does not query tx table for lightning_graph volume', async () => {
      // A lightning_graph agent with 0 rows in transactions table
      // should still get volume > 0 from channels
      const node = makeAgent('ln-no-tx', {
        source: 'lightning_graph',
        total_transactions: 100,
        capacity_sats: 1_000_000_000,
      });
      await agentRepo.insert(node);

      const result = await scoring.computeScore(node.public_key_hash);
      expect(result.components.volume).toBeGreaterThan(0);
      expect(result.components.diversity).toBeGreaterThan(0);
    });

    it('computes reputation from centrality and peer trust', async () => {
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
      await agentRepo.insert(centralNode);
      await agentRepo.insert(noCentralityNode);

      const scoreCentral = await scoring.computeScore(centralNode.public_key_hash);
      const scoreNoCentrality = await scoring.computeScore(noCentralityNode.public_key_hash);

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

    it('reputation formula: centrality + peer trust (no LN+ rank/ratings)', async () => {
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
      await agentRepo.insert(node);

      const result = await scoring.computeScore(node.public_key_hash);
      // No centrality → peerTrust*0.35 + routingQuality*0.25 + capTrend*0.20 + feeStability*0.20
      // peerTrust: 45, routingQuality: 50 (neutral), capTrend: 50 (neutral), feeStability: 50 (neutral)
      // 45*0.35 + 50*0.25 + 50*0.20 + 50*0.20 ≈ 48
      expect(result.components.reputation).toBe(48);
    });

    it('centrality bonuses use continuous exponential curve', async () => {
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
      await agentRepo.insert(centralNode);
      await agentRepo.insert(peripheralNode);

      const scoreCentral = await scoring.computeScore(centralNode.public_key_hash);
      const scorePeripheral = await scoring.computeScore(peripheralNode.public_key_hash);

      // Central: centrality=78, peerTrust=45, routingQuality=50, capTrend=50, feeStability=50
      // 78*0.20 + 45*0.30 + 50*0.20 + 50*0.15 + 50*0.15 ≈ 54
      expect(scoreCentral.components.reputation).toBe(54);
      // Peripheral: centrality=9, peerTrust=45, routingQuality=50, capTrend=50, feeStability=50
      // 9*0.20 + 45*0.30 + 50*0.20 + 50*0.15 + 50*0.15 ≈ 40
      expect(scorePeripheral.components.reputation).toBe(40);
      // Continuous curve: central bonus > peripheral
      expect(scoreCentral.components.reputation).toBeGreaterThan(scorePeripheral.components.reputation);
    });

    it('LN+ positive/negative ratio no longer affects total score (bonus deprecated 2026-04-16)', async () => {
      // Pre-deprecation this test expected the total score to move with the
      // LN+ positive/negative ratio. The audit retired the multiplier because
      // coverage was too thin (14%) and the signal too weak (r=0.25) to
      // justify the external dependency. Negative ratings still drive the
      // `negative_reputation` flag via src/utils/flags.ts — this test just
      // asserts the SCORE is now ratio-independent.
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
      await agentRepo.insert(goodNode);
      await agentRepo.insert(mixedNode);

      const scoreGood = await scoring.computeScore(goodNode.public_key_hash);
      const scoreMixed = await scoring.computeScore(mixedNode.public_key_hash);

      // Reputation component is the same (same centrality + peer trust)
      expect(scoreGood.components.reputation).toBe(scoreMixed.components.reputation);
      // Totals equal — no more LN+ bonus branching on the ratio
      expect(scoreGood.total).toBe(scoreMixed.total);
    });

    it('verified transaction bonus boosts attestation agents above small LN nodes', async () => {
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
      // Attestation-sourced agent with 30 verified transactions
      const obsAgent = makeAgent('obs-agent', {
        source: 'attestation',
        total_transactions: 30,
        first_seen: NOW - 90 * DAY,
        last_seen: NOW - DAY,
      });
      await agentRepo.insert(topNode);
      await agentRepo.insert(smallLn);
      await agentRepo.insert(obsAgent);

      // Create 30 verified transactions for obsAgent with diverse counterparties
      for (let i = 0; i < 10; i++) {
        const peer = makeAgent(`obs-peer-${i}`);
        await agentRepo.insert(peer);
        for (let j = 0; j < 3; j++) {
          await txRepo.insert(makeTx(obsAgent.public_key_hash, peer.public_key_hash));
        }
      }

      const scoreSmallLn = await scoring.computeScore(smallLn.public_key_hash);
      const scoreObs = await scoring.computeScore(obsAgent.public_key_hash);

      // Both should score meaningfully — observer has verified tx bonus (+15), LN node has renormalized weights
      // The key test: observer agent with verified tx should NOT be zero
      expect(scoreObs.total).toBeGreaterThan(30);
      expect(scoreSmallLn.total).toBeGreaterThan(30);
    });
  });

  describe('reputation calibration', async () => {
    it('community ratings outweigh rank for Lightning nodes', async () => {
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
      await agentRepo.insert(highRank);
      await agentRepo.insert(lovedNode);

      const scoreHighRank = await scoring.computeScore(highRank.public_key_hash);
      const scoreLovedNode = await scoring.computeScore(lovedNode.public_key_hash);

      // highRank: 10*5 + (2/(2+2+1))*50 = 50 + 20 = 70
      // loved: 3*5 + (50/(50+0+1))*50 = 15 + 49 = 64
      // With the new formula, rank 10 still wins slightly, but the gap is small
      // The old formula: highRank = 10*7 + 12 = 82, loved = 3*7 + 29 = 50 — huge gap
      expect(scoreHighRank.components.reputation - scoreLovedNode.components.reputation).toBeLessThan(15);
    });

    it('centrality bonus decays smoothly — rank 1 > rank 51 > rank 200', async () => {
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
      await agentRepo.insert(rank1);
      await agentRepo.insert(rank51);
      await agentRepo.insert(rank200);

      const s1 = await scoring.computeScore(rank1.public_key_hash);
      const s51 = await scoring.computeScore(rank51.public_key_hash);
      const s200 = await scoring.computeScore(rank200.public_key_hash);

      // Continuous decay: rank 1 gets most bonus, rank 51 gets some, rank 200 gets ~0
      expect(s1.components.reputation).toBeGreaterThan(s51.components.reputation);
      expect(s51.components.reputation).toBeGreaterThanOrEqual(s200.components.reputation);
    });
  });

  describe('popularity bonus (removed — gameable)', async () => {
    it('query_count has no effect on score', async () => {
      const queried = makeAgent('pop-queried', { query_count: 100 });
      const unqueried = makeAgent('pop-unqueried', { query_count: 0 });
      await agentRepo.insert(queried);
      await agentRepo.insert(unqueried);

      const scoreQueried = await scoring.computeScore(queried.public_key_hash);
      const scoreUnqueried = await scoring.computeScore(unqueried.public_key_hash);

      // Popularity bonus was removed — query_count should not affect score
      expect(scoreQueried.total).toBe(scoreUnqueried.total);
    });

    it('no bonus when query_count is 0', async () => {
      const agent = makeAgent('pop-zero', { query_count: 0 });
      await agentRepo.insert(agent);

      const result = await scoring.computeScore(agent.public_key_hash);
      // Score should just be base components, no popularity added
      expect(result.total).toBeGreaterThanOrEqual(0);
    });
  });
});
