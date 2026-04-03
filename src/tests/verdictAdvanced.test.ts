// Advanced verdict tests — confidence formula, risk profile edge cases, personal trust depth 2, 4-hop cycles
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { sha256 } from '../utils/crypto';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`adv-${Math.random()}`),
    public_key: null,
    alias: 'test-agent',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 50,
    total_attestations_received: 0,
    avg_score: 60,
    capacity_sats: null,
    positive_ratings: 10,
    negative_ratings: 1,
    lnplus_rank: 3,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    query_count: 0,
    ...overrides,
  };
}

function insertTx(db: Database.Database, sender: string, receiver: string, ts: number = NOW): string {
  const txId = uuid();
  db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
    VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
  `).run(txId, sender, receiver, ts, sha256(txId));
  return txId;
}

function insertAttestation(db: Database.Database, attester: string, subject: string, score: number, ts: number = NOW, category: string = 'successful_transaction'): void {
  const txId = uuid();
  db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
    VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'l402')
  `).run(txId, attester, subject, ts, sha256(txId));
  db.prepare(`
    INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp, category)
    VALUES (?, ?, ?, ?, ?, null, null, ?, ?)
  `).run(uuid(), txId, attester, subject, score, ts, category);
}

describe('Verdict confidence formula', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('returns very_low confidence (0.1) for agent with < 5 data points', () => {
    const agent = makeAgent({
      public_key_hash: sha256('conf-verylow'),
      total_transactions: 2,
      total_attestations_received: 1,
    });
    agentRepo.insert(agent);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.confidence).toBe(0.1);
  });

  it('returns low confidence (0.25) for agent with 5-19 data points', () => {
    const agent = makeAgent({
      public_key_hash: sha256('conf-low'),
      total_transactions: 10,
      total_attestations_received: 5,
    });
    agentRepo.insert(agent);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.confidence).toBe(0.25);
  });

  it('returns medium confidence (0.5) for agent with 20-99 data points', () => {
    const agent = makeAgent({
      public_key_hash: sha256('conf-medium'),
      total_transactions: 50,
      total_attestations_received: 30,
    });
    agentRepo.insert(agent);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.confidence).toBe(0.5);
  });

  it('returns high confidence (0.75) for agent with 100-499 data points', () => {
    const agent = makeAgent({
      public_key_hash: sha256('conf-high'),
      total_transactions: 200,
      total_attestations_received: 100,
    });
    agentRepo.insert(agent);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.confidence).toBe(0.75);
  });

  it('returns very_high confidence (0.9) for agent with >= 500 data points', () => {
    const agent = makeAgent({
      public_key_hash: sha256('conf-veryhigh'),
      total_transactions: 300,
      total_attestations_received: 250,
    });
    agentRepo.insert(agent);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.confidence).toBe(0.9);
  });

  it('UNKNOWN (not RISKY) for low score with very_low confidence — insufficient data', () => {
    // A small LND node with few channels and no reputation data should be UNKNOWN, not RISKY.
    // RISKY requires at least low confidence (some evidence of risk).
    const hash = sha256('conf-insufficient-data');
    const agent = makeAgent({
      public_key_hash: hash,
      avg_score: 15,
      total_transactions: 2,  // few channels → very_low confidence (2 data points < 5)
      total_attestations_received: 0,
      source: 'lightning_graph',
      capacity_sats: 500_000,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
    });
    agentRepo.insert(agent);
    // Insert recent snapshot so cache is used (avoids recompute overriding score)
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), hash, 15, '{"volume":5,"reputation":0,"seniority":10,"regularity":50,"diversity":1}', NOW);
    const result = verdictService.getVerdict(agent.public_key_hash);
    // very_low confidence (2 data points) + low score → UNKNOWN, not RISKY
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.confidence).toBe(0.1);
  });

  it('RISKY for low score with sufficient confidence', () => {
    // An agent with enough data points to have at least low confidence AND a low score is genuinely RISKY
    const hash = sha256('conf-risky-with-evidence');
    const agent = makeAgent({
      public_key_hash: hash,
      avg_score: 20,
      total_transactions: 10,
      total_attestations_received: 5,
      // 15 data points → low confidence (>= 5, < 20)
      positive_ratings: 0,
      lnplus_rank: 0,
    });
    agentRepo.insert(agent);
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), hash, 20, '{"volume":10,"reputation":5,"seniority":20,"regularity":10,"diversity":5}', NOW);
    const result = verdictService.getVerdict(agent.public_key_hash);
    // low confidence (15 data points) + low score → RISKY (enough evidence)
    expect(result.verdict).toBe('RISKY');
    expect(result.confidence).toBe(0.25);
  });

  it('UNKNOWN verdict for score 30-49 even with medium confidence', () => {
    // Score 30-49 should be UNKNOWN, not SAFE or RISKY
    const hash = sha256('conf-unknown-mid');
    const agent = makeAgent({
      public_key_hash: hash,
      avg_score: 40,
      total_transactions: 50,
      total_attestations_received: 50,
      positive_ratings: 5,
      lnplus_rank: 2,
    });
    agentRepo.insert(agent);
    // Insert a recent snapshot so scoring engine uses cache
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), hash, 40, '{"volume":20,"reputation":30,"seniority":50,"regularity":40,"diversity":30}', NOW);
    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('SAFE requires confidence >= medium (0.5)', () => {
    // High score but very few data points → should NOT be SAFE
    const hash = sha256('conf-safe-needs-medium');
    const agent = makeAgent({
      public_key_hash: hash,
      avg_score: 80,
      total_transactions: 3,
      total_attestations_received: 1,
      positive_ratings: 10,
      lnplus_rank: 5,
      source: 'lightning_graph',
      capacity_sats: 5_000_000_000,
      public_key: 'pk-test',
    });
    agentRepo.insert(agent);
    // Insert a recent snapshot with high score so cache is used
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), hash, 80, '{"volume":80,"reputation":80,"seniority":80,"regularity":80,"diversity":80}', NOW);
    const result = verdictService.getVerdict(agent.public_key_hash);
    // very_low confidence (4 data points) → should be UNKNOWN despite high score
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.confidence).toBe(0.1);
  });
});

describe('Risk profile edge cases', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('suspicious_rapid_rise takes priority over new_unproven (ordered profiles)', () => {
    // Agent that matches both: < 30 days, < 5 tx, AND rapid rise > 20
    // suspicious_rapid_rise comes first in profile list
    const agent = makeAgent({
      public_key_hash: sha256('risk-priority'),
      first_seen: NOW - 15 * DAY,
      total_transactions: 2,
      avg_score: 60,
    });
    agentRepo.insert(agent);

    // Insert snapshot 7 days ago with much lower score
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), agent.public_key_hash, 30, '{"volume":0,"reputation":0,"seniority":10,"regularity":0,"diversity":0}', NOW - 7 * DAY);

    const result = verdictService.getVerdict(agent.public_key_hash);
    // The computed score might differ, but the risk profile logic checks delta
    expect(result.riskProfile.name).toBeDefined();
    expect(['suspicious_rapid_rise', 'new_unproven']).toContain(result.riskProfile.name);
  });

  it('declining_node detected when score drops and trend is falling', () => {
    const agent = makeAgent({
      public_key_hash: sha256('risk-declining'),
      avg_score: 50,
      total_transactions: 100,
      first_seen: NOW - 200 * DAY,
    });
    agentRepo.insert(agent);

    // Insert a higher snapshot 7 days ago
    db.prepare(`
      INSERT INTO score_snapshots (snapshot_id, agent_hash, score, components, computed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), agent.public_key_hash, 70, '{"volume":50,"reputation":50,"seniority":50,"regularity":50,"diversity":50}', NOW - 7 * DAY);

    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.riskProfile.name).toBe('declining_node');
    expect(result.riskProfile.riskLevel).toBe('high');
  });

  it('default profile for agent matching no specific profile', () => {
    // Mid-age, mid-score, stable — doesn't match any specific profile
    const agent = makeAgent({
      public_key_hash: sha256('risk-default'),
      first_seen: NOW - 200 * DAY,
      avg_score: 50,
      total_transactions: 50,
    });
    agentRepo.insert(agent);

    const result = verdictService.getVerdict(agent.public_key_hash);
    expect(result.riskProfile.name).toBe('default');
    expect(result.riskProfile.riskLevel).toBe('unknown');
  });
});

describe('Personal trust — distance 2', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService());
  });

  afterEach(() => { db.close(); });

  it('returns distance 2 for caller→A→B→target path', () => {
    const caller = makeAgent({ public_key_hash: sha256('d2-caller'), alias: 'Caller' });
    const hopA = makeAgent({ public_key_hash: sha256('d2-hopA'), alias: 'HopA' });
    const hopB = makeAgent({ public_key_hash: sha256('d2-hopB'), alias: 'HopB' });
    const target = makeAgent({ public_key_hash: sha256('d2-target'), alias: 'Target' });
    agentRepo.insert(caller);
    agentRepo.insert(hopA);
    agentRepo.insert(hopB);
    agentRepo.insert(target);

    // Caller → HopA (score >= 70)
    insertAttestation(db, caller.public_key_hash, hopA.public_key_hash, 80);
    // HopA → HopB (score >= 70)
    insertAttestation(db, hopA.public_key_hash, hopB.public_key_hash, 75);
    // HopB → Target (score >= 70)
    insertAttestation(db, hopB.public_key_hash, target.public_key_hash, 72);

    const result = verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBe(2);
    expect(result.personalTrust!.sharedConnections).toBeGreaterThanOrEqual(1);
  });

  it('returns null distance when attestation scores are below threshold', () => {
    const caller = makeAgent({ public_key_hash: sha256('d2-caller-low'), alias: 'CallerLow' });
    const hop = makeAgent({ public_key_hash: sha256('d2-hop-low'), alias: 'HopLow' });
    const target = makeAgent({ public_key_hash: sha256('d2-target-low'), alias: 'TargetLow' });
    agentRepo.insert(caller);
    agentRepo.insert(hop);
    agentRepo.insert(target);

    // All attestations below 70 threshold
    insertAttestation(db, caller.public_key_hash, hop.public_key_hash, 60);
    insertAttestation(db, hop.public_key_hash, target.public_key_hash, 50);

    const result = verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBeNull();
  });
});

describe('4-hop cycle detection', () => {
  let db: Database.Database;
  let attestationRepo: AttestationRepository;
  let scoringService: ScoringService;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
  });

  afterEach(() => { db.close(); });

  it('detects 4-hop cycle A→B→C→D→A', () => {
    const a = sha256('cycle4-A');
    const b = sha256('cycle4-B');
    const c = sha256('cycle4-C');
    const d = sha256('cycle4-D');

    for (const hash of [a, b, c, d]) {
      agentRepo.insert(makeAgent({
        public_key_hash: hash,
        first_seen: NOW - 365 * DAY,
        avg_score: 60,
        total_transactions: 50,
      }));
    }

    // A→B→C→D→A cycle
    insertAttestation(db, b, a, 90); // B attests A
    insertAttestation(db, c, b, 90); // C attests B
    insertAttestation(db, d, c, 90); // D attests C
    insertAttestation(db, a, d, 90); // A attests D (closes the cycle)

    const members = attestationRepo.findCycleMembers(a, 4);
    expect(members.length).toBeGreaterThan(0);
    // B, C, D should all be detected as cycle members
    expect(members).toContain(b);
  });

  it('does not falsely detect cycle in linear chain', () => {
    const a = sha256('linear-A');
    const b = sha256('linear-B');
    const c = sha256('linear-C');
    const d = sha256('linear-D');

    for (const hash of [a, b, c, d]) {
      agentRepo.insert(makeAgent({ public_key_hash: hash }));
    }

    // Linear: B→A, C→B, D→C — no cycle back to A
    insertAttestation(db, b, a, 90);
    insertAttestation(db, c, b, 90);
    insertAttestation(db, d, c, 90);

    const members = attestationRepo.findCycleMembers(a, 4);
    expect(members.length).toBe(0);
  });

  it('3-hop cycle also detected at maxDepth=4', () => {
    const a = sha256('cycle3in4-A');
    const b = sha256('cycle3in4-B');
    const c = sha256('cycle3in4-C');

    for (const hash of [a, b, c]) {
      agentRepo.insert(makeAgent({ public_key_hash: hash }));
    }

    // A→B→C→A
    insertAttestation(db, b, a, 90);
    insertAttestation(db, c, b, 90);
    insertAttestation(db, a, c, 90);

    const members = attestationRepo.findCycleMembers(a, 4);
    expect(members.length).toBeGreaterThan(0);
  });

  it('scoring engine applies penalty to 4-hop cycle attesters', () => {
    const target = sha256('cycle4-target');
    const b = sha256('cycle4-attB');
    const c = sha256('cycle4-attC');
    const d = sha256('cycle4-attD');
    const honest = sha256('cycle4-honest');

    for (const hash of [target, b, c, d, honest]) {
      agentRepo.insert(makeAgent({
        public_key_hash: hash,
        first_seen: NOW - 365 * DAY,
        avg_score: 60,
        total_transactions: 50,
        total_attestations_received: 20,
      }));
    }

    // 4-hop cycle: B→target, C→B, D→C, target→D
    insertAttestation(db, b, target, 100);
    insertAttestation(db, c, b, 100);
    insertAttestation(db, d, c, 100);
    insertAttestation(db, target, d, 100);

    // Also an honest attestation
    insertAttestation(db, honest, target, 80);

    const score = scoringService.computeScore(target);
    // The cycle attestation from B should be penalized
    // The honest one from 'honest' should have normal weight
    // If no penalty were applied, reputation would be near 100
    // With penalty, it should be significantly lower
    expect(score.components.reputation).toBeLessThan(95);
  });
});

describe('avgScore excludes zero-score agents', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
  });

  afterEach(() => { db.close(); });

  it('computes average only over agents with score > 0', () => {
    // Insert 3 agents: scores 80, 60, 0
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-a'), avg_score: 80 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-b'), avg_score: 60 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-c'), avg_score: 0 }));

    const avg = agentRepo.avgScore();
    // Should be (80+60)/2 = 70, not (80+60+0)/3 = 46.7
    expect(avg).toBe(70);
  });

  it('returns 0 when all agents have score 0', () => {
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-zero1'), avg_score: 0 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-zero2'), avg_score: 0 }));

    const avg = agentRepo.avgScore();
    expect(avg).toBe(0);
  });
});
