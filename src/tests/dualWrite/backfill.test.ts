// Commit 8 — Phase 1 backfill script test harness. Covers the §5 design
// contract for `scripts/backfillTransactionsV31.ts`:
//
//   1. Enriches tx rows via service_probes.payment_hash → transactions.payment_hash
//      (endpoint_hash derived from canonical URL, operator_id = agent_hash,
//      source='probe', window_bucket = UTC date of probed_at).
//   2. Enriches tx rows via attestations.tx_id → transactions.tx_id
//      (operator_id = subject_hash, source='report', window_bucket = UTC date
//      of transactions.timestamp). endpoint_hash stays NULL.
//   3. Dry-run never mutates the DB.
//   4. Second run is a no-op on already-enriched rows (idempotence guard
//      `WHERE endpoint_hash IS NULL`).
//   5. Checkpoint advances monotonically across chunks; a checkpoint file
//      persisted between runs skips already-scanned source rowids.
//   6. Malformed URL in service_probes history is skipped (endpoint_hash
//      stays NULL) without crashing the pass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../database/migrations';
import { AgentRepository } from '../../repositories/agentRepository';
import { sha256 } from '../../utils/crypto';
import { endpointHash } from '../../utils/urlCanonical';
import {
  runBackfill,
  runBackfillChunk,
  loadCheckpoint,
  saveCheckpoint,
} from '../../scripts/backfillTransactionsV31';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Agent } from '../../types';

const FIXED_UNIX = Math.floor(new Date('2026-04-18T12:00:00Z').getTime() / 1000);
const EXPECTED_BUCKET = '2026-04-18';

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

/** Raw INSERT — the backfill runs on historical rows that pre-date the
 *  dual-write wiring, so endpoint_hash/operator_id/source/window_bucket are
 *  left NULL on purpose. Using the repository's insertWithDualWrite('off')
 *  would do the same thing but adds a dependency we don't need here. */
function seedLegacyTx(
  db: Database.Database,
  params: { tx_id: string; sender: string; receiver: string; payment_hash: string; timestamp?: number; protocol?: 'l402' | 'keysend' | 'bolt11' },
): void {
  db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
    VALUES (?, ?, ?, 'micro', ?, ?, NULL, 'verified', ?)
  `).run(
    params.tx_id, params.sender, params.receiver,
    params.timestamp ?? FIXED_UNIX, params.payment_hash, params.protocol ?? 'bolt11',
  );
}

function seedServiceProbe(
  db: Database.Database,
  params: { url: string; agent_hash: string | null; probed_at?: number; payment_hash: string | null; paid_sats?: number },
): number {
  const info = db.prepare(`
    INSERT INTO service_probes (url, agent_hash, probed_at, paid_sats, payment_hash, http_status, body_valid)
    VALUES (?, ?, ?, ?, ?, 200, 1)
  `).run(
    params.url, params.agent_hash, params.probed_at ?? FIXED_UNIX, params.paid_sats ?? 100,
    params.payment_hash,
  );
  return Number(info.lastInsertRowid);
}

function seedAttestation(
  db: Database.Database,
  params: { attestation_id: string; tx_id: string; attester: string; subject: string; timestamp?: number },
): void {
  db.prepare(`
    INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp, category, verified, weight)
    VALUES (?, ?, ?, ?, 85, NULL, NULL, ?, 'successful_transaction', 0, 1.0)
  `).run(
    params.attestation_id, params.tx_id, params.attester, params.subject,
    params.timestamp ?? FIXED_UNIX,
  );
}

function readTx(db: Database.Database, tx_id: string): Record<string, unknown> {
  return db.prepare(
    'SELECT tx_id, endpoint_hash, operator_id, source, window_bucket FROM transactions WHERE tx_id = ?',
  ).get(tx_id) as Record<string, unknown>;
}

describe('backfillTransactionsV31', () => {
  let db: Database.Database;
  let tmpDir: string;
  let checkpointPath: string;
  const senderHash = sha256('sender');
  const receiverHash = sha256('receiver');
  const operatorHash = sha256('02operator');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const agentRepo = new AgentRepository(db);
    agentRepo.insert(makeAgent('sender', senderHash));
    agentRepo.insert(makeAgent('receiver', receiverHash));
    agentRepo.insert(makeAgent('operator', operatorHash));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-v31-'));
    checkpointPath = path.join(tmpDir, 'ckpt.json');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enriches tx rows via service_probes (endpoint_hash, operator_id, source=probe, window_bucket)', () => {
    const url = 'https://svc.example.com/api/endpoint';
    const ph = 'ph-probe-1';
    seedServiceProbe(db, { url, agent_hash: operatorHash, payment_hash: ph });
    seedLegacyTx(db, { tx_id: 'tx-probe-1', sender: senderHash, receiver: receiverHash, payment_hash: ph });

    const res = runBackfill({ db, checkpointPath });

    expect(res.service_probes.scanned).toBe(1);
    expect(res.service_probes.updated).toBe(1);
    const row = readTx(db, 'tx-probe-1');
    expect(row.endpoint_hash).toBe(endpointHash(url));
    expect(row.operator_id).toBe(operatorHash);
    expect(row.source).toBe('probe');
    expect(row.window_bucket).toBe(EXPECTED_BUCKET);
  });

  it('enriches tx rows via attestations (operator_id, source=report, window_bucket); endpoint_hash stays NULL', () => {
    seedLegacyTx(db, { tx_id: 'tx-report-1', sender: senderHash, receiver: receiverHash, payment_hash: 'ph-r-1' });
    seedAttestation(db, { attestation_id: 'att-1', tx_id: 'tx-report-1', attester: senderHash, subject: receiverHash });

    const res = runBackfill({ db, checkpointPath });

    expect(res.attestations.scanned).toBe(1);
    expect(res.attestations.updated).toBe(1);
    const row = readTx(db, 'tx-report-1');
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBe(receiverHash);
    expect(row.source).toBe('report');
    expect(row.window_bucket).toBe(EXPECTED_BUCKET);
  });

  it('dry-run reports would-update counts but never mutates the DB', () => {
    const url = 'https://svc.example.com/x';
    const ph = 'ph-dry-1';
    seedServiceProbe(db, { url, agent_hash: operatorHash, payment_hash: ph });
    seedLegacyTx(db, { tx_id: 'tx-dry-1', sender: senderHash, receiver: receiverHash, payment_hash: ph });
    seedLegacyTx(db, { tx_id: 'tx-dry-2', sender: senderHash, receiver: receiverHash, payment_hash: 'ph-dry-att' });
    seedAttestation(db, { attestation_id: 'att-dry', tx_id: 'tx-dry-2', attester: senderHash, subject: receiverHash });

    const res = runBackfill({ db, dryRun: true, checkpointPath });

    expect(res.service_probes.updated).toBe(1);
    expect(res.attestations.updated).toBe(1);
    const rowProbe = readTx(db, 'tx-dry-1');
    const rowReport = readTx(db, 'tx-dry-2');
    expect(rowProbe.endpoint_hash).toBeNull();
    expect(rowProbe.source).toBeNull();
    expect(rowReport.operator_id).toBeNull();
    expect(rowReport.source).toBeNull();
    // Checkpoint file must NOT be written in dry-run mode.
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('second run is a no-op on already-enriched rows (WHERE endpoint_hash IS NULL guard)', () => {
    const url = 'https://svc.example.com/idem';
    const ph = 'ph-idem-1';
    seedServiceProbe(db, { url, agent_hash: operatorHash, payment_hash: ph });
    seedLegacyTx(db, { tx_id: 'tx-idem-1', sender: senderHash, receiver: receiverHash, payment_hash: ph });

    const first = runBackfill({ db, checkpointPath });
    expect(first.service_probes.updated).toBe(1);

    // Rewind the checkpoint so the probe row is scanned again; the guard
    // must still prevent a second write.
    saveCheckpoint(checkpointPath, { service_probes_last_id: 0, attestations_last_id: 0 });
    const second = runBackfill({ db, checkpointPath });
    expect(second.service_probes.scanned).toBe(1);
    expect(second.service_probes.updated).toBe(0);

    const row = readTx(db, 'tx-idem-1');
    expect(row.endpoint_hash).toBe(endpointHash(url));
    expect(row.source).toBe('probe');
  });

  it('checkpoint advances past scanned rowids; fresh run from saved checkpoint skips seen rows', () => {
    const probeId1 = seedServiceProbe(db, { url: 'https://a.example.com/1', agent_hash: operatorHash, payment_hash: 'ph-a-1' });
    const probeId2 = seedServiceProbe(db, { url: 'https://b.example.com/2', agent_hash: operatorHash, payment_hash: 'ph-b-2' });
    seedLegacyTx(db, { tx_id: 'tx-a-1', sender: senderHash, receiver: receiverHash, payment_hash: 'ph-a-1' });
    seedLegacyTx(db, { tx_id: 'tx-b-2', sender: senderHash, receiver: receiverHash, payment_hash: 'ph-b-2' });

    const first = runBackfill({ db, checkpointPath });
    expect(first.service_probes.scanned).toBe(2);
    expect(first.checkpoint.service_probes_last_id).toBe(probeId2);

    // Reload checkpoint — the second runBackfill with the same file should
    // scan nothing because no new probes were added.
    const reloaded = loadCheckpoint(checkpointPath);
    expect(reloaded.service_probes_last_id).toBe(probeId2);

    const second = runBackfill({ db, checkpointPath });
    expect(second.service_probes.scanned).toBe(0);
    expect(second.service_probes.updated).toBe(0);
    // probeId1 is referenced for test clarity (first of two seeded rowids).
    expect(probeId1).toBeLessThan(probeId2);
  });

  it('malformed URL in service_probes is skipped: row counted, endpoint_hash stays NULL, checkpoint advances', () => {
    const badUrl = 'not a url';
    const ph = 'ph-bad-1';
    seedServiceProbe(db, { url: badUrl, agent_hash: operatorHash, payment_hash: ph });
    seedLegacyTx(db, { tx_id: 'tx-bad-1', sender: senderHash, receiver: receiverHash, payment_hash: ph });

    const res = runBackfill({ db, checkpointPath });

    expect(res.service_probes.scanned).toBe(1);
    // The UPDATE still fires with endpoint_hash=NULL; the row gets
    // operator_id + source + window_bucket. A later run with a clean URL
    // source could fill endpoint_hash since the guard is endpoint_hash IS NULL.
    expect(res.service_probes.updated).toBe(1);
    const row = readTx(db, 'tx-bad-1');
    expect(row.endpoint_hash).toBeNull();
    expect(row.operator_id).toBe(operatorHash);
    expect(row.source).toBe('probe');
    expect(res.checkpoint.service_probes_last_id).toBeGreaterThan(0);
  });

  it('chunked pass: service_probes scan stops at chunkSize and resumes on the next call', () => {
    // Seed 5 probes, chunk size 2 → requires 3 chunks to drain.
    const rowids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ph = `ph-chunk-${i}`;
      rowids.push(seedServiceProbe(db, { url: `https://c.example.com/${i}`, agent_hash: operatorHash, payment_hash: ph }));
      seedLegacyTx(db, { tx_id: `tx-chunk-${i}`, sender: senderHash, receiver: receiverHash, payment_hash: ph });
    }

    const c1 = runBackfillChunk({ db, checkpointPath, chunkSize: 2 });
    expect(c1.service_probes.scanned).toBe(2);
    expect(c1.checkpoint.service_probes_last_id).toBe(rowids[1]);

    const c2 = runBackfillChunk({ db, checkpointPath, chunkSize: 2 });
    expect(c2.service_probes.scanned).toBe(2);
    expect(c2.checkpoint.service_probes_last_id).toBe(rowids[3]);

    const c3 = runBackfillChunk({ db, checkpointPath, chunkSize: 2 });
    expect(c3.service_probes.scanned).toBe(1);
    expect(c3.checkpoint.service_probes_last_id).toBe(rowids[4]);

    const c4 = runBackfillChunk({ db, checkpointPath, chunkSize: 2 });
    expect(c4.service_probes.scanned).toBe(0);

    for (let i = 0; i < 5; i++) {
      const row = readTx(db, `tx-chunk-${i}`);
      expect(row.source).toBe('probe');
    }
  });

  it('saveCheckpoint / loadCheckpoint round-trip; missing file → zeroed checkpoint', () => {
    const missing = path.join(tmpDir, 'missing.json');
    const empty = loadCheckpoint(missing);
    expect(empty).toEqual({ service_probes_last_id: 0, attestations_last_id: 0 });

    saveCheckpoint(missing, { service_probes_last_id: 42, attestations_last_id: 7 });
    const loaded = loadCheckpoint(missing);
    expect(loaded).toEqual({ service_probes_last_id: 42, attestations_last_id: 7 });

    // Corrupt the file — loader must degrade to zero rather than crash.
    fs.writeFileSync(missing, '{"service_probes_last_id": "not-a-number"');
    const fallback = loadCheckpoint(missing);
    expect(fallback).toEqual({ service_probes_last_id: 0, attestations_last_id: 0 });
  });

  it('service_probes rows with NULL payment_hash are excluded at the SELECT level', () => {
    seedServiceProbe(db, { url: 'https://no-ph.example.com/x', agent_hash: operatorHash, payment_hash: null });
    // No matching tx — but the absence of a payment_hash must already
    // prevent the probe from being scanned at all.
    const res = runBackfill({ db, checkpointPath });
    expect(res.service_probes.scanned).toBe(0);
  });
});
