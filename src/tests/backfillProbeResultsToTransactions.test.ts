// C2 Phase 3 — backfill probe_results → transactions + streaming_posteriors.
//
// Ce qu'on prouve :
//   1. dry-run compte sans écrire (0 tx, 0 streaming delta)
//   2. run actif insère 1 tx par (target, UTC-day, 1k sats) + peuple streaming
//   3. idempotence : 2× run ne duplique pas
//   4. non-base amounts (10k/100k/1M) skippés
//   5. orphan target (agent disparu) skipped gracefully
//   6. limit stoppe proprement
//   7. checkpoint resume correctement
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { runBackfill, runBackfillChunk } from '../scripts/backfillProbeResultsToTransactions';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias: `a-${hash.slice(0, 6)}`,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
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

describe('backfillProbeResultsToTransactions', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-probe-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run counts without writing tx rows or streaming deltas', () => {
    const a = 'aa'.repeat(32);
    new AgentRepository(db).insert(makeAgent(a));
    new ProbeRepository(db).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    const r = runBackfill({ db, dryRun: true });
    expect(r.scanned).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.skippedDuplicate).toBe(0);

    const txCount = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as any).c;
    expect(txCount).toBe(0);
    const streamingCount = (db.prepare('SELECT COUNT(*) AS c FROM operator_streaming_posteriors').get() as any).c;
    expect(streamingCount).toBe(0);
  });

  it('active run inserts 1 tx per (target, day) and bumps streaming + buckets', () => {
    const a = 'bb'.repeat(32);
    const agentRepo = new AgentRepository(db);
    const probeRepo = new ProbeRepository(db);
    agentRepo.insert(makeAgent(a));
    // 3 probes on same day, 1 reachable, 2 unreachable — daily bucket wins
    probeRepo.insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });
    probeRepo.insert({
      target_hash: a, probed_at: NOW - 200, reachable: 0,
      latency_ms: null, hops: null, estimated_fee_msat: null,
      failure_reason: 'no_route', probe_amount_sats: 1000,
    });
    probeRepo.insert({
      target_hash: a, probed_at: NOW - 300, reachable: 0,
      latency_ms: null, hops: null, estimated_fee_msat: null,
      failure_reason: 'no_route', probe_amount_sats: 1000,
    });

    const r = runBackfill({ db });
    expect(r.scanned).toBe(3);
    expect(r.inserted).toBe(1);
    expect(r.skippedDuplicate).toBe(2); // same-day collisions

    const tx = db.prepare('SELECT endpoint_hash, operator_id, source, status FROM transactions').get() as any;
    expect(tx.endpoint_hash).toBe(a);
    expect(tx.operator_id).toBe(a);
    expect(tx.source).toBe('probe');
    // First row wins → reachable=1 → verified
    expect(tx.status).toBe('verified');

    const streaming = db.prepare(
      `SELECT source, total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(a) as any;
    expect(streaming.source).toBe('probe');
    expect(streaming.total_ingestions).toBe(1);
  });

  it('idempotent — 2× run does not duplicate tx or double-count streaming', () => {
    const a = 'cc'.repeat(32);
    new AgentRepository(db).insert(makeAgent(a));
    new ProbeRepository(db).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    runBackfill({ db });
    const r2 = runBackfill({ db });
    expect(r2.inserted).toBe(0);
    expect(r2.skippedDuplicate).toBeGreaterThanOrEqual(0);

    const txCount = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as any).c;
    expect(txCount).toBe(1);

    const streaming = db.prepare(
      `SELECT total_ingestions FROM operator_streaming_posteriors WHERE operator_id = ?`,
    ).get(a) as any;
    expect(streaming.total_ingestions).toBe(1);
  });

  it('skips non-base amount probes (10k/100k/1M tiers)', () => {
    const a = 'dd'.repeat(32);
    new AgentRepository(db).insert(makeAgent(a));
    new ProbeRepository(db).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 10_000,
    });
    new ProbeRepository(db).insert({
      target_hash: a, probed_at: NOW - 200, reachable: 1,
      latency_ms: 12, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 100_000,
    });

    const r = runBackfill({ db });
    expect(r.scanned).toBe(2);
    expect(r.skippedNonBase).toBe(2);
    expect(r.inserted).toBe(0);
  });

  it('skips rows whose target agent is missing (orphan — defensive)', () => {
    // Simulate a post-hoc orphan : insert the probe row directly with FK
    // disabled, then re-enable FK before running the backfill. This models
    // the real-world case where an old agent row was purged but the probe
    // history survived (no ON DELETE CASCADE on probe_results).
    const orphanHash = `ee${'ee'.repeat(31)}`;
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO probe_results (target_hash, probed_at, reachable, probe_amount_sats)
      VALUES (?, ?, 1, 1000)
    `).run(orphanHash, NOW - 100);
    db.pragma('foreign_keys = ON');

    const r = runBackfill({ db });
    expect(r.skippedOrphanTarget).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.errors).toBe(0);
  });

  it('--limit stops after N rows and checkpoint advances correctly', () => {
    const agentRepo = new AgentRepository(db);
    const probeRepo = new ProbeRepository(db);
    for (let i = 0; i < 5; i++) {
      const h = `${i.toString(16).padStart(2, '0')}${'ff'.repeat(31)}`;
      agentRepo.insert(makeAgent(h));
      probeRepo.insert({
        target_hash: h, probed_at: NOW - i * DAY - 100, reachable: 1,
        latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
        failure_reason: null, probe_amount_sats: 1000,
      });
    }

    const r = runBackfill({ db, limit: 3 });
    expect(r.scanned).toBe(3);
    expect(r.inserted).toBe(3);
    expect(r.checkpoint.probe_results_last_id).toBe(3);

    // Resume from checkpoint finishes the remaining 2
    const r2 = runBackfill({ db, checkpoint: r.checkpoint });
    expect(r2.scanned).toBe(2);
    expect(r2.inserted).toBe(2);
    expect(r2.checkpoint.probe_results_last_id).toBe(5);

    const total = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as any).c;
    expect(total).toBe(5);
  });

  it('checkpoint file persists across calls', () => {
    const a = '55'.repeat(32);
    new AgentRepository(db).insert(makeAgent(a));
    new ProbeRepository(db).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    const cpPath = path.join(tmpDir, 'cp.json');
    const r = runBackfillChunk({ db, checkpointPath: cpPath });
    expect(r.checkpoint.probe_results_last_id).toBe(1);
    expect(fs.existsSync(cpPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    expect(onDisk.probe_results_last_id).toBe(1);
  });
});
