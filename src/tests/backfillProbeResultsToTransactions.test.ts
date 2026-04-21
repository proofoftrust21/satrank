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
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentRepository } from '../repositories/agentRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { runBackfill, runBackfillChunk } from '../scripts/backfillProbeResultsToTransactions';
import type { Agent } from '../types';
let testDb: TestDb;

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

// TODO Phase 12C post-migration cleanup: backfill ETL was migration-era.
// Post-cut-over, probe_results and transactions share the same Postgres DB.
describe.skip('backfillProbeResultsToTransactions', async () => {
  let pool: Pool;
  let tmpDir: string;

  beforeEach(async () => {
    testDb = await setupTestPool();

    pool = testDb.pool;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-probe-'));
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run counts without writing tx rows or streaming deltas', async () => {
    const a = 'aa'.repeat(32);
    await new AgentRepository(pool).insert(makeAgent(a));
    await new ProbeRepository(pool).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    const r = await runBackfill({ pool, dryRun: true });
    expect(r.scanned).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.skippedDuplicate).toBe(0);

    const txRes = await pool.query<{ c: string }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(txRes.rows[0].c)).toBe(0);
    const streamingRes = await pool.query<{ c: string }>('SELECT COUNT(*) AS c FROM operator_streaming_posteriors');
    expect(Number(streamingRes.rows[0].c)).toBe(0);
  });

  it('active run inserts 1 tx per (target, day) and bumps streaming + buckets', async () => {
    const a = 'bb'.repeat(32);
    const agentRepo = new AgentRepository(pool);
    const probeRepo = new ProbeRepository(pool);
    await agentRepo.insert(makeAgent(a));
    // 3 probes on same day, 1 reachable, 2 unreachable — daily bucket wins
    await probeRepo.insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });
    await probeRepo.insert({
      target_hash: a, probed_at: NOW - 200, reachable: 0,
      latency_ms: null, hops: null, estimated_fee_msat: null,
      failure_reason: 'no_route', probe_amount_sats: 1000,
    });
    await probeRepo.insert({
      target_hash: a, probed_at: NOW - 300, reachable: 0,
      latency_ms: null, hops: null, estimated_fee_msat: null,
      failure_reason: 'no_route', probe_amount_sats: 1000,
    });

    const r = await runBackfill({ pool });
    expect(r.scanned).toBe(3);
    expect(r.inserted).toBe(1);
    expect(r.skippedDuplicate).toBe(2); // same-day collisions

    const txRes = await pool.query<{ endpoint_hash: string; operator_id: string; source: string; status: string }>(
      'SELECT endpoint_hash, operator_id, source, status FROM transactions',
    );
    const tx = txRes.rows[0];
    expect(tx.endpoint_hash).toBe(a);
    expect(tx.operator_id).toBe(a);
    expect(tx.source).toBe('probe');
    // First row wins → reachable=1 → verified
    expect(tx.status).toBe('verified');

    const streamingRes = await pool.query<{ source: string; total_ingestions: string }>(
      `SELECT source, total_ingestions FROM operator_streaming_posteriors WHERE operator_id = $1`,
      [a],
    );
    const streaming = streamingRes.rows[0];
    expect(streaming.source).toBe('probe');
    expect(Number(streaming.total_ingestions)).toBe(1);
  });

  it('idempotent — 2× run does not duplicate tx or double-count streaming', async () => {
    const a = 'cc'.repeat(32);
    await new AgentRepository(pool).insert(makeAgent(a));
    await new ProbeRepository(pool).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    await runBackfill({ pool });
    const r2 = await runBackfill({ pool });
    expect(r2.inserted).toBe(0);
    expect(r2.skippedDuplicate).toBeGreaterThanOrEqual(0);

    const txRes = await pool.query<{ c: string }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(txRes.rows[0].c)).toBe(1);

    const streamingRes = await pool.query<{ total_ingestions: string }>(
      `SELECT total_ingestions FROM operator_streaming_posteriors WHERE operator_id = $1`,
      [a],
    );
    expect(Number(streamingRes.rows[0].total_ingestions)).toBe(1);
  });

  it('skips non-base amount probes (10k/100k/1M tiers)', async () => {
    const a = 'dd'.repeat(32);
    await new AgentRepository(pool).insert(makeAgent(a));
    await new ProbeRepository(pool).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 10_000,
    });
    await new ProbeRepository(pool).insert({
      target_hash: a, probed_at: NOW - 200, reachable: 1,
      latency_ms: 12, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 100_000,
    });

    const r = await runBackfill({ pool });
    expect(r.scanned).toBe(2);
    expect(r.skippedNonBase).toBe(2);
    expect(r.inserted).toBe(0);
  });

  it('skips rows whose target agent is missing (orphan — defensive)', async () => {
    // Simulate a post-hoc orphan : insert the probe row directly with FK
    // disabled, then re-enable FK before running the backfill. This models
    // the real-world case where an old agent row was purged but the probe
    // history survived (no ON DELETE CASCADE on probe_results).
    const orphanHash = `ee${'ee'.repeat(31)}`;
    await pool.query(
      `INSERT INTO probe_results (target_hash, probed_at, reachable, probe_amount_sats)
       VALUES ($1, $2, 1, 1000)`,
      [orphanHash, NOW - 100],
    );
    const r = await runBackfill({ pool });
    expect(r.skippedOrphanTarget).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.errors).toBe(0);
  });

  it('--limit stops after N rows and checkpoint advances correctly', async () => {
    const agentRepo = new AgentRepository(pool);
    const probeRepo = new ProbeRepository(pool);
    for (let i = 0; i < 5; i++) {
      const h = `${i.toString(16).padStart(2, '0')}${'ff'.repeat(31)}`;
      await agentRepo.insert(makeAgent(h));
      await probeRepo.insert({
        target_hash: h, probed_at: NOW - i * DAY - 100, reachable: 1,
        latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
        failure_reason: null, probe_amount_sats: 1000,
      });
    }

    const r = await runBackfill({ pool, limit: 3 });
    expect(r.scanned).toBe(3);
    expect(r.inserted).toBe(3);
    expect(r.checkpoint.probe_results_last_id).toBe(3);

    // Resume from checkpoint finishes the remaining 2
    const r2 = await runBackfill({ pool, checkpoint: r.checkpoint });
    expect(r2.scanned).toBe(2);
    expect(r2.inserted).toBe(2);
    expect(r2.checkpoint.probe_results_last_id).toBe(5);

    const totalRes = await pool.query<{ c: string }>('SELECT COUNT(*) AS c FROM transactions');
    expect(Number(totalRes.rows[0].c)).toBe(5);
  });

  it('checkpoint file persists across calls', async () => {
    const a = '55'.repeat(32);
    await new AgentRepository(pool).insert(makeAgent(a));
    await new ProbeRepository(pool).insert({
      target_hash: a, probed_at: NOW - 100, reachable: 1,
      latency_ms: 10, hops: 2, estimated_fee_msat: 1000,
      failure_reason: null, probe_amount_sats: 1000,
    });

    const cpPath = path.join(tmpDir, 'cp.json');
    const r = await runBackfillChunk({ pool, checkpointPath: cpPath });
    expect(r.checkpoint.probe_results_last_id).toBe(1);
    expect(fs.existsSync(cpPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    expect(onDisk.probe_results_last_id).toBe(1);
  });
});
