// Schema versioning and migration tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getAppliedVersions, rollbackTo } from '../database/migrations';
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
    expect(versions.length).toBe(33);
    expect(versions.map(v => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]);
  });

  it('records applied_at as ISO string and description for each version', () => {
    runMigrations(db);
    const versions = getAppliedVersions(db);
    for (const v of versions) {
      expect(v.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent across two full runs (baseline)', () => {
    runMigrations(db);
    runMigrations(db);
    const versions = getAppliedVersions(db);
    expect(versions.length).toBe(33);
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

// --- v31: Phase 1 dual-write transactions enrichment ---
// Additive migration adding 4 columns (endpoint_hash, operator_id, source,
// window_bucket) + 3 indexes to transactions. All nullable to preserve
// backwards compatibility with pre-v31 rows; backfill runs separately.
describe('v31 Phase 1 dual-write transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => { db.close(); });

  it('adds the 4 new columns to transactions', () => {
    const cols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string; type: string; notnull: number }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('endpoint_hash');
    expect(colNames).toContain('operator_id');
    expect(colNames).toContain('source');
    expect(colNames).toContain('window_bucket');
  });

  it('all 4 new columns are nullable (backwards-compatible)', () => {
    const cols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string; notnull: number }[];
    const enrichedCols = cols.filter(c => ['endpoint_hash', 'operator_id', 'source', 'window_bucket'].includes(c.name));
    for (const col of enrichedCols) {
      expect(col.notnull).toBe(0);
    }
  });

  it('source column enforces CHECK constraint with 4 valid values + NULL', () => {
    const sender = sha256('s31');
    const receiver = sha256('r31');
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('s31', { public_key_hash: sender }));
    agentRepo.insert(makeAgent('r31', { public_key_hash: receiver }));

    const insertStmt = db.prepare(
      `INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Valid sources accepted
    for (const src of ['probe', 'observer', 'report', 'intent']) {
      expect(() => insertStmt.run(`tx-${src}`, sender, receiver, 'micro', NOW, `ph-${src}`, 'verified', 'l402', src)).not.toThrow();
    }
    // NULL accepted (legacy row backwards compat)
    expect(() => insertStmt.run('tx-null', sender, receiver, 'micro', NOW, 'ph-null', 'verified', 'l402', null)).not.toThrow();
    // Invalid rejected
    expect(() => insertStmt.run('tx-bogus', sender, receiver, 'micro', NOW, 'ph-bogus', 'verified', 'l402', 'bogus')).toThrow(/CHECK constraint/);
  });

  it('creates the 3 expected indexes', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions'"
    ).all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_transactions_endpoint_window');
    expect(names).toContain('idx_transactions_operator_window');
    expect(names).toContain('idx_transactions_source');
  });

  it('preserves existing transactions indexes (sender, receiver, timestamp, status)', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions'"
    ).all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_transactions_sender');
    expect(names).toContain('idx_transactions_receiver');
    expect(names).toContain('idx_transactions_timestamp');
    expect(names).toContain('idx_transactions_status');
  });

  it('legacy INSERT (9 columns) still works, 4 new columns default to NULL', () => {
    const sender = sha256('s-legacy');
    const receiver = sha256('r-legacy');
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('s-legacy', { public_key_hash: sender }));
    agentRepo.insert(makeAgent('r-legacy', { public_key_hash: receiver }));

    const txRepo = new TransactionRepository(db);
    const tx: Transaction = {
      tx_id: 'legacy-tx-1',
      sender_hash: sender,
      receiver_hash: receiver,
      amount_bucket: 'micro',
      timestamp: NOW,
      payment_hash: 'legacy-ph-1',
      preimage: null,
      status: 'verified',
      protocol: 'l402',
    };
    expect(() => txRepo.insert(tx)).not.toThrow();

    const row = db.prepare('SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?').get('legacy-tx-1') as Record<string, unknown>;
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBeNull();
    expect(row.source).toBeNull();
    expect(row.window_bucket).toBeNull();
  });

  it('enriched INSERT (13 columns) persists all 4 new columns', () => {
    const sender = sha256('s-enriched');
    const receiver = sha256('r-enriched');
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('s-enriched', { public_key_hash: sender }));
    agentRepo.insert(makeAgent('r-enriched', { public_key_hash: receiver }));

    const endpointHash = sha256('https://api.example.com/svc');
    const operatorId = sha256('02abc123');
    db.prepare(
      `INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol, endpoint_hash, operator_id, source, window_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('enriched-tx-1', sender, receiver, 'micro', NOW, 'enriched-ph-1', 'verified', 'l402', endpointHash, operatorId, 'probe', '2026-04-17');

    const row = db.prepare('SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?').get('enriched-tx-1') as Record<string, unknown>;
    expect(row.endpoint_hash).toBe(endpointHash);
    expect(row.operator_id).toBe(operatorId);
    expect(row.source).toBe('probe');
    expect(row.window_bucket).toBe('2026-04-17');
  });

  it('migration is idempotent — second run does not throw on duplicate column', () => {
    expect(() => runMigrations(db)).not.toThrow();
    const versions = getAppliedVersions(db);
    expect(versions.filter(v => v.version === 31).length).toBe(1);
  });
});

// --- v32: Phase 2 anonymous-report preimage_pool ---
// Table dédiée pour reports permissionless. CHECK contraint strict sur source
// et confidence_tier. Rollback drope la table et ses 2 indexes.
describe('v32 Phase 2 anonymous-report preimage_pool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => { db.close(); });

  it('creates preimage_pool table with expected columns', () => {
    const cols = db.prepare('PRAGMA table_info(preimage_pool)').all() as { name: string; type: string; notnull: number }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toEqual([
      'payment_hash',
      'bolt11_raw',
      'first_seen',
      'confidence_tier',
      'source',
      'consumed_at',
      'consumer_report_id',
    ]);
    const notNullByName = Object.fromEntries(cols.map(c => [c.name, c.notnull]));
    expect(notNullByName.first_seen).toBe(1);
    expect(notNullByName.confidence_tier).toBe(1);
    expect(notNullByName.source).toBe(1);
    expect(notNullByName.consumed_at).toBe(0);
    expect(notNullByName.consumer_report_id).toBe(0);
    expect(notNullByName.bolt11_raw).toBe(0);
  });

  it('enforces CHECK on confidence_tier (high|medium|low)', () => {
    const insertStmt = db.prepare(
      "INSERT INTO preimage_pool (payment_hash, first_seen, confidence_tier, source) VALUES (?, ?, ?, 'crawler')"
    );
    for (const tier of ['high', 'medium', 'low']) {
      expect(() => insertStmt.run(`ph-${tier}`, NOW, tier)).not.toThrow();
    }
    expect(() => insertStmt.run('ph-bogus', NOW, 'bogus')).toThrow(/CHECK constraint/);
  });

  it('enforces CHECK on source (crawler|intent|report)', () => {
    const insertStmt = db.prepare(
      "INSERT INTO preimage_pool (payment_hash, first_seen, confidence_tier, source) VALUES (?, ?, 'medium', ?)"
    );
    for (const src of ['crawler', 'intent', 'report']) {
      expect(() => insertStmt.run(`ph-src-${src}`, NOW, src)).not.toThrow();
    }
    expect(() => insertStmt.run('ph-src-bogus', NOW, 'bogus')).toThrow(/CHECK constraint/);
  });

  it('payment_hash is PRIMARY KEY (INSERT OR IGNORE idempotent)', () => {
    db.prepare(
      "INSERT INTO preimage_pool (payment_hash, first_seen, confidence_tier, source) VALUES ('ph1', ?, 'medium', 'crawler')"
    ).run(NOW);
    const second = db.prepare(
      "INSERT OR IGNORE INTO preimage_pool (payment_hash, first_seen, confidence_tier, source) VALUES ('ph1', ?, 'low', 'report')"
    ).run(NOW + 1);
    expect(second.changes).toBe(0);
    const row = db.prepare('SELECT confidence_tier, source FROM preimage_pool WHERE payment_hash = ?').get('ph1') as { confidence_tier: string; source: string };
    expect(row.confidence_tier).toBe('medium');
    expect(row.source).toBe('crawler');
  });

  it('creates the 2 expected indexes on preimage_pool', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='preimage_pool'"
    ).all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_preimage_pool_confidence');
    expect(names).toContain('idx_preimage_pool_consumed');
  });

  it('rollback v32 drops table and indexes cleanly', () => {
    rollbackTo(db, 31);
    const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preimage_pool'").get();
    expect(after).toBeUndefined();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_preimage_pool_%'").all();
    expect(indexes.length).toBe(0);
    const versions = getAppliedVersions(db);
    expect(versions.length).toBe(31);
  });

  it('migration is idempotent — second run leaves exactly one v32 row', () => {
    expect(() => runMigrations(db)).not.toThrow();
    const versions = getAppliedVersions(db);
    expect(versions.filter(v => v.version === 32).length).toBe(1);
  });
});

// --- v33: Phase 3 bayesian scoring layer ---
// Additive migration : 8 nouvelles colonnes sur score_snapshots (posterior_alpha/beta,
// p_success, ci95_low/high, n_obs, window, updated_at) + 5 nouvelles tables
// *_aggregates (endpoint, node, service, operator, route) avec compteurs raw
// n_success/n_failure/n_obs et posterior (α, β). Les colonnes legacy score/components
// restent en place — leur suppression est reportée en migration v34 (C12).
describe('v33 Phase 3 bayesian scoring layer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => { db.close(); });

  it('adds 8 bayesian columns on score_snapshots (additive, legacy cols preserved)', () => {
    const cols = db.prepare('PRAGMA table_info(score_snapshots)').all() as { name: string; type: string }[];
    const colNames = cols.map(c => c.name);
    for (const col of ['posterior_alpha', 'posterior_beta', 'p_success', 'ci95_low', 'ci95_high', 'n_obs', 'window', 'updated_at']) {
      expect(colNames).toContain(col);
    }
    // Legacy columns still present (v34 will drop them in C12).
    expect(colNames).toContain('score');
    expect(colNames).toContain('components');
  });

  it('creates endpoint_aggregates with expected schema and defaults', () => {
    const cols = db.prepare('PRAGMA table_info(endpoint_aggregates)').all() as { name: string; dflt_value: string | null }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toEqual([
      'url_hash', 'window', 'n_success', 'n_failure', 'n_obs',
      'posterior_alpha', 'posterior_beta',
      'median_latency_ms', 'median_price_msat', 'updated_at',
    ]);
    const byName = Object.fromEntries(cols.map(c => [c.name, c.dflt_value]));
    expect(byName.posterior_alpha).toBe('1.5');
    expect(byName.posterior_beta).toBe('1.5');
    expect(byName.n_obs).toBe('0');
  });

  it('creates node_aggregates with dual posteriors (routing + delivery)', () => {
    const cols = db.prepare('PRAGMA table_info(node_aggregates)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    for (const col of ['routing_alpha', 'routing_beta', 'delivery_alpha', 'delivery_beta', 'n_routable', 'n_delivered']) {
      expect(colNames).toContain(col);
    }
  });

  it('creates service_aggregates, operator_aggregates, route_aggregates', () => {
    for (const table of ['service_aggregates', 'operator_aggregates', 'route_aggregates']) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      expect(exists).toBeDefined();
    }
  });

  it('enforces CHECK on window column (24h|7d|30d) for all aggregates', () => {
    const insert = db.prepare(`INSERT INTO endpoint_aggregates (url_hash, window, updated_at) VALUES (?, ?, ?)`);
    for (const w of ['24h', '7d', '30d']) {
      expect(() => insert.run(`hash-${w}`, w, NOW)).not.toThrow();
    }
    expect(() => insert.run('hash-bogus', '1y', NOW)).toThrow(/CHECK constraint/);
  });

  it('PRIMARY KEY (id, window) allows same id across three windows', () => {
    const hash = 'abc123';
    const insert = db.prepare(`INSERT INTO endpoint_aggregates (url_hash, window, updated_at) VALUES (?, ?, ?)`);
    insert.run(hash, '24h', NOW);
    insert.run(hash, '7d', NOW);
    insert.run(hash, '30d', NOW);
    const count = db.prepare('SELECT COUNT(*) as c FROM endpoint_aggregates WHERE url_hash = ?').get(hash) as { c: number };
    expect(count.c).toBe(3);
    // Same (hash, window) violates PK.
    expect(() => insert.run(hash, '24h', NOW)).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('rollback v33 drops all 5 aggregates tables and bayesian columns', () => {
    rollbackTo(db, 32);
    for (const table of ['endpoint_aggregates', 'node_aggregates', 'service_aggregates', 'operator_aggregates', 'route_aggregates']) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      expect(exists).toBeUndefined();
    }
    const cols = db.prepare('PRAGMA table_info(score_snapshots)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('posterior_alpha');
    expect(colNames).toContain('score');
    const versions = getAppliedVersions(db);
    expect(versions.length).toBe(32);
  });

  it('migration is idempotent — second run leaves exactly one v33 row', () => {
    expect(() => runMigrations(db)).not.toThrow();
    const versions = getAppliedVersions(db);
    expect(versions.filter(v => v.version === 33).length).toBe(1);
  });
});
