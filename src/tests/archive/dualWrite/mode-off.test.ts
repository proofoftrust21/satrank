// @ts-nocheck — archived 2026-04-22 in Phase 12C (SQLite-era better-sqlite3 API, not ported to pg). See docs/phase-12c/TS-ERRORS-AUDIT.md.
// mode-off: legacy INSERT only. Covers the production default — v31 columns
// stay NULL, shadow logger is not consulted. This is what every prod instance
// runs until Phase 1 flips to dry_run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { DualWriteLogger, type DualWriteEnrichment } from '../../utils/dualWriteLogger';
import { sha256 } from '../../utils/crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Agent, Transaction } from '../../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, hash: string): Agent {
  return {
    public_key_hash: hash,
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
  };
}

function makeTx(txId: string, sender: string, receiver: string): Transaction {
  return {
    tx_id: txId,
    sender_hash: sender,
    receiver_hash: receiver,
    amount_bucket: 'micro',
    timestamp: NOW,
    payment_hash: `ph-${txId}`,
    preimage: null,
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

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('dual-write mode=off', async () => {
  let db: Pool;
  let tmpDir: string;
  const sender = sha256('s-off');
  const receiver = sha256('r-off');

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    const agentRepo = new AgentRepository(db);
    await agentRepo.insert(makeAgent('s-off', sender));
    await agentRepo.insert(makeAgent('r-off', receiver));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualwrite-off-'));
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('issues legacy 9-col INSERT; v31 columns stay NULL', async () => {
    const repo = new TransactionRepository(db);
    const tx = makeTx('off-tx-1', sender, receiver);

    await repo.insertWithDualWrite(tx, ENRICHMENT, 'off', 'crawler');

    const row = db.prepare(
      'SELECT tx_id, endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?'
    ).get('off-tx-1') as Record<string, unknown>;
    expect(row.tx_id).toBe('off-tx-1');
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBeNull();
    expect(row.source).toBeNull();
    expect(row.window_bucket).toBeNull();
  });

  it('never calls shadow logger in mode=off', async () => {
    const repo = new TransactionRepository(db);
    const logger = new DualWriteLogger(path.join(tmpDir, 'primary.ndjson'), tmpDir);

    await repo.insertWithDualWrite(makeTx('off-tx-2', sender, receiver), ENRICHMENT, 'off', 'crawler', logger);

    // No line written — file may exist (from init touch) but must be empty.
    const content = logger.effectivePath ? fs.readFileSync(logger.effectivePath, 'utf8') : '';
    expect(content).toBe('');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('persists the base 9 columns unchanged', async () => {
    const repo = new TransactionRepository(db);
    const tx = makeTx('off-tx-3', sender, receiver);

    await repo.insertWithDualWrite(tx, ENRICHMENT, 'off', 'crawler');

    const row = db.prepare(
      'SELECT tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol FROM transactions WHERE tx_id = ?'
    ).get('off-tx-3') as Record<string, unknown>;
    expect(row.sender_hash).toBe(sender);
    expect(row.receiver_hash).toBe(receiver);
    expect(row.amount_bucket).toBe('micro');
    expect(row.timestamp).toBe(NOW);
    expect(row.payment_hash).toBe('ph-off-tx-3');
    expect(row.status).toBe('verified');
    expect(row.protocol).toBe('l402');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('issues exactly one INSERT (no duplicate row)', async () => {
    const repo = new TransactionRepository(db);
    await repo.insertWithDualWrite(makeTx('off-tx-4', sender, receiver), ENRICHMENT, 'off', 'crawler');

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions WHERE tx_id = ?').get('off-tx-4') as { c: number }).c;
    expect(count).toBe(1);
  });
});