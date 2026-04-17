// mode-active: single 13-col INSERT with the enriched columns populated.
// Post-flip state — the canonical ledger is now authoritative for Phase 3
// Bayesian aggregates. Shadow logger is explicitly silent in this mode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../database/migrations';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { DualWriteLogger, type DualWriteEnrichment } from '../../utils/dualWriteLogger';
import { sha256 } from '../../utils/crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Agent, Transaction } from '../../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, hash: string): Agent {
  return {
    public_key_hash: hash,
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
  };
}

function makeTx(txId: string, sender: string, receiver: string): Transaction {
  return {
    tx_id: txId,
    sender_hash: sender,
    receiver_hash: receiver,
    amount_bucket: 'medium',
    timestamp: NOW,
    payment_hash: `ph-${txId}`,
    preimage: 'preimage-hex',
    status: 'verified',
    protocol: 'l402',
  };
}

const ENRICHMENT: DualWriteEnrichment = {
  endpoint_hash: sha256('https://api.example.com/svc'),
  operator_id: sha256('02abc123'),
  source: 'probe',
  window_bucket: '2026-04-18',
};

describe('dual-write mode=active', () => {
  let db: Database.Database;
  let tmpDir: string;
  const sender = sha256('s-act');
  const receiver = sha256('r-act');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('s-act', sender));
    agentRepo.insert(makeAgent('r-act', receiver));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualwrite-act-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('issues single 13-col INSERT with v31 columns populated', () => {
    const repo = new TransactionRepository(db);
    repo.insertWithDualWrite(makeTx('act-tx-1', sender, receiver), ENRICHMENT, 'active');

    const row = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?'
    ).get('act-tx-1') as Record<string, unknown>;
    expect(row.endpoint_hash).toBe(ENRICHMENT.endpoint_hash);
    expect(row.operator_id).toBe(ENRICHMENT.operator_id);
    expect(row.source).toBe(ENRICHMENT.source);
    expect(row.window_bucket).toBe(ENRICHMENT.window_bucket);
  });

  it('persists the base 9 columns alongside the enriched 4', () => {
    const repo = new TransactionRepository(db);
    repo.insertWithDualWrite(makeTx('act-tx-2', sender, receiver), ENRICHMENT, 'active');

    const row = db.prepare(
      'SELECT tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol FROM transactions WHERE tx_id = ?'
    ).get('act-tx-2') as Record<string, unknown>;
    expect(row.tx_id).toBe('act-tx-2');
    expect(row.sender_hash).toBe(sender);
    expect(row.receiver_hash).toBe(receiver);
    expect(row.amount_bucket).toBe('medium');
    expect(row.timestamp).toBe(NOW);
    expect(row.preimage).toBe('preimage-hex');
    expect(row.status).toBe('verified');
    expect(row.protocol).toBe('l402');
  });

  it('does NOT emit NDJSON even when a shadowLogger is passed', () => {
    const repo = new TransactionRepository(db);
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);

    repo.insertWithDualWrite(makeTx('act-tx-3', sender, receiver), ENRICHMENT, 'active', logger);

    // File exists (init touch) but must have zero payload bytes.
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toBe('');
  });

  it('accepts NULL enrichment values (operator unknown, Observer-origin row)', () => {
    const repo = new TransactionRepository(db);
    const partial: DualWriteEnrichment = {
      endpoint_hash: null,
      operator_id: null,
      source: 'observer',
      window_bucket: '2026-04-18',
    };
    repo.insertWithDualWrite(makeTx('act-tx-null', sender, receiver), partial, 'active');

    const row = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?'
    ).get('act-tx-null') as Record<string, unknown>;
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBeNull();
    expect(row.source).toBe('observer');
    expect(row.window_bucket).toBe('2026-04-18');
  });

  it('issues exactly one row (no dual write)', () => {
    const repo = new TransactionRepository(db);
    repo.insertWithDualWrite(makeTx('act-tx-single', sender, receiver), ENRICHMENT, 'active');

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions WHERE tx_id = ?').get('act-tx-single') as { c: number }).c;
    expect(count).toBe(1);
  });

  it('rejects invalid source via CHECK constraint', () => {
    const repo = new TransactionRepository(db);
    // @ts-expect-error — runtime CHECK path
    const bad: DualWriteEnrichment = { ...ENRICHMENT, source: 'bogus' };

    expect(() => repo.insertWithDualWrite(makeTx('act-tx-bad', sender, receiver), bad, 'active')).toThrow(/CHECK constraint/);
  });
});
