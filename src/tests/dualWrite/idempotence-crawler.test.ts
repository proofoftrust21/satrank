// End-to-end verification that the Observer crawler is idempotent under all
// three shadow-mode settings. The invariant we're protecting: re-running the
// crawler on the same Observer payload (typical when the API retries or a
// cron tick overlaps) must NEVER produce a second DB row nor a second
// NDJSON line. The crawler dedups at `findById()` BEFORE the insert, so the
// shadow emit also short-circuits — which is the behavior we assert in the
// dry_run case.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { Crawler } from '../../crawler/crawler';
import { DualWriteLogger } from '../../utils/dualWriteLogger';
import type { ObserverClient, ObserverHealthResponse, ObserverTransactionsResponse, ObserverEvent } from '../../crawler/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
let testDb: TestDb;

// 2026-04-18T12:00:00Z → window_bucket must be exactly '2026-04-18-12' (6h
// bucket UTC: hour 12 rounds down to 12) regardless of host TZ.
const FIXED_ISO = '2026-04-18T12:00:00Z';
const FIXED_UNIX = Math.floor(new Date(FIXED_ISO).getTime() / 1000);
const EXPECTED_BUCKET = '2026-04-18-12';

function makeEvent(overrides: Partial<ObserverEvent> = {}): ObserverEvent {
  return {
    event_id: 'evt-fixed',
    event_type: 'payment.executed',
    protocol: 'lightning',
    transaction_hash: 'tx-idem-1',
    time_window: EXPECTED_BUCKET,
    amount_bucket: 'small',
    amount_sats: 1000,
    direction: 'outbound',
    service_description: null,
    preimage: 'a'.repeat(64),
    counterparty_id: 'counterparty-bob',
    verified: true,
    created_at: FIXED_ISO,
    agent_alias: 'alice-agent',
    ...overrides,
  };
}

class MockObserverClient implements ObserverClient {
  response: ObserverTransactionsResponse = { transactions: [], events: [], total: 0 };

  async fetchHealth(): Promise<ObserverHealthResponse> {
    return { status: 'ok' };
  }

  async fetchTransactions(): Promise<ObserverTransactionsResponse> {
    return this.response;
  }
}

describe('Crawler idempotence × dual-write modes', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let mockClient: MockObserverClient;
  let tmpDir: string;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    mockClient = new MockObserverClient();
    mockClient.response = { transactions: [makeEvent()], events: [], total: 1 };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-crawler-'));
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=off — 2× same event ⇒ 1 row, v31 cols NULL, no NDJSON', async () => {
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);
    const crawler = new Crawler(mockClient, agentRepo, txRepo, 'off', logger);

    const r1 = await crawler.run();
    const r2 = await crawler.run();

    expect(r1.newTransactions).toBe(1);
    expect(r2.newTransactions).toBe(0);

    const rows = db.prepare('SELECT * FROM transactions WHERE tx_id = ?').all('tx-idem-1') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBeNull();
    expect(rows[0].source).toBeNull();

    expect(fs.readFileSync(logPath, 'utf8')).toBe('');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=dry_run — 2× same event ⇒ 1 row, v31 NULL in DB, exactly 1 NDJSON line', async () => {
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);
    const crawler = new Crawler(mockClient, agentRepo, txRepo, 'dry_run', logger);

    const r1 = await crawler.run();
    const r2 = await crawler.run();

    expect(r1.newTransactions).toBe(1);
    // Dedup at findById short-circuits BEFORE insertWithDualWrite — proves
    // the NDJSON emit is gated by dedup, not by mode dispatch.
    expect(r2.newTransactions).toBe(0);

    const rows = db.prepare('SELECT * FROM transactions WHERE tx_id = ?').all('tx-idem-1') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBeNull();
    expect(rows[0].source).toBeNull();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]);
    expect(row.source_module).toBe('crawler');
    expect(row.legacy_inserted).toBe(true);
    expect(typeof row.emitted_at).toBe('number');
    expect(row.would_insert.tx_id).toBe('tx-idem-1');
    expect(row.would_insert.endpoint_hash).toBeNull();
    expect(row.would_insert.operator_id).toBeNull();
    expect(row.would_insert.source).toBe('observer');
    expect(row.would_insert.window_bucket).toBe(EXPECTED_BUCKET);
    expect(row.would_insert.timestamp).toBe(FIXED_UNIX);
    expect(row.would_insert.status).toBe('verified');
    expect(row.would_insert.protocol).toBe('bolt11');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=active — 2× same event ⇒ 1 row with Observer enrichment populated', async () => {
    const crawler = new Crawler(mockClient, agentRepo, txRepo, 'active');

    const r1 = await crawler.run();
    const r2 = await crawler.run();

    expect(r1.newTransactions).toBe(1);
    expect(r2.newTransactions).toBe(0);

    const rows = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?'
    ).all('tx-idem-1') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBeNull();
    expect(rows[0].operator_id).toBeNull();
    expect(rows[0].source).toBe('observer');
    expect(rows[0].window_bucket).toBe(EXPECTED_BUCKET);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('window_bucket derived UTC — crawler on a late-evening UTC timestamp buckets correctly', async () => {
    // 2026-04-18T23:59:59Z → hour 23 → 6h bucket 18 → '2026-04-18-18' regardless of host TZ.
    const latenight = '2026-04-18T23:59:59Z';
    mockClient.response = {
      transactions: [makeEvent({ transaction_hash: 'tx-late', created_at: latenight })],
      events: [],
      total: 1,
    };
    const crawler = new Crawler(mockClient, agentRepo, txRepo, 'active');
    await crawler.run();

    const row = db.prepare('SELECT window_bucket FROM transactions WHERE tx_id = ?').get('tx-late') as Record<string, unknown>;
    expect(row.window_bucket).toBe('2026-04-18-18');
  });
});
