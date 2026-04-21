// Report signal integration into reputation scoring
// Tests the closed feedback loop: decide -> pay -> report -> score adjustment
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
    preimage: null,
    status: 'verified',
    protocol: 'bolt11',
    ...overrides,
  };
}

/** Create a report attestation (mimics what await reportService.submit() stores) */
function makeReportAttestation(
  reporter: string,
  subject: string,
  txId: string,
  outcome: 'success' | 'failure' | 'timeout',
  overrides: Partial<Attestation> = {},
): Attestation {
  const scoreMap = { success: 85, failure: 15, timeout: 25 };
  const categoryMap = { success: 'successful_transaction', failure: 'failed_transaction', timeout: 'unresponsive' } as const;
  return {
    attestation_id: uuid(),
    tx_id: txId,
    attester_hash: reporter,
    subject_hash: subject,
    score: scoreMap[outcome],
    tags: null,
    evidence_hash: null,
    timestamp: NOW - Math.floor(Math.random() * 30 * DAY),
    category: categoryMap[outcome],
    verified: 0,
    weight: 0.5,
    ...overrides,
  };
}

describe('Report signal in reputation scoring', async () => {
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

  /** Helper: insert N reports for an agent with the given outcome */
  async function insertReports(
    targetHash: string,
    count: number,
    outcome: 'success' | 'failure' | 'timeout',
    opts: { verified?: boolean; weight?: number } = {},
  ): void {
    for (let i = 0; i < count; i++) {
      const reporterAlias = `reporter-${outcome}-${i}-${uuid().slice(0, 8)}`;
      const reporter = makeAgent(reporterAlias);
      await agentRepo.insert(reporter);

      const tx = makeTx(reporter.public_key_hash, targetHash);
      await txRepo.insert(tx);

      await attestationRepo.insert(makeReportAttestation(
        reporter.public_key_hash,
        targetHash,
        tx.tx_id,
        outcome,
        {
          verified: opts.verified ? 1 : 0,
          weight: opts.weight ?? 0.5,
        },
      ));
    }
  }

  it('agent with 0 reports -> no change to reputation', async () => {
    const agent = makeAgent('no-reports');
    await agentRepo.insert(agent);

    const result = await scoring.computeScore(agent.public_key_hash);
    // No reports, no attestations -> neutral baseline 50 (missing-data pattern,
    // same as feeStability/capacityTrend/routingQuality in lightning_graph mode)
    expect(result.components.reputation).toBe(50);
  });

  it('agent with a single report -> no change (anti-spam)', async () => {
    const agent = makeAgent('one-report');
    await agentRepo.insert(agent);

    // Phase 4 P5: the binary cutoff at 5 is replaced by linear damping
    // damp = min(1, (total-1)/9). At total=1, damp=0 → no signal.
    await insertReports(agent.public_key_hash, 1, 'success');

    const result = await scoring.computeScore(agent.public_key_hash);
    expect(result.components.reputation).toBe(50);
  });

  it('agent with <10 reports -> graduated signal (damped)', async () => {
    const agent = makeAgent('few-reports');
    await agentRepo.insert(agent);

    // Phase 4 P5: 4 reports now contribute damp = 3/9 ≈ 0.333 of the signal.
    // 4 successes → ratio=1.0 → (1.0-0.5)*2*10*0.333 ≈ 3.33 → rounds to 3.
    // Previously (hard cutoff at 5), this was exactly 0 and the score
    // jumped from 50 to 60 at the 5th report. Now it ramps smoothly.
    await insertReports(agent.public_key_hash, 4, 'success');

    const result = await scoring.computeScore(agent.public_key_hash);
    expect(result.components.reputation).toBe(53);
  });

  it('agent with 10 positive reports -> reputation boost (capped at +10)', async () => {
    const agent = makeAgent('well-reported');
    await agentRepo.insert(agent);

    // Insert 10 success reports
    await insertReports(agent.public_key_hash, 10, 'success');

    const result = await scoring.computeScore(agent.public_key_hash);
    // With only reports (no attestations), reputation = neutral 50 + report signal
    // 10 successes, 0 failures -> ratio = 1.0 -> adjustment = (1.0 - 0.5) * 2 * 10 = +10
    // Final: 50 + 10 = 60
    expect(result.components.reputation).toBe(60);
  });

  it('agent with 10 negative reports -> reputation penalty (capped at -10)', async () => {
    const agent = makeAgent('badly-reported');
    await agentRepo.insert(agent);

    // Insert 10 failure reports
    await insertReports(agent.public_key_hash, 10, 'failure');

    const result = await scoring.computeScore(agent.public_key_hash);
    // 10 failures, 0 successes -> ratio = 0.0 -> adjustment = (0.0 - 0.5) * 2 * 10 = -10
    // Final: 50 - 10 = 40 (baseline 50 + negative adjustment)
    expect(result.components.reputation).toBe(40);
  });

  it('verified reports weighted 2x', async () => {
    // Agent A: 5 unverified success reports + 5 unverified failure reports
    const agentA = makeAgent('mixed-unverified');
    await agentRepo.insert(agentA);
    await insertReports(agentA.public_key_hash, 5, 'success', { verified: false, weight: 1.0 });
    await insertReports(agentA.public_key_hash, 5, 'failure', { verified: false, weight: 1.0 });

    // Agent B: 5 verified success reports + 5 unverified failure reports
    // Verified successes get 2x weight, tilting the ratio positive
    const agentB = makeAgent('mixed-verified');
    await agentRepo.insert(agentB);
    await insertReports(agentB.public_key_hash, 5, 'success', { verified: true, weight: 1.0 });
    await insertReports(agentB.public_key_hash, 5, 'failure', { verified: false, weight: 1.0 });

    const resultA = await scoring.computeScore(agentA.public_key_hash);
    const resultB = await scoring.computeScore(agentB.public_key_hash);

    // Agent A: equal weight successes and failures -> neutral (0 adjustment)
    // Agent B: verified successes have 2x weight -> tilted positive -> positive adjustment
    expect(resultB.components.reputation).toBeGreaterThan(resultA.components.reputation);
  });

  it('report signal adds to attestation-based reputation', async () => {
    // Agent with attestations AND positive reports should score higher than attestations alone
    const agentWithReports = makeAgent('att-plus-reports', { avg_score: 60 });
    const agentNoReports = makeAgent('att-only', { avg_score: 60 });
    await agentRepo.insert(agentWithReports);
    await agentRepo.insert(agentNoReports);

    // Both agents get identical attestations from 5 peers
    for (const targetAgent of [agentWithReports, agentNoReports]) {
      for (let i = 0; i < 5; i++) {
        const peer = makeAgent(`peer-${targetAgent.alias}-${i}`, { avg_score: 60 });
        await agentRepo.insert(peer);
        const tx = makeTx(peer.public_key_hash, targetAgent.public_key_hash);
        await txRepo.insert(tx);
        await attestationRepo.insert({
          attestation_id: uuid(),
          tx_id: tx.tx_id,
          attester_hash: peer.public_key_hash,
          subject_hash: targetAgent.public_key_hash,
          score: 80,
          tags: null,
          evidence_hash: null,
          timestamp: NOW - DAY,
          category: 'general',
          verified: 0,
          weight: 1.0,
        });
      }
    }

    // Only the first agent also has 10 positive reports
    await insertReports(agentWithReports.public_key_hash, 10, 'success');

    const scoreWithReports = await scoring.computeScore(agentWithReports.public_key_hash);
    const scoreNoReports = await scoring.computeScore(agentNoReports.public_key_hash);

    // The agent with positive reports should have higher reputation
    expect(scoreWithReports.components.reputation).toBeGreaterThan(scoreNoReports.components.reputation);
    // The boost should be at most +10 points
    expect(scoreWithReports.components.reputation - scoreNoReports.components.reputation).toBeLessThanOrEqual(10);
  });

  it('report signal capped at +10 even with many reports', async () => {
    const agent = makeAgent('many-reports');
    await agentRepo.insert(agent);

    // 50 success reports — should still cap at +10
    await insertReports(agent.public_key_hash, 50, 'success');

    const result = await scoring.computeScore(agent.public_key_hash);
    // All successes -> (1.0 - 0.5) * 2 * 10 = +10, capped at 10
    // Final: 50 + 10 = 60 (capped at 60)
    expect(result.components.reputation).toBeLessThanOrEqual(60);
  });

  it('timeout reports count as negative', async () => {
    const agent = makeAgent('timeout-agent');
    await agentRepo.insert(agent);

    // 10 timeout reports (score=25, which is < 50, so treated as failure)
    await insertReports(agent.public_key_hash, 10, 'timeout');

    const result = await scoring.computeScore(agent.public_key_hash);
    // All timeouts -> ratio = 0.0 -> adjustment = -10
    // Final: 50 - 10 = 40
    expect(result.components.reputation).toBe(40);
  });

  it('mixed reports produce proportional signal', async () => {
    const agent = makeAgent('mixed-reports');
    await agentRepo.insert(agent);

    // 7 success + 3 failure = 10 total, all unverified, weight=1.0
    await insertReports(agent.public_key_hash, 7, 'success', { weight: 1.0 });
    await insertReports(agent.public_key_hash, 3, 'failure', { weight: 1.0 });

    const result = await scoring.computeScore(agent.public_key_hash);
    // ratio = 7/10 = 0.7 -> adjustment = (0.7 - 0.5) * 2 * 10 = +4
    // Final: 50 + 4 = 54
    expect(result.components.reputation).toBe(54);
  });

  describe('attestationRepository.reportSignalStats', async () => {
    it('returns zeros for agent with no reports', async () => {
      const agent = makeAgent('empty-stats');
      await agentRepo.insert(agent);

      const stats = await attestationRepo.reportSignalStats(agent.public_key_hash);
      expect(stats.total).toBe(0);
      expect(stats.weightedSuccesses).toBe(0);
      expect(stats.weightedFailures).toBe(0);
    });

    it('correctly weights verified vs unverified reports', async () => {
      const agent = makeAgent('verify-stats');
      await agentRepo.insert(agent);

      // 1 unverified success (weight=1.0, verified=0) -> weighted = 1.0 * (1+0) = 1.0
      await insertReports(agent.public_key_hash, 1, 'success', { verified: false, weight: 1.0 });
      // 1 verified success (weight=1.0, verified=1) -> weighted = 1.0 * (1+1) = 2.0
      await insertReports(agent.public_key_hash, 1, 'success', { verified: true, weight: 1.0 });

      const stats = await attestationRepo.reportSignalStats(agent.public_key_hash);
      expect(stats.total).toBe(2);
      // Total weighted successes: 1.0 + 2.0 = 3.0
      expect(stats.weightedSuccesses).toBe(3);
      expect(stats.weightedFailures).toBe(0);
    });

    it('does not count general attestations as reports', async () => {
      const agent = makeAgent('general-att');
      const peer = makeAgent('general-peer');
      await agentRepo.insert(agent);
      await agentRepo.insert(peer);

      const tx = makeTx(peer.public_key_hash, agent.public_key_hash);
      await txRepo.insert(tx);

      // General attestation (not a report)
      await attestationRepo.insert({
        attestation_id: uuid(),
        tx_id: tx.tx_id,
        attester_hash: peer.public_key_hash,
        subject_hash: agent.public_key_hash,
        score: 90,
        tags: null,
        evidence_hash: null,
        timestamp: NOW,
        category: 'general',
        verified: 0,
        weight: 1.0,
      });

      const stats = await attestationRepo.reportSignalStats(agent.public_key_hash);
      expect(stats.total).toBe(0);
    });
  });
});
