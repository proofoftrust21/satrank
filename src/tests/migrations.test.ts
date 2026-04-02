// Schema versioning and migration tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getAppliedVersions } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
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
    query_count: 0,
    ...overrides,
  };
}

describe('Schema versioning', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => { db.close(); });

  it('creates schema_version table with all migration versions', () => {
    runMigrations(db);
    const versions = getAppliedVersions(db);
    expect(versions.length).toBe(9);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('records applied_at as ISO string and description for each version', () => {
    runMigrations(db);
    const versions = getAppliedVersions(db);
    for (const v of versions) {
      expect(v.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent — running twice does not duplicate versions', () => {
    runMigrations(db);
    runMigrations(db);
    const versions = getAppliedVersions(db);
    expect(versions.length).toBe(9);
  });

  it('does not re-apply existing migrations on second run', () => {
    runMigrations(db);
    const first = getAppliedVersions(db);

    runMigrations(db);
    const second = getAppliedVersions(db);

    // applied_at timestamps should be identical (not re-inserted)
    for (let i = 0; i < first.length; i++) {
      expect(second[i].applied_at).toBe(first[i].applied_at);
    }
  });

  it('getAppliedVersions returns empty array on fresh DB without migrations', () => {
    const versions = getAppliedVersions(db);
    expect(versions).toEqual([]);
  });
});

describe('UNIQUE(attester_hash, subject_hash) constraint', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);

    // Setup: two agents and two transactions
    agentRepo.insert(makeAgent('attester-a'));
    agentRepo.insert(makeAgent('subject-b'));

    const tx1: Transaction = {
      tx_id: 'tx-1',
      sender_hash: sha256('attester-a'),
      receiver_hash: sha256('subject-b'),
      amount_bucket: 'small',
      timestamp: NOW - DAY,
      payment_hash: 'pay1',
      preimage: null,
      status: 'verified',
      protocol: 'l402',
    };
    const tx2: Transaction = {
      tx_id: 'tx-2',
      sender_hash: sha256('attester-a'),
      receiver_hash: sha256('subject-b'),
      amount_bucket: 'medium',
      timestamp: NOW,
      payment_hash: 'pay2',
      preimage: null,
      status: 'verified',
      protocol: 'bolt11',
    };
    txRepo.insert(tx1);
    txRepo.insert(tx2);
  });

  afterEach(() => { db.close(); });

  it('allows one attestation per (attester, subject) pair', () => {
    const att: Attestation = {
      attestation_id: 'att-1',
      tx_id: 'tx-1',
      attester_hash: sha256('attester-a'),
      subject_hash: sha256('subject-b'),
      score: 80,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'general',
    };
    attestationRepo.insert(att);
    expect(attestationRepo.countBySubject(sha256('subject-b'))).toBe(1);
  });

  it('rejects duplicate attestation from same attester to same subject across different transactions', () => {
    const att1: Attestation = {
      attestation_id: 'att-1',
      tx_id: 'tx-1',
      attester_hash: sha256('attester-a'),
      subject_hash: sha256('subject-b'),
      score: 80,
      tags: null,
      evidence_hash: null,
      timestamp: NOW - DAY,
      category: 'general',
    };
    attestationRepo.insert(att1);

    const att2: Attestation = {
      attestation_id: 'att-2',
      tx_id: 'tx-2',
      attester_hash: sha256('attester-a'),
      subject_hash: sha256('subject-b'),
      score: 90,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'general',
    };
    expect(() => attestationRepo.insert(att2)).toThrow(/UNIQUE constraint failed/);
  });

  it('allows same attester to attest different subjects', () => {
    agentRepo.insert(makeAgent('subject-c'));
    const tx3: Transaction = {
      tx_id: 'tx-3',
      sender_hash: sha256('attester-a'),
      receiver_hash: sha256('subject-c'),
      amount_bucket: 'small',
      timestamp: NOW,
      payment_hash: 'pay3',
      preimage: null,
      status: 'verified',
      protocol: 'keysend',
    };
    txRepo.insert(tx3);

    const att1: Attestation = {
      attestation_id: 'att-1',
      tx_id: 'tx-1',
      attester_hash: sha256('attester-a'),
      subject_hash: sha256('subject-b'),
      score: 80,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'general',
    };
    const att2: Attestation = {
      attestation_id: 'att-2',
      tx_id: 'tx-3',
      attester_hash: sha256('attester-a'),
      subject_hash: sha256('subject-c'),
      score: 70,
      tags: null,
      evidence_hash: null,
      timestamp: NOW,
      category: 'general',
    };
    attestationRepo.insert(att1);
    attestationRepo.insert(att2);
    expect(attestationRepo.countBySubject(sha256('subject-b'))).toBe(1);
    expect(attestationRepo.countBySubject(sha256('subject-c'))).toBe(1);
  });

  it('v6 UNIQUE index exists in sqlite_master', () => {
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_unique_attester_subject'"
    ).get() as { name: string } | undefined;
    expect(idx).toBeDefined();
  });

  it('v6 migration deduplicates existing data and creates index on pre-existing DB', () => {
    // Simulate a pre-v6 database with duplicate (attester, subject) pairs
    const freshDb = new Database(':memory:');
    freshDb.pragma('foreign_keys = ON');

    // Create tables manually without v6 (simulate v1-v5)
    freshDb.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL);
      INSERT INTO schema_version VALUES (1, '2025-01-01T00:00:00Z', 'core tables');
      INSERT INTO schema_version VALUES (2, '2025-01-01T00:00:00Z', 'capacity_sats');
      INSERT INTO schema_version VALUES (3, '2025-01-01T00:00:00Z', 'LN+ fields');
      INSERT INTO schema_version VALUES (4, '2025-01-01T00:00:00Z', 'centrality');
      INSERT INTO schema_version VALUES (5, '2025-01-01T00:00:00Z', 'triggers');

      CREATE TABLE agents (
        public_key_hash TEXT PRIMARY KEY, public_key TEXT, alias TEXT,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        source TEXT NOT NULL, total_transactions INTEGER NOT NULL DEFAULT 0,
        total_attestations_received INTEGER NOT NULL DEFAULT 0,
        avg_score REAL NOT NULL DEFAULT 0, capacity_sats INTEGER,
        positive_ratings INTEGER NOT NULL DEFAULT 0, negative_ratings INTEGER NOT NULL DEFAULT 0,
        lnplus_rank INTEGER NOT NULL DEFAULT 0, hubness_rank INTEGER NOT NULL DEFAULT 0,
        betweenness_rank INTEGER NOT NULL DEFAULT 0, hopness_rank INTEGER NOT NULL DEFAULT 0,
        query_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE transactions (
        tx_id TEXT PRIMARY KEY, sender_hash TEXT NOT NULL, receiver_hash TEXT NOT NULL,
        amount_bucket TEXT NOT NULL, timestamp INTEGER NOT NULL, payment_hash TEXT NOT NULL,
        preimage TEXT, status TEXT NOT NULL, protocol TEXT NOT NULL
      );
      CREATE TABLE attestations (
        attestation_id TEXT PRIMARY KEY, tx_id TEXT NOT NULL,
        attester_hash TEXT NOT NULL, subject_hash TEXT NOT NULL,
        score INTEGER NOT NULL, tags TEXT, evidence_hash TEXT, timestamp INTEGER NOT NULL,
        UNIQUE(tx_id, attester_hash)
      );
      CREATE TABLE score_snapshots (
        snapshot_id TEXT PRIMARY KEY, agent_hash TEXT NOT NULL,
        score REAL NOT NULL, components TEXT NOT NULL, computed_at INTEGER NOT NULL
      );
    `);

    // Insert agents and transactions
    const attHash = sha256('dup-attester');
    const subHash = sha256('dup-subject');
    freshDb.exec(`
      INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES ('${attHash}', ${NOW - 90 * DAY}, ${NOW}, 'observer_protocol');
      INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES ('${subHash}', ${NOW - 90 * DAY}, ${NOW}, 'observer_protocol');
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol)
        VALUES ('tx-dup-1', '${attHash}', '${subHash}', 'small', ${NOW - DAY}, 'ph1', 'verified', 'l402');
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol)
        VALUES ('tx-dup-2', '${attHash}', '${subHash}', 'medium', ${NOW}, 'ph2', 'verified', 'bolt11');
    `);

    // Insert duplicate attestations (same attester+subject, different tx)
    freshDb.exec(`
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, timestamp)
        VALUES ('att-old', 'tx-dup-1', '${attHash}', '${subHash}', 70, ${NOW - DAY});
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, timestamp)
        VALUES ('att-new', 'tx-dup-2', '${attHash}', '${subHash}', 90, ${NOW});
    `);

    // Verify duplicates exist
    const beforeCount = (freshDb.prepare('SELECT COUNT(*) as c FROM attestations').get() as { c: number }).c;
    expect(beforeCount).toBe(2);

    // Run migrations — v6 should deduplicate and create the UNIQUE index
    runMigrations(freshDb);

    const afterCount = (freshDb.prepare('SELECT COUNT(*) as c FROM attestations').get() as { c: number }).c;
    expect(afterCount).toBe(1);

    // The kept attestation should be the newer one (higher rowid)
    const kept = freshDb.prepare('SELECT attestation_id FROM attestations').get() as { attestation_id: string };
    expect(kept.attestation_id).toBe('att-new');

    // UNIQUE index should exist
    const idx = freshDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_unique_attester_subject'"
    ).get();
    expect(idx).toBeDefined();

    freshDb.close();
  });
});
