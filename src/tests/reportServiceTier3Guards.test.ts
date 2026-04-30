// Audit Tier 3 (2026-04-30) — guards on reportService.submit() against:
//   3A : negative-report flood on a single target (cap 30/h)
//   3C : self-promotion via shared operator_id (block reporter+target same op)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { v4 as uuid } from 'uuid';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { OperatorRepository, OperatorOwnershipRepository } from '../repositories/operatorRepository';
import { ScoringService } from '../services/scoringService';
import { ReportService } from '../services/reportService';
import { ValidationError } from '../errors';
import { sha256 } from '../utils/crypto';
import type { Agent, Attestation } from '../types';

let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);

function makeAgent(alias: string): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
    first_seen: NOW - 90 * 86400,
    last_seen: NOW - 86400,
    source: 'attestation',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 50,
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
  };
}

function makeFailureAttestation(reporter: string, target: string, txId: string): Attestation {
  return {
    attestation_id: uuid(),
    tx_id: txId,
    attester_hash: reporter,
    subject_hash: target,
    score: 15,
    tags: null,
    evidence_hash: null,
    timestamp: NOW - 60, // 1 min ago — within 1h window
    category: 'failed_transaction',
    verified: 0,
    weight: 0.5,
  };
}

async function insertNegativeAttestation(
  agentRepo: AgentRepository,
  txRepo: TransactionRepository,
  attestationRepo: AttestationRepository,
  reporter: string,
  target: string,
): Promise<void> {
  const tx = {
    tx_id: uuid(),
    sender_hash: reporter,
    receiver_hash: target,
    amount_bucket: 'micro' as const,
    timestamp: NOW - 60,
    payment_hash: sha256(uuid()),
    preimage: null,
    status: 'failed' as const,
    protocol: 'bolt11' as const,
  };
  await txRepo.insert(tx);
  await attestationRepo.insert(makeFailureAttestation(reporter, target, tx.tx_id));
}

describe('Tier 3 guards on reportService.submit', () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let scoring: ScoringService;
  let ownershipRepo: OperatorOwnershipRepository;
  let operatorRepo: OperatorRepository;
  let reportService: ReportService;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    operatorRepo = new OperatorRepository(db);
    ownershipRepo = new OperatorOwnershipRepository(db);
    reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoring, db,
      'off', undefined, undefined,
      ownershipRepo,
    );
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('Tier 3A: rejects negative reports on a target after 30 in 1h', async () => {
    const reporter = makeAgent('honest-reporter');
    const target = makeAgent('victim-target');
    await agentRepo.insert(reporter);
    await agentRepo.insert(target);

    // Pre-insert 30 negative attestations from various reporters
    for (let i = 0; i < 30; i++) {
      const fakeReporter = makeAgent(`drone-${i}`);
      await agentRepo.insert(fakeReporter);
      await insertNegativeAttestation(agentRepo, txRepo, attestationRepo, fakeReporter.public_key_hash, target.public_key_hash);
    }

    // 31st negative report (from the honest reporter or any other) → rejected
    await expect(reportService.submit({
      reporter: reporter.public_key_hash,
      target: target.public_key_hash,
      outcome: 'failure',
      memo: 'should fail flood guard',
    })).rejects.toThrow(/Target negative-report flood/);
  });

  it('Tier 3A: success reports NOT subject to the negative-flood cap', async () => {
    const reporter = makeAgent('honest-reporter-success');
    const target = makeAgent('popular-target');
    await agentRepo.insert(reporter);
    await agentRepo.insert(target);

    // Pre-fill 50 negative reports (well above the cap)
    for (let i = 0; i < 50; i++) {
      const drone = makeAgent(`neg-drone-${i}`);
      await agentRepo.insert(drone);
      await insertNegativeAttestation(agentRepo, txRepo, attestationRepo, drone.public_key_hash, target.public_key_hash);
    }

    // A POSITIVE report should still go through — the cap only throttles negatives
    const result = await reportService.submit({
      reporter: reporter.public_key_hash,
      target: target.public_key_hash,
      outcome: 'success',
      memo: 'positive should pass',
    });
    expect(result.reportId).toBeDefined();
  });

  it('Tier 3C: rejects report when reporter and target share operator_id', async () => {
    const reporter = makeAgent('mallory-node-A');
    const target = makeAgent('mallory-node-B');
    await agentRepo.insert(reporter);
    await agentRepo.insert(target);

    // Both nodes claimed by the same operator
    const opId = sha256('mallory-operator');
    await operatorRepo.upsertPending(opId, NOW);
    await ownershipRepo.claimNode(opId, reporter.public_key_hash, NOW);
    await ownershipRepo.claimNode(opId, target.public_key_hash, NOW);

    await expect(reportService.submit({
      reporter: reporter.public_key_hash,
      target: target.public_key_hash,
      outcome: 'success',
      memo: 'self-promotion attempt',
    })).rejects.toThrow(/same operator/i);
  });

  it('Tier 3C: accepts report when reporter and target have DIFFERENT operator_ids', async () => {
    const reporter = makeAgent('alice-node');
    const target = makeAgent('bob-node');
    await agentRepo.insert(reporter);
    await agentRepo.insert(target);

    const aliceOp = sha256('alice-op');
    const bobOp = sha256('bob-op');
    await operatorRepo.upsertPending(aliceOp, NOW);
    await operatorRepo.upsertPending(bobOp, NOW);
    await ownershipRepo.claimNode(aliceOp, reporter.public_key_hash, NOW);
    await ownershipRepo.claimNode(bobOp, target.public_key_hash, NOW);

    const result = await reportService.submit({
      reporter: reporter.public_key_hash,
      target: target.public_key_hash,
      outcome: 'success',
      memo: 'legit cross-operator report',
    });
    expect(result.reportId).toBeDefined();
  });

  it('Tier 3C: accepts report when one side has no operator mapping (fail-open)', async () => {
    const reporter = makeAgent('mapped-alice');
    const target = makeAgent('unmapped-target');
    await agentRepo.insert(reporter);
    await agentRepo.insert(target);

    // Only reporter is mapped to an operator; target has no operator_owns_node row
    const aliceOp = sha256('alice-op-only');
    await operatorRepo.upsertPending(aliceOp, NOW);
    await ownershipRepo.claimNode(aliceOp, reporter.public_key_hash, NOW);

    const result = await reportService.submit({
      reporter: reporter.public_key_hash,
      target: target.public_key_hash,
      outcome: 'success',
      memo: 'partial-mapping report',
    });
    expect(result.reportId).toBeDefined();
  });
});
