// @ts-nocheck — archived 2026-04-22 in Phase 12C (SQLite-era better-sqlite3 API, not ported to pg). See docs/phase-12c/TS-ERRORS-AUDIT.md.
// End-to-end verification that the service-probes crawler is idempotent
// under all three shadow-mode settings. The invariant we protect: re-probing
// the same URL on the same UTC day (typical on cron overlap or an ad-hoc
// manual run) must NEVER produce a second DB row nor a second NDJSON line.
//
// Daily granularity comes from the tx_id formula:
//   tx_id = sha256("probe:" + canonicalize(url) + ":" + window_bucket)
// — so the dedup check (findById) fires on the second probe of the day.
//
// `mode=off` is asserted to be a strict no-op on `transactions` because probes
// are a *new* writer for that table; introducing legacy rows in off mode
// would silently change pre-v31 behavior (see docs/PHASE-1-DESIGN.md §2).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { ServiceEndpointRepository } from '../../repositories/serviceEndpointRepository';
import { ServiceHealthCrawler } from '../../crawler/serviceHealthCrawler';
import { DualWriteLogger } from '../../utils/dualWriteLogger';
import { sha256 } from '../../utils/crypto';
import { endpointHash } from '../../utils/urlCanonical';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Agent } from '../../types';
let testDb: TestDb;

// Stub the SSRF pre-flight: the crawler now resolves DNS + rejects private
// IPs before fetching, but this test uses `api.example.com` (no A record) as
// a stable synthetic hostname. Return a bogus-but-public IP so the guard
// passes and the mocked fetch gets to run. Real SSRF behavior is covered in
// src/tests/ssrf.test.ts.
vi.mock('../../utils/ssrf', async () => {
  const actual = await vi.importActual<typeof import('../../utils/ssrf')>('../../utils/ssrf');
  return { ...actual, resolveAndPin: async () => '203.0.113.1' };
});

// 2026-04-18T12:00:00Z → window_bucket must be '2026-04-18-12' (6h bucket,
// HH ∈ {00,06,12,18}) regardless of the host TZ (ISO slice is UTC-anchored).
const FIXED_ISO = '2026-04-18T12:00:00Z';
const FIXED_UNIX = Math.floor(new Date(FIXED_ISO).getTime() / 1000);
const EXPECTED_BUCKET = '2026-04-18-12';

const PROBE_URL = 'https://api.example.com/svc';

function makeAgent(alias: string, hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias,
    first_seen: FIXED_UNIX - 90 * 86400,
    last_seen: FIXED_UNIX - 86400,
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

/** Makes `findStale` return the seeded endpoint on the next crawler.run() by
 *  rewinding last_checked_at past the 30-minute window. We need this between
 *  the two runs in an idempotence assertion — the crawler's own upsert
 *  refreshes last_checked_at=now on the first pass. */
function makeStale(db: Pool, url: string): void {
  db.prepare('UPDATE service_endpoints SET last_checked_at = ? WHERE url = ?').run(FIXED_UNIX - 3600, url);
}

describe('ServiceHealthCrawler idempotence × dual-write modes', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let endpointRepo: ServiceEndpointRepository;
  let tmpDir: string;
  const opHash = sha256('op-pubkey-1');

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    endpointRepo = new ServiceEndpointRepository(db);

    await agentRepo.insert(makeAgent('probe-op', opHash));

    // Three upserts bring check_count to 3, satisfying findStale's threshold.
    await endpointRepo.upsert(opHash, PROBE_URL, 200, 10, 'self_registered');
    await endpointRepo.upsert(opHash, PROBE_URL, 200, 10, 'self_registered');
    await endpointRepo.upsert(opHash, PROBE_URL, 200, 10, 'self_registered');
    makeStale(db, PROBE_URL);

    // Only mock Date — setTimeout must remain real because the crawler
    // spaces its inter-probe waits via setTimeout(200ms), which would hang
    // indefinitely under full fake-timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_ISO));
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-probe-'));
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=off — probe writer is a strict no-op on transactions', async () => {
    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'off');

    await crawler.run();
    makeStale(db, PROBE_URL);
    await crawler.run();

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=dry_run — 2× probe ⇒ 1 legacy row, v31 NULL in DB, exactly 1 NDJSON line', async () => {
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const logger = new DualWriteLogger(logPath, tmpDir);
    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'dry_run', logger);

    await crawler.run();
    makeStale(db, PROBE_URL);
    await crawler.run();

    const txRows = db.prepare('SELECT * FROM transactions').all() as Array<Record<string, unknown>>;
    expect(txRows).toHaveLength(1);
    expect(txRows[0].endpoint_hash).toBeNull();
    expect(txRows[0].operator_id).toBeNull();
    expect(txRows[0].source).toBeNull();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]);
    expect(row.source_module).toBe('serviceProbes');
    expect(row.legacy_inserted).toBe(true);
    expect(typeof row.emitted_at).toBe('number');
    expect(row.would_insert.source).toBe('probe');
    expect(row.would_insert.endpoint_hash).toBe(endpointHash(PROBE_URL));
    expect(row.would_insert.operator_id).toBe(opHash);
    expect(row.would_insert.window_bucket).toBe(EXPECTED_BUCKET);
    expect(row.would_insert.status).toBe('verified');
    expect(row.would_insert.protocol).toBe('l402');
    expect(row.would_insert.amount_bucket).toBe('micro');
    expect(row.would_insert.timestamp).toBe(FIXED_UNIX);
    expect(row.would_insert.sender_hash).toBe(opHash);
    expect(row.would_insert.receiver_hash).toBe(opHash);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=active — 2× probe ⇒ 1 row with v31 enrichment populated', async () => {
    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active');

    await crawler.run();
    makeStale(db, PROBE_URL);
    await crawler.run();

    const rows = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket, status FROM transactions',
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBe(endpointHash(PROBE_URL));
    expect(rows[0].operator_id).toBe(opHash);
    expect(rows[0].source).toBe('probe');
    expect(rows[0].window_bucket).toBe(EXPECTED_BUCKET);
    expect(rows[0].status).toBe('verified');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('skips dual-write when endpoint.agent_hash is NULL (FK safety)', async () => {
    const anonUrl = 'https://anon.example/svc';
    await endpointRepo.upsert(null, anonUrl, 200, 10, 'ad_hoc');
    await endpointRepo.upsert(null, anonUrl, 200, 10, 'ad_hoc');
    await endpointRepo.upsert(null, anonUrl, 200, 10, 'ad_hoc');
    makeStale(db, anonUrl);

    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active');
    await crawler.run();

    // Only the opHash-owned endpoint writes a tx; the null-agent endpoint is skipped.
    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(1);
    const row = db.prepare('SELECT sender_hash FROM transactions').get() as { sender_hash: string };
    expect(row.sender_hash).toBe(opHash);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('skips dual-write when endpoint.agent_hash points to a purged agent', async () => {
    // Simulate a stale-sweep that removed the operator row after the endpoint
    // was registered. endpoint.agent_hash is non-null but the referenced agent
    // no longer exists, so a naive INSERT would throw FOREIGN KEY constraint
    // failed. The crawler must skip silently and keep probing other endpoints.
    const purgedHash = sha256('purged-op');
    const purgedUrl = 'https://purged.example/svc';
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    makeStale(db, purgedUrl);
    // opHash endpoint stays valid — assert the crawler doesn't abort the loop.
    makeStale(db, PROBE_URL);

    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active', undefined, agentRepo);
    const res = await crawler.run();

    // Both endpoints probed HTTP-wise (check_count incremented on each),
    // only the live-agent one wrote a tx row.
    expect(res.checked).toBe(2);
    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(1);
    const row = db.prepare('SELECT sender_hash FROM transactions').get() as { sender_hash: string };
    expect(row.sender_hash).toBe(opHash);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('falls back to legacy FK throw when agentRepo is not injected (back-compat)', async () => {
    // When agentRepo is undefined, the crawler retains pre-fix behavior:
    // the INSERT throws inside the try/catch and no tx row is written.
    // Guards against accidental signature breakage in consumers that don't
    // wire the new dep (e.g. ad-hoc scripts, older tests).
    const purgedHash = sha256('purged-op-2');
    const purgedUrl = 'https://purged2.example/svc';
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    await endpointRepo.upsert(purgedHash, purgedUrl, 200, 10, 'self_registered');
    makeStale(db, purgedUrl);

    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active');
    await crawler.run();

    // Only the opHash endpoint writes; the purged-agent INSERT throws and is
    // swallowed by dualWriteProbeTx's catch, leaving no row.
    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('failed probe yields status=failed on the dual-write tx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500 })));
    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active');

    await crawler.run();

    const row = db.prepare('SELECT status, source FROM transactions').get() as { status: string; source: string };
    expect(row.source).toBe('probe');
    expect(row.status).toBe('failed');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('late-evening UTC timestamp still buckets on the same UTC day', async () => {
    vi.setSystemTime(new Date('2026-04-18T23:59:59Z'));
    const crawler = new ServiceHealthCrawler(endpointRepo, txRepo, 'active');

    await crawler.run();

    const row = db.prepare('SELECT window_bucket FROM transactions').get() as { window_bucket: string };
    expect(row.window_bucket).toBe('2026-04-18-18');
  });
});