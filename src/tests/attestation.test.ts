// Attestation service tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { AttestationService } from '../services/attestationService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

const NOW = Math.floor(Date.now() / 1000);

function makeAgent(alias: string): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
    first_seen: NOW - 90 * 86400,
    last_seen: NOW - 86400,
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
    query_count: 0,
  };
}

describe('AttestationService', () => {
  let db: Database.Database;
  let service: AttestationService;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    service = new AttestationService(attestationRepo, agentRepo, txRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a valid attestation', () => {
    const attester = makeAgent('attester');
    const subject = makeAgent('subject');
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    const tx: Transaction = {
      tx_id: uuid(),
      sender_hash: attester.public_key_hash,
      receiver_hash: subject.public_key_hash,
      amount_bucket: 'small',
      timestamp: NOW - 3600,
      payment_hash: sha256('payment'),
      preimage: sha256('preimage'),
      status: 'verified',
      protocol: 'l402',
    };
    txRepo.insert(tx);

    const result = service.create({
      txId: tx.tx_id,
      attesterHash: attester.public_key_hash,
      subjectHash: subject.public_key_hash,
      score: 85,
      tags: ['fast', 'reliable'],
    });

    expect(result.attestation_id).toBeDefined();
    expect(result.score).toBe(85);
  });

  it('rejects self-attestation', () => {
    const agent = makeAgent('self-attester');
    agentRepo.insert(agent);

    const tx: Transaction = {
      tx_id: uuid(),
      sender_hash: agent.public_key_hash,
      receiver_hash: agent.public_key_hash,
      amount_bucket: 'micro',
      timestamp: NOW - 3600,
      payment_hash: sha256('self-tx'),
      preimage: null,
      status: 'verified',
      protocol: 'keysend',
    };
    txRepo.insert(tx);

    expect(() => service.create({
      txId: tx.tx_id,
      attesterHash: agent.public_key_hash,
      subjectHash: agent.public_key_hash,
      score: 100,
    })).toThrow('cannot attest itself');
  });

  it('rejects if attester does not exist', () => {
    const subject = makeAgent('subject-only');
    agentRepo.insert(subject);

    expect(() => service.create({
      txId: uuid(),
      attesterHash: sha256('ghost'),
      subjectHash: subject.public_key_hash,
      score: 50,
    })).toThrow('not found');
  });

  it('rejects if transaction does not exist', () => {
    const attester = makeAgent('att-no-tx');
    const subject = makeAgent('sub-no-tx');
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    expect(() => service.create({
      txId: uuid(),
      attesterHash: attester.public_key_hash,
      subjectHash: subject.public_key_hash,
      score: 80,
    })).toThrow('not found');
  });

  it('updates the denormalized counter of the subject', () => {
    const attester = makeAgent('counter-attester');
    const subject = makeAgent('counter-subject');
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    const tx: Transaction = {
      tx_id: uuid(),
      sender_hash: attester.public_key_hash,
      receiver_hash: subject.public_key_hash,
      amount_bucket: 'small',
      timestamp: NOW - 3600,
      payment_hash: sha256('counter-payment'),
      preimage: sha256('counter-preimage'),
      status: 'verified',
      protocol: 'l402',
    };
    txRepo.insert(tx);

    service.create({
      txId: tx.tx_id,
      attesterHash: attester.public_key_hash,
      subjectHash: subject.public_key_hash,
      score: 90,
    });

    const updated = agentRepo.findByHash(subject.public_key_hash)!;
    expect(updated.total_attestations_received).toBe(1);
  });
});
