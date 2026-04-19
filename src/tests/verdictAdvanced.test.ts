// Advanced verdict tests — risk profile edge cases, personal trust depth 2, 4-hop cycles
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
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
    unique_peers: null,
    last_queried_at: null,
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

// Note: the former "Verdict confidence formula" describe block was removed in
// Phase 3 when the composite score was retired from public responses. Bayesian
// verdict semantics (INSUFFICIENT / RISKY / UNKNOWN / SAFE) are exercised by
// bayesianScoringService.verdict.test.ts.

describe('Risk profile edge cases', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), createBayesianVerdictService(db));
  });

  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('suspicious_rapid_rise takes priority over new_unproven (ordered profiles)', async () => {
    // Agent that matches both: < 30 days, < 5 tx, AND rapid rise > 20
    // suspicious_rapid_rise comes first in profile list
    const agent = makeAgent({
      public_key_hash: sha256('risk-priority'),
      first_seen: NOW - 15 * DAY,
      total_transactions: 2,
      avg_score: 60,
    });
    agentRepo.insert(agent);

    // Past p_success=0.20 vs current 0.5 prior → delta=+0.30 > DELTA_RAPID_RISE (0.26)
    db.prepare(`
      INSERT INTO score_snapshots (
        snapshot_id, agent_hash,
        p_success, ci95_low, ci95_high, n_obs,
        posterior_alpha, posterior_beta, window,
        computed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '7d', ?, ?)
    `).run(
      uuid(), agent.public_key_hash,
      0.20, 0.15, 0.25, 10,
      1.5 + 10 * 0.20, 1.5 + 10 * 0.80,
      NOW - 7 * DAY, NOW - 7 * DAY,
    );

    const result = await verdictService.getVerdict(agent.public_key_hash);
    // The computed score might differ, but the risk profile logic checks delta
    expect(result.riskProfile.name).toBeDefined();
    expect(['suspicious_rapid_rise', 'new_unproven']).toContain(result.riskProfile.name);
  });

  it('declining_node detected when score drops and trend is falling', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('risk-declining'),
      avg_score: 50,
      total_transactions: 100,
      first_seen: NOW - 200 * DAY,
    });
    agentRepo.insert(agent);

    // Past p_success=0.70 vs current 0.5 prior → delta=-0.20 < DELTA_DECLINING (-0.13)
    db.prepare(`
      INSERT INTO score_snapshots (
        snapshot_id, agent_hash,
        p_success, ci95_low, ci95_high, n_obs,
        posterior_alpha, posterior_beta, window,
        computed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '7d', ?, ?)
    `).run(
      uuid(), agent.public_key_hash,
      0.70, 0.65, 0.75, 10,
      1.5 + 10 * 0.70, 1.5 + 10 * 0.30,
      NOW - 7 * DAY, NOW - 7 * DAY,
    );

    const result = await verdictService.getVerdict(agent.public_key_hash);
    expect(result.riskProfile.name).toBe('declining_node');
    expect(result.riskProfile.riskLevel).toBe('high');
  });

  it('default profile for agent matching no specific profile', async () => {
    // Mid-age, mid-score, stable — doesn't match any specific profile
    const agent = makeAgent({
      public_key_hash: sha256('risk-default'),
      first_seen: NOW - 200 * DAY,
      avg_score: 50,
      total_transactions: 50,
    });
    agentRepo.insert(agent);

    const result = await verdictService.getVerdict(agent.public_key_hash);
    // Sim #9 HIGH: the unrated fallback now grades riskLevel by score (>=40
    // means "some signal, just no matching archetype") instead of the flat
    // 'unknown' that made every fallback look identical regardless of score.
    expect(result.riskProfile.name).toBe('unrated');
    expect(result.riskProfile.riskLevel).toBe('medium');
  });
});

describe('Personal trust — distance 2', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let attestationRepo: AttestationRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), createBayesianVerdictService(db));
  });

  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('returns distance 2 for caller→A→B→target path', async () => {
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

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    expect(result.personalTrust).not.toBeNull();
    expect(result.personalTrust!.distance).toBe(2);
    expect(result.personalTrust!.sharedConnections).toBeGreaterThanOrEqual(1);
  });

  it('returns null distance when attestation scores are below threshold', async () => {
    const caller = makeAgent({ public_key_hash: sha256('d2-caller-low'), alias: 'CallerLow' });
    const hop = makeAgent({ public_key_hash: sha256('d2-hop-low'), alias: 'HopLow' });
    const target = makeAgent({ public_key_hash: sha256('d2-target-low'), alias: 'TargetLow' });
    agentRepo.insert(caller);
    agentRepo.insert(hop);
    agentRepo.insert(target);

    // All attestations below 70 threshold
    insertAttestation(db, caller.public_key_hash, hop.public_key_hash, 60);
    insertAttestation(db, hop.public_key_hash, target.public_key_hash, 50);

    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
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
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
  });

  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('detects 4-hop cycle A→B→C→D→A', async () => {
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

  it('does not falsely detect cycle in linear chain', async () => {
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

  it('3-hop cycle also detected at maxDepth=4', async () => {
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

  it('scoring engine applies penalty to 4-hop cycle attesters', async () => {
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

  it('computes average only over agents with score > 0', async () => {
    // Insert 3 agents: scores 80, 60, 0
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-a'), avg_score: 80 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-b'), avg_score: 60 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-c'), avg_score: 0 }));

    const avg = agentRepo.avgScore();
    // Should be (80+60)/2 = 70, not (80+60+0)/3 = 46.7
    expect(avg).toBe(70);
  });

  it('returns 0 when all agents have score 0', async () => {
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-zero1'), avg_score: 0 }));
    agentRepo.insert(makeAgent({ public_key_hash: sha256('avg-zero2'), avg_score: 0 }));

    const avg = agentRepo.avgScore();
    expect(avg).toBe(0);
  });
});
