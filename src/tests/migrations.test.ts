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
    unique_peers: null,
    last_queried_at: null,
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
    expect(versions.length).toBe(15);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
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
    expect(versions.length).toBe(15);
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

// --- v14: stale flag ---
// Covers fossil cleanup after the bitcoind migration: soft-flagging only,
// sweep + revive cycle, and stats exclusion.
describe('v14 stale flag', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
  });

  afterEach(() => { db.close(); });

  it('adds the stale column with default 0 for new agents', () => {
    agentRepo.insert(makeAgent('fresh', { last_seen: NOW - DAY }));
    const row = db.prepare('SELECT stale FROM agents WHERE public_key_hash = ?').get(sha256('fresh')) as { stale: number };
    expect(row.stale).toBe(0);
  });

  it('markStaleByAge flags agents whose last_seen is older than the threshold', () => {
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY }));
    agentRepo.insert(makeAgent('recent', { last_seen: NOW - DAY }));

    const flagged = agentRepo.markStaleByAge(90 * 86400);
    expect(flagged).toBe(1);
    expect(agentRepo.countStale()).toBe(1);

    const fossil = db.prepare('SELECT stale FROM agents WHERE public_key_hash = ?').get(sha256('fossil')) as { stale: number };
    const recent = db.prepare('SELECT stale FROM agents WHERE public_key_hash = ?').get(sha256('recent')) as { stale: number };
    expect(fossil.stale).toBe(1);
    expect(recent.stale).toBe(0);
  });

  it('markStaleByAge is idempotent — repeated calls do not re-flag', () => {
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY }));
    expect(agentRepo.markStaleByAge(90 * 86400)).toBe(1);
    expect(agentRepo.markStaleByAge(90 * 86400)).toBe(0);
  });

  it('markStaleByAge unflags a revived agent whose last_seen is now recent', () => {
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.countStale()).toBe(1);

    // Simulate last_seen being updated directly (e.g. by an external process)
    db.prepare('UPDATE agents SET last_seen = ? WHERE public_key_hash = ?').run(NOW - DAY, sha256('fossil'));
    // Re-running the sweep should unflag it
    const changed = agentRepo.markStaleByAge(90 * 86400);
    expect(changed).toBe(1);
    expect(agentRepo.countStale()).toBe(0);
  });

  it('updateLightningStats with an old gossip timestamp keeps agent stale (zombie gossip)', () => {
    agentRepo.insert(makeAgent('zombie', { last_seen: NOW - 100 * DAY, source: 'lightning_graph' }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.countStale()).toBe(1);

    // LND graph sees the node but gossip last_update is still 120d old
    agentRepo.updateLightningStats(sha256('zombie'), 10, 1_000_000, 'zombie', NOW - 120 * DAY, 5);
    expect(agentRepo.countStale()).toBe(1); // remains stale — new last_seen is still old
  });

  it('updateCapacity with an old timestamp does not revive via MAX shortcut', () => {
    // Agent was active 120 days ago, stale now
    agentRepo.insert(makeAgent('frozen', { last_seen: NOW - 120 * DAY }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.countStale()).toBe(1);

    // updateCapacity receives an even older timestamp — MAX keeps last_seen at 120d ago
    agentRepo.updateCapacity(sha256('frozen'), 500_000_000, NOW - 200 * DAY);
    expect(agentRepo.countStale()).toBe(1);
  });

  it('updateLightningStats revives a stale agent (stale returns to 0)', () => {
    agentRepo.insert(makeAgent('binance', { last_seen: NOW - 100 * DAY, source: 'lightning_graph' }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.countStale()).toBe(1);

    // Crawler sees the agent again
    agentRepo.updateLightningStats(sha256('binance'), 164, 40_895_000_000, 'binance', NOW, 45);
    expect(agentRepo.countStale()).toBe(0);
    const row = db.prepare('SELECT stale FROM agents WHERE public_key_hash = ?').get(sha256('binance')) as { stale: number };
    expect(row.stale).toBe(0);
  });

  it('updateCapacity revives a stale agent', () => {
    agentRepo.insert(makeAgent('fossil-cap', { last_seen: NOW - 100 * DAY }));
    agentRepo.markStaleByAge(90 * 86400);
    agentRepo.updateCapacity(sha256('fossil-cap'), 500_000_000, NOW);
    expect(agentRepo.countStale()).toBe(0);
  });

  it('count() excludes stale agents', () => {
    agentRepo.insert(makeAgent('alive', { last_seen: NOW - DAY }));
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.count()).toBe(1);
    expect(agentRepo.countIncludingStale()).toBe(2);
    expect(agentRepo.countStale()).toBe(1);
  });

  it('findScoredAbove excludes stale agents — NIP-85 publisher path', () => {
    agentRepo.insert(makeAgent('alive-hi', { last_seen: NOW - DAY, avg_score: 80 }));
    agentRepo.insert(makeAgent('fossil-hi', { last_seen: NOW - 100 * DAY, avg_score: 90 }));
    agentRepo.markStaleByAge(90 * 86400);

    const scored = agentRepo.findScoredAbove(30);
    expect(scored).toHaveLength(1);
    expect(scored[0].alias).toBe('alive-hi');
  });

  it('findTopByScore excludes stale agents — leaderboard path', () => {
    agentRepo.insert(makeAgent('alive', { last_seen: NOW - DAY, avg_score: 50 }));
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY, avg_score: 99 }));
    agentRepo.markStaleByAge(90 * 86400);

    const top = agentRepo.findTopByScore(10, 0);
    expect(top).toHaveLength(1);
    expect(top[0].alias).toBe('alive');
  });

  it('findByHash still returns a stale agent (direct lookup bypasses filter)', () => {
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY }));
    agentRepo.markStaleByAge(90 * 86400);
    const found = agentRepo.findByHash(sha256('fossil'));
    expect(found).toBeDefined();
    expect(found?.alias).toBe('fossil');
  });

  it('countBySource excludes stale agents', () => {
    agentRepo.insert(makeAgent('alive-lg', { last_seen: NOW - DAY, source: 'lightning_graph' }));
    agentRepo.insert(makeAgent('fossil-lg', { last_seen: NOW - 100 * DAY, source: 'lightning_graph' }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.countBySource('lightning_graph')).toBe(1);
  });

  it('getRank returns null for a stale agent', () => {
    agentRepo.insert(makeAgent('fossil', { last_seen: NOW - 100 * DAY, avg_score: 80 }));
    agentRepo.insert(makeAgent('alive', { last_seen: NOW - DAY, avg_score: 50 }));
    agentRepo.markStaleByAge(90 * 86400);
    expect(agentRepo.getRank(sha256('fossil'))).toBe(null);
    expect(agentRepo.getRank(sha256('alive'))).toBe(1);
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
      verified: 0,
      weight: 1.0,
    };
    attestationRepo.insert(att);
    expect(attestationRepo.countBySubject(sha256('subject-b'))).toBe(1);
  });

  it('allows multiple attestations from same attester to same subject after v11 (unique constraint dropped)', () => {
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
      verified: 0,
      weight: 1.0,
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
      verified: 0,
      weight: 1.0,
    };
    // v11 dropped the UNIQUE(attester_hash, subject_hash) constraint to support multi-report
    attestationRepo.insert(att2);
    expect(attestationRepo.countBySubject(sha256('subject-b'))).toBe(2);
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
      verified: 0,
      weight: 1.0,
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
      verified: 0,
      weight: 1.0,
    };
    attestationRepo.insert(att1);
    attestationRepo.insert(att2);
    expect(attestationRepo.countBySubject(sha256('subject-b'))).toBe(1);
    expect(attestationRepo.countBySubject(sha256('subject-c'))).toBe(1);
  });

  it('v11 drops UNIQUE index and adds attester_subject_time composite index', () => {
    // After v11, the unique index should be gone
    const uniqueIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_unique_attester_subject'"
    ).get();
    expect(uniqueIdx).toBeUndefined();

    // But the composite lookup index should exist
    const compositeIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attestations_attester_subject_time'"
    ).get() as { name: string } | undefined;
    expect(compositeIdx).toBeDefined();
  });

  it('v11 adds verified and weight columns to attestations', () => {
    const cols = db.prepare("PRAGMA table_info(attestations)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('verified');
    expect(colNames).toContain('weight');
  });
});
