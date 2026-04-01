// Scoring engine and anti-gaming tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import type { Agent, Transaction, Attestation } from '../types';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    alias,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
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
});
