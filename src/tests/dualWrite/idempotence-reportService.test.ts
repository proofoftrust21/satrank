// End-to-end verification that ReportService is idempotent under all three
// shadow-mode settings. The invariant we protect: re-submitting an identical
// report (same reporter/target/paymentHash) must NEVER produce a second
// `transactions` row nor a second NDJSON line — regardless of mode. Two
// distinct dedup layers cover this:
//   1. `await txRepo.findById(txId)` — skips the tx insert when the id already
//      exists (matters when report carries a paymentHash and the same
//      preimage is re-submitted after the 1h attestation dedup window has
//      elapsed). tx_id formula: `${paymentHash}:${reporter}` (H2).
//   2. DuplicateReportError — blocks a second submission within 1h regardless
//      of paymentHash (covers the no-preimage case where every tx_id is a
//      fresh uuid; without this the attestation would reinsert).
//
// mode=off must preserve pre-v31 behavior (legacy 9-col INSERT still fires —
// reportService is an *existing* writer for `transactions`, unlike probes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { AttestationRepository } from '../../repositories/attestationRepository';
import { SnapshotRepository } from '../../repositories/snapshotRepository';
import { ScoringService } from '../../services/scoringService';
import { ReportService } from '../../services/reportService';
import { DualWriteLogger } from '../../utils/dualWriteLogger';
import { sha256 } from '../../utils/crypto';
import { DuplicateReportError } from '../../errors';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Agent, ReportRequest } from '../../types';
let testDb: TestDb;

// 2026-04-18T12:00:00Z → window_bucket must be '2026-04-18-12' (6h bucket,
// HH ∈ {00,06,12,18}) regardless of the host TZ (ISO slice is UTC-anchored).
const FIXED_ISO = '2026-04-18T12:00:00Z';
const FIXED_UNIX = Math.floor(new Date(FIXED_ISO).getTime() / 1000);
const EXPECTED_BUCKET = '2026-04-18-12';

// Fixed preimage/paymentHash pair so tx_id = `${paymentHash}:${reporter}` is
// deterministic across the two submit() calls — that's what drives the
// findById dedup path. sha256 over the *bytes* of the preimage, matching
// ReportService's verify step.
const PREIMAGE = 'a'.repeat(64);
const REAL_PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

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
    avg_score: 50, // non-zero so reporter weight is non-trivial
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

describe('ReportService idempotence × dual-write modes', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let scoringService: ScoringService;
  let tmpDir: string;
  const reporterHash = sha256('reporter-pubkey');
  const targetHash = sha256('target-pubkey');

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);

    await agentRepo.insert(makeAgent('reporter', reporterHash));
    await agentRepo.insert(makeAgent('target', targetHash));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_ISO));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-report-'));
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeReport(overrides: Partial<ReportRequest> = {}): ReportRequest {
    return {
      target: targetHash,
      reporter: reporterHash,
      outcome: 'success',
      paymentHash: REAL_PAYMENT_HASH,
      preimage: PREIMAGE,
      ...overrides,
    };
  }

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=off — legacy INSERT still fires, no v31 enrichment', async () => {
    const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db, 'off');
    await reportService.submit(makeReport());

    const rows = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket, status FROM transactions',
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBeNull();
    expect(rows[0].operator_id).toBeNull();
    expect(rows[0].source).toBeNull();
    expect(rows[0].window_bucket).toBeNull();
    expect(rows[0].status).toBe('verified');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=dry_run — 2× submit same paymentHash ⇒ 1 legacy row, v31 NULL, exactly 1 NDJSON line', async () => {
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const dualLogger = new DualWriteLogger(logPath, tmpDir);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'dry_run', dualLogger,
    );

    await reportService.submit(makeReport());
    // Advance past the 1h attestation dedup window so the second submit
    // reaches the tx-insert path again (where findById must short-circuit
    // and therefore skip the NDJSON emit). The attestation insert that
    // follows will still hit UNIQUE(tx_id, attester_hash) — that's fine;
    // we only care that the DB + NDJSON stayed at 1 row each.
    vi.setSystemTime(new Date(FIXED_UNIX * 1000 + 3601 * 1000));
    try {
      await reportService.submit(makeReport());
    } catch {
      // Either DuplicateReportError or a SqliteError UNIQUE bubbles — both
      // outcomes prove the dedup cascade worked. The invariants we assert
      // below are what actually matter.
    }

    const rows = db.prepare('SELECT * FROM transactions').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBeNull();
    expect(rows[0].operator_id).toBeNull();
    expect(rows[0].source).toBeNull();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]);
    expect(row.source_module).toBe('reportService');
    expect(row.legacy_inserted).toBe(true);
    expect(typeof row.emitted_at).toBe('number');
    expect(row.would_insert.source).toBe('report');
    expect(row.would_insert.endpoint_hash).toBe(targetHash);
    expect(row.would_insert.operator_id).toBe(targetHash);
    expect(row.would_insert.window_bucket).toBe(EXPECTED_BUCKET);
    expect(row.would_insert.status).toBe('verified');
    expect(row.would_insert.protocol).toBe('bolt11');
    expect(row.would_insert.sender_hash).toBe(reporterHash);
    expect(row.would_insert.receiver_hash).toBe(targetHash);
    expect(row.would_insert.timestamp).toBe(FIXED_UNIX);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('mode=active — 1× submit ⇒ row with v31 enrichment populated', async () => {
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    await reportService.submit(makeReport());

    const rows = db.prepare(
      'SELECT endpoint_hash, operator_id, source, window_bucket, status FROM transactions',
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_hash).toBe(targetHash);
    expect(rows[0].operator_id).toBe(targetHash);
    expect(rows[0].source).toBe('report');
    expect(rows[0].window_bucket).toBe(EXPECTED_BUCKET);
    expect(rows[0].status).toBe('verified');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('DuplicateReportError short-circuits before a second tx-emit (same-hour)', async () => {
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    await reportService.submit(makeReport());
    expect(() => reportService.submit(makeReport())).toThrow(DuplicateReportError);

    const count = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(1);
    const aCount = (db.prepare('SELECT COUNT(*) as c FROM attestations').get() as { c: number }).c;
    expect(aCount).toBe(1);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('failed outcome yields status=failed on the dual-write tx', async () => {
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    await reportService.submit(makeReport({ outcome: 'failure' }));

    const row = db.prepare('SELECT status, source FROM transactions').get() as { status: string; source: string };
    expect(row.source).toBe('report');
    expect(row.status).toBe('failed');
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('late-evening UTC timestamp still buckets on the same UTC day', async () => {
    vi.setSystemTime(new Date('2026-04-18T23:59:59Z'));
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    await reportService.submit(makeReport());

    const row = db.prepare('SELECT window_bucket FROM transactions').get() as { window_bucket: string };
    expect(row.window_bucket).toBe('2026-04-18-18');
  });
});
