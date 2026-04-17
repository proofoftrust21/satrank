// mode-dry_run: legacy INSERT + NDJSON shadow log. Validates the
// observation window before flipping to `active` — the enriched row is
// serialized to disk but the DB stays identical to mode=off output.
// Also covers the logger's path fallback contract.
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
    amount_bucket: 'small',
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

describe('dual-write mode=dry_run', () => {
  let db: Database.Database;
  let tmpDir: string;
  const sender = sha256('s-dry');
  const receiver = sha256('r-dry');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('s-dry', sender));
    agentRepo.insert(makeAgent('r-dry', receiver));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualwrite-dry-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('legacy 9-col INSERT — v31 columns still NULL in DB', () => {
    const repo = new TransactionRepository(db);
    const logger = new DualWriteLogger(path.join(tmpDir, 'primary.ndjson'), tmpDir);

    repo.insertWithDualWrite(makeTx('dry-tx-1', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);

    const row = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?'
    ).get('dry-tx-1') as Record<string, unknown>;
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBeNull();
    expect(row.source).toBeNull();
    expect(row.window_bucket).toBeNull();
  });

  it('emits one NDJSON line per insert with the §3 enriched row', () => {
    const repo = new TransactionRepository(db);
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);

    repo.insertWithDualWrite(makeTx('dry-tx-2', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);

    const content = fs.readFileSync(logPath, 'utf8').trim();
    expect(content.split('\n').length).toBe(1);
    const row = JSON.parse(content);
    expect(row.would_insert.tx_id).toBe('dry-tx-2');
    expect(row.would_insert.endpoint_hash).toBe(ENRICHMENT.endpoint_hash);
    expect(row.would_insert.operator_id).toBe(ENRICHMENT.operator_id);
    expect(row.would_insert.source).toBe(ENRICHMENT.source);
    expect(row.would_insert.window_bucket).toBe(ENRICHMENT.window_bucket);
    expect(typeof row.emitted_at).toBe('number');
    expect(row.source_module).toBe('crawler');
    expect(row.legacy_inserted).toBe(true);
  });

  it('multiple inserts append multiple NDJSON lines', () => {
    const repo = new TransactionRepository(db);
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);

    repo.insertWithDualWrite(makeTx('dry-tx-a', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);
    repo.insertWithDualWrite(makeTx('dry-tx-b', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);
    repo.insertWithDualWrite(makeTx('dry-tx-c', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const ids = lines.map(l => JSON.parse(l).would_insert.tx_id);
    expect(ids).toEqual(['dry-tx-a', 'dry-tx-b', 'dry-tx-c']);
  });

  it('issues exactly one INSERT per call (no duplicate row)', () => {
    const repo = new TransactionRepository(db);
    const logger = new DualWriteLogger(path.join(tmpDir, 'primary.ndjson'), tmpDir);

    repo.insertWithDualWrite(makeTx('dry-tx-unique', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions WHERE tx_id = ?').get('dry-tx-unique') as { c: number }).c;
    expect(count).toBe(1);
  });

  it('no-op when shadowLogger is undefined (degrades safely)', () => {
    const repo = new TransactionRepository(db);

    expect(() => repo.insertWithDualWrite(makeTx('dry-tx-nolog', sender, receiver), ENRICHMENT, 'dry_run', 'crawler')).not.toThrow();

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions WHERE tx_id = ?').get('dry-tx-nolog') as { c: number }).c;
    expect(count).toBe(1);
  });

  it('propagates optional trace_id when provided by caller', () => {
    const repo = new TransactionRepository(db);
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);

    repo.insertWithDualWrite(makeTx('dry-tx-trace', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger, 'trace-abc-123');

    const row = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    expect(row.trace_id).toBe('trace-abc-123');
  });

  it('logger falls back to cwd/logs when primary path is not writable', () => {
    // Unwritable primary: nonexistent root directory under /__no_such_root
    // that we cannot mkdir (EACCES on POSIX).
    const unwritablePrimary = '/__no_such_root__/satrank/dual-write.ndjson';
    const logger = new DualWriteLogger(unwritablePrimary, tmpDir);

    expect(logger.enabled).toBe(true);
    expect(logger.fallbackActive).toBe(true);
    expect(logger.effectivePath).toBe(path.join(tmpDir, 'logs', 'dual-write-dryrun.ndjson'));
    expect(fs.existsSync(logger.effectivePath!)).toBe(true);
  });

  it('writes to fallback path when primary fails', () => {
    const unwritablePrimary = '/__no_such_root__/satrank/dual-write.ndjson';
    const logger = new DualWriteLogger(unwritablePrimary, tmpDir);
    const repo = new TransactionRepository(db);

    repo.insertWithDualWrite(makeTx('dry-tx-fb', sender, receiver), ENRICHMENT, 'dry_run', 'crawler', logger);

    const content = fs.readFileSync(logger.effectivePath!, 'utf8').trim();
    expect(content.split('\n').length).toBe(1);
    expect(JSON.parse(content).would_insert.tx_id).toBe('dry-tx-fb');
  });

  it('disables logging when both primary and fallback are unwritable', () => {
    const unwritablePrimary = '/__no_such_root__/a/b.ndjson';
    // Point cwd at the same unreachable root so fallback also fails.
    const unwritableCwd = '/__no_such_root__/cwd';
    const logger = new DualWriteLogger(unwritablePrimary, unwritableCwd);

    expect(logger.enabled).toBe(false);
    expect(logger.effectivePath).toBeNull();
    // emit() must not throw even when disabled.
    expect(() => logger.emit({
      emitted_at: Math.floor(Date.now() / 1000),
      source_module: 'crawler',
      would_insert: { ...makeTx('x', sender, receiver), ...ENRICHMENT },
      legacy_inserted: true,
    })).not.toThrow();
  });
});
