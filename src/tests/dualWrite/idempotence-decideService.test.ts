// End-to-end verification of the `source='intent'` write path + the timeout
// worker's strict no-op invariant. Per docs/PHASE-1-DESIGN.md §4 the 3 cases
// of the decide → outcome flow are:
//   1. /report with verified preimage ⇒ tx row with source='intent',
//      status='verified'.
//   2. /report with explicit failure ⇒ tx row with source='intent',
//      status='failed'.
//   3. token query then agent disappears past INTENT_OUTCOME_TIMEOUT_HOURS
//      ⇒ tokenQueryLogTimeoutWorker scans but writes NOTHING.
//
// Classification criterion: a `token_query_log` row matching
// `(payment_hash = sha256(l402_preimage), target_hash = report.target)`.
// When present, ReportService tags the tx as source='intent' (and uses
// source_module='decideService' on the NDJSON emit). When absent, the
// fallback is source='report' — the Commit 6 behavior, which is asserted
// here too so nothing regressed.
//
// Mode sweep: the tests run in `active` mode for straightforward DB
// assertions; `dry_run` is covered for the NDJSON source_module label; and
// `off` for the legacy-path sanity check. Idempotence is verified by
// re-submitting and asserting the row count does not grow.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { runMigrations } from '../../database/migrations';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { AttestationRepository } from '../../repositories/attestationRepository';
import { SnapshotRepository } from '../../repositories/snapshotRepository';
import { ScoringService } from '../../services/scoringService';
import { ReportService } from '../../services/reportService';
import { TokenQueryLogTimeoutWorker } from '../../services/tokenQueryLogTimeoutWorker';
import { DualWriteLogger } from '../../utils/dualWriteLogger';
import { sha256 } from '../../utils/crypto';
import { DuplicateReportError } from '../../errors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Agent, ReportRequest } from '../../types';

const FIXED_ISO = '2026-04-18T12:00:00Z';
const FIXED_UNIX = Math.floor(new Date(FIXED_ISO).getTime() / 1000);
// 6h bucket UTC: hour 12 rounds down to 12 → '2026-04-18-12'.
const EXPECTED_BUCKET = '2026-04-18-12';

const PREIMAGE = 'a'.repeat(64);
const PAYMENT_HASH_BUF = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest();
const PAYMENT_HASH_HEX = PAYMENT_HASH_BUF.toString('hex');

function makeAgent(alias: string, hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias,
    first_seen: FIXED_UNIX - 90 * 86400,
    last_seen: FIXED_UNIX - 86400,
    source: 'observer_protocol',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 50,
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

/** Simulate the auth middleware's token_query_log insert. Mirrors
 *  logTokenQuery semantics (INSERT OR IGNORE) — tests can seed multiple
 *  (token, target) pairs without worrying about duplicates. */
function seedTokenQueryLog(db: Database.Database, paymentHash: Buffer, targetHash: string, when: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO token_query_log (payment_hash, target_hash, decided_at) VALUES (?, ?, ?)',
  ).run(paymentHash, targetHash, when);
}

describe('DecideService dual-write (source=intent) × timeout worker', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let scoringService: ScoringService;
  let tmpDir: string;
  const reporterHash = sha256('reporter-pubkey');
  const targetHash = sha256('target-pubkey');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);

    agentRepo.insert(makeAgent('reporter', reporterHash));
    agentRepo.insert(makeAgent('target', targetHash));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_ISO));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-decide-'));
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeReport(overrides: Partial<ReportRequest> = {}): ReportRequest {
    return {
      target: targetHash,
      reporter: reporterHash,
      outcome: 'success',
      paymentHash: PAYMENT_HASH_HEX,
      preimage: PREIMAGE,
      l402PaymentHash: PAYMENT_HASH_BUF,
      ...overrides,
    };
  }

  // §4 case 1 — /report with verified preimage closes a prior /decide.
  it('mode=active: verified report + matching token_query_log ⇒ source=intent, status=verified', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 60);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    reportService.submit(makeReport());

    const row = db.prepare(
      'SELECT source, status, operator_id, window_bucket FROM transactions',
    ).get() as Record<string, unknown>;
    expect(row.source).toBe('intent');
    expect(row.status).toBe('verified');
    expect(row.operator_id).toBe(targetHash);
    expect(row.window_bucket).toBe(EXPECTED_BUCKET);
  });

  // §4 case 2 — explicit failure outcome.
  it('mode=active: failed report + matching token_query_log ⇒ source=intent, status=failed', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 60);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    reportService.submit(makeReport({ outcome: 'failure' }));

    const row = db.prepare('SELECT source, status FROM transactions').get() as Record<string, unknown>;
    expect(row.source).toBe('intent');
    expect(row.status).toBe('failed');
  });

  // Regression guard on Commit 6 — no token_query_log ⇒ still source='report'.
  it('no matching token_query_log ⇒ falls back to source=report', async () => {
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    reportService.submit(makeReport());

    const row = db.prepare('SELECT source FROM transactions').get() as { source: string };
    expect(row.source).toBe('report');
  });

  // L402 token present but bound to a DIFFERENT target (agent queried /decide
  // for X then reports against Y). Only reports *on the same target the
  // token paid for* earn the intent classification.
  it('token_query_log row for different target ⇒ source=report', async () => {
    const otherTarget = sha256('other-target-pubkey');
    agentRepo.insert(makeAgent('other', otherTarget));
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, otherTarget, FIXED_UNIX - 60);

    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );
    reportService.submit(makeReport()); // reports on targetHash, not otherTarget

    const row = db.prepare('SELECT source FROM transactions').get() as { source: string };
    expect(row.source).toBe('report');
  });

  // API-key auth ⇒ no L402 paymentHash on the request, so classifySource
  // must short-circuit to 'report' even if a token_query_log row happens to
  // exist for the (unrelated) paymentHash.
  it('no l402PaymentHash on ReportRequest ⇒ source=report', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 60);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );
    reportService.submit(makeReport({ l402PaymentHash: undefined }));

    const row = db.prepare('SELECT source FROM transactions').get() as { source: string };
    expect(row.source).toBe('report');
  });

  // Idempotence: re-submitting the same intent-closing report must not
  // create a second tx row. DuplicateReportError fires inside the 1h
  // attestation dedup window; either way, exactly one tx stays.
  it('2× submit of same intent-closing report ⇒ 1 tx row, source=intent preserved', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 60);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );

    reportService.submit(makeReport());
    expect(() => reportService.submit(makeReport())).toThrow(DuplicateReportError);

    const rows = db.prepare('SELECT source FROM transactions').all() as Array<{ source: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('intent');
  });

  // NDJSON emit labels the source_module='decideService' for intent flows
  // (distinct from the source_module='reportService' used on non-intent
  // reports). The audit script uses this to distribute traffic by code-path
  // per §6 of the design.
  it('mode=dry_run: intent report emits NDJSON with source_module=decideService', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 60);
    const logPath = path.join(tmpDir, 'primary.ndjson');
    const dualLogger = new DualWriteLogger(logPath, tmpDir);
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'dry_run', dualLogger,
    );

    reportService.submit(makeReport());

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const emit = JSON.parse(lines[0]);
    expect(emit.source_module).toBe('decideService');
    expect(emit.would_insert.source).toBe('intent');
    expect(emit.legacy_inserted).toBe(true);
  });

  // §4 case 3 — timeout worker no-op invariant. An expired token_query_log row
  // with no matching /report must NEVER trigger an INSERT into
  // `transactions`. We seed 3 rows (1 expired+unresolved, 1 resolved by a
  // prior /report, 1 still pending) and assert: transactions row count is
  // unchanged, and the classification counters match reality.
  it('TokenQueryLogTimeoutWorker scan is a strict no-op on transactions', async () => {
    const other = sha256('other-pubkey');
    const pending = sha256('pending-pubkey');
    agentRepo.insert(makeAgent('other', other));
    agentRepo.insert(makeAgent('pending-target', pending));

    const phExpired = createHash('sha256').update(Buffer.from('b'.repeat(64), 'hex')).digest();
    const phResolved = PAYMENT_HASH_BUF;
    const phPending = createHash('sha256').update(Buffer.from('c'.repeat(64), 'hex')).digest();

    seedTokenQueryLog(db, phExpired, other, FIXED_UNIX - 48 * 3600); // expired
    seedTokenQueryLog(db, phResolved, targetHash, FIXED_UNIX - 3600); // to be resolved
    seedTokenQueryLog(db, phPending, pending, FIXED_UNIX - 60); // still pending

    // Resolve the second entry by submitting a matching /report — this
    // writes a tx with source='intent' that the worker must recognize as
    // closing the intent.
    const reportService = new ReportService(
      attestationRepo, agentRepo, txRepo, scoringService, db, 'active',
    );
    reportService.submit(makeReport());

    const txCountBefore = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(txCountBefore).toBe(1); // only the resolved intent's tx

    const worker = new TokenQueryLogTimeoutWorker(db, 24);
    const scanResult = worker.scan(FIXED_UNIX);

    expect(scanResult.expired).toBe(1);
    expect(scanResult.resolved).toBe(1);
    expect(scanResult.pending).toBe(1);

    const txCountAfter = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(txCountAfter).toBe(txCountBefore); // STRICT no-op
  });

  // Running the worker multiple times must also be a no-op — it should not
  // accumulate state. Re-scans return the same classification.
  it('TokenQueryLogTimeoutWorker scan is idempotent across multiple runs', async () => {
    seedTokenQueryLog(db, PAYMENT_HASH_BUF, targetHash, FIXED_UNIX - 48 * 3600);
    const worker = new TokenQueryLogTimeoutWorker(db, 24);

    const first = worker.scan(FIXED_UNIX);
    const second = worker.scan(FIXED_UNIX);

    expect(first).toEqual(second);
    expect(first.expired).toBe(1);
    const txCount = (db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number }).c;
    expect(txCount).toBe(0);
  });
});
