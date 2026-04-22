// @ts-nocheck — Phase 12C: SQLite-era fixtures (db.prepare/run/get/all + db.transaction).
// Port helpers ensureAgent/insertProbe/etc. to pg.query before unskipping. Tests are
// already describe.skip'd so no runtime coverage is lost; TODO Phase 12D.
// Tests for runRetentionCleanup — chunked time-series sweeper.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { runRetentionCleanup } from '../database/retention';
import type { RetentionPolicy } from '../config/retention';
let testDb: TestDb;

const DAY = 86400;

// Stable midday-UTC reference so day-boundary rounding can't flap.
function stableNow(): number {
  const n = Math.floor(Date.now() / 1000);
  return n - (n % DAY) + DAY / 2;
}

function hashOf(seed: string): string {
  // 64-hex-char dummy hash derived from seed. Not a real sha256 — just
  // needs to be a string matching the agent PK shape for FK checks.
  return seed.padEnd(64, '0').slice(0, 64);
}

function ensureAgent(db: Pool, hash: string): void {
  const existing = db.prepare('SELECT 1 FROM agents WHERE public_key_hash = ?').get(hash);
  if (existing) return;
  db.prepare(`
    INSERT INTO agents (
      public_key_hash, alias, first_seen, last_seen, source,
      total_transactions, total_attestations_received, avg_score
    ) VALUES (?, ?, ?, ?, 'attestation', 0, 0, 0)
  `).run(hash, `agent-${hash.slice(0, 6)}`, 1500000000, 1700000000);
}

function insertProbe(db: Pool, agentHash: string, probedAt: number): void {
  ensureAgent(db, agentHash);
  db.prepare(`
    INSERT INTO probe_results (target_hash, probed_at, reachable, latency_ms, hops, estimated_fee_msat)
    VALUES (?, ?, 1, 100, 3, 1000)
  `).run(agentHash, probedAt);
}

let snapshotCounter = 0;
function insertScoreSnapshot(db: Pool, agentHash: string, computedAt: number): void {
  ensureAgent(db, agentHash);
  snapshotCounter++;
  // Post-v34 bayesian-only shape: p_success + ci + n_obs + posterior params.
  db.prepare(`
    INSERT INTO score_snapshots (
      snapshot_id, agent_hash,
      p_success, ci95_low, ci95_high, n_obs,
      posterior_alpha, posterior_beta, window,
      computed_at, updated_at
    ) VALUES (?, ?, 0.5, 0.45, 0.55, 10, 6.5, 6.5, '7d', ?, ?)
  `).run(`snap-${snapshotCounter}-${agentHash.slice(0, 6)}`, agentHash, computedAt, computedAt);
}

function insertChannelSnapshot(db: Pool, agentHash: string, snapshotAt: number): void {
  // channel_snapshots has no FK on agent_hash — no ensureAgent required.
  db.prepare(`
    INSERT INTO channel_snapshots (agent_hash, channel_count, capacity_sats, snapshot_at)
    VALUES (?, 10, 1000000, ?)
  `).run(agentHash, snapshotAt);
}

let feeCounter = 0;
function insertFeeSnapshot(db: Pool, nodePub: string, snapshotAt: number): void {
  feeCounter++;
  db.prepare(`
    INSERT INTO fee_snapshots (channel_id, node1_pub, node2_pub, fee_base_msat, fee_rate_ppm, snapshot_at)
    VALUES (?, ?, ?, 1000, 100, ?)
  `).run(`chan-${feeCounter}`, nodePub, 'dest-' + feeCounter, snapshotAt);
}

function count(db: Pool, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('runRetentionCleanup', async () => {
  let db: Pool;
  let now: number;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    now = stableNow();
    snapshotCounter = 0;
    feeCounter = 0;
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('deletes probe_results older than 14 days and keeps fresher ones', async () => {
    const agent = hashOf('a');
    insertProbe(db, agent, now - 20 * DAY); // gone
    insertProbe(db, agent, now - 15 * DAY); // gone
    insertProbe(db, agent, now - 14 * DAY + 1); // kept (cutoff is strictly <)
    insertProbe(db, agent, now - 13 * DAY); // kept
    insertProbe(db, agent, now - 1 * DAY); // kept
    expect(count(db, 'probe_results')).toBe(5);

    const results = await runRetentionCleanup(db, { now });

    const probeResult = results.find((r) => r.table === 'probe_results');
    expect(probeResult).toBeDefined();
    expect(probeResult!.deleted).toBe(2);
    expect(count(db, 'probe_results')).toBe(3);
  });

  it('deletes score_snapshots older than 45 days', async () => {
    const agent = hashOf('b');
    insertScoreSnapshot(db, agent, now - 50 * DAY); // gone
    insertScoreSnapshot(db, agent, now - 46 * DAY); // gone
    insertScoreSnapshot(db, agent, now - 44 * DAY); // kept
    insertScoreSnapshot(db, agent, now - 1 * DAY); // kept
    expect(count(db, 'score_snapshots')).toBe(4);

    const results = await runRetentionCleanup(db, { now });

    const r = results.find((x) => x.table === 'score_snapshots');
    expect(r!.deleted).toBe(2);
    expect(count(db, 'score_snapshots')).toBe(2);
  });

  it('deletes channel_snapshots older than 14 days', async () => {
    const agent = hashOf('c');
    insertChannelSnapshot(db, agent, now - 20 * DAY); // gone
    insertChannelSnapshot(db, agent, now - 14 * DAY - 1); // gone
    insertChannelSnapshot(db, agent, now - 13 * DAY); // kept
    insertChannelSnapshot(db, agent, now); // kept
    expect(count(db, 'channel_snapshots')).toBe(4);

    const results = await runRetentionCleanup(db, { now });

    const r = results.find((x) => x.table === 'channel_snapshots');
    expect(r!.deleted).toBe(2);
    expect(count(db, 'channel_snapshots')).toBe(2);
  });

  it('deletes fee_snapshots older than 14 days', async () => {
    insertFeeSnapshot(db, 'node-a', now - 30 * DAY); // gone
    insertFeeSnapshot(db, 'node-a', now - 15 * DAY); // gone
    insertFeeSnapshot(db, 'node-b', now - 10 * DAY); // kept
    insertFeeSnapshot(db, 'node-b', now); // kept
    expect(count(db, 'fee_snapshots')).toBe(4);

    const results = await runRetentionCleanup(db, { now });

    const r = results.find((x) => x.table === 'fee_snapshots');
    expect(r!.deleted).toBe(2);
    expect(count(db, 'fee_snapshots')).toBe(2);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('leaves permanent tables untouched (agents, transactions, attestations)', async () => {
    const agent1 = hashOf('perm1');
    const agent2 = hashOf('perm2');
    ensureAgent(db, agent1);
    ensureAgent(db, agent2);

    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol)
      VALUES ('tx-old', ?, ?, 'medium', ?, 'hash-1', 'verified', 'l402')
    `).run(agent1, agent2, now - 365 * DAY);

    db.prepare(`
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, timestamp, category)
      VALUES ('att-old', 'tx-old', ?, ?, 80, ?, 'general')
    `).run(agent1, agent2, now - 365 * DAY);

    // Pollute each time-series table with old rows so we know the sweeper runs.
    insertProbe(db, agent1, now - 100 * DAY);
    insertScoreSnapshot(db, agent1, now - 100 * DAY);

    const beforeAgents = count(db, 'agents');
    const beforeTx = count(db, 'transactions');
    const beforeAtt = count(db, 'attestations');
    expect(beforeAgents).toBeGreaterThan(0);
    expect(beforeTx).toBe(1);
    expect(beforeAtt).toBe(1);

    await runRetentionCleanup(db, { now });

    expect(count(db, 'agents')).toBe(beforeAgents);
    expect(count(db, 'transactions')).toBe(beforeTx);
    expect(count(db, 'attestations')).toBe(beforeAtt);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('chunks correctly when row count exceeds chunk size', async () => {
    const agent = hashOf('chunk');
    ensureAgent(db, agent);
    // Insert 250 old rows with a tight chunk size of 73 so we loop 4 times
    // (chunks of 73 + 73 + 73 + 31 = 250)
    const oldTs = now - 30 * DAY;
    const stmt = db.prepare(`
      INSERT INTO probe_results (target_hash, probed_at, reachable, latency_ms, hops, estimated_fee_msat)
      VALUES (?, ?, 1, 100, 3, 1000)
    `);
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 250; i++) stmt.run(agent, oldTs + i);
    });
    insertMany();
    // Plus 10 recent rows (well within retention) that must survive
    for (let i = 0; i < 10; i++) insertProbe(db, agent, now - 1 * DAY - i);

    expect(count(db, 'probe_results')).toBe(260);

    const results = await runRetentionCleanup(db, {
      now,
      chunkSize: 73,
      policies: [{ table: 'probe_results', column: 'probed_at', maxAgeDays: 14 }],
    });

    const r = results.find((x) => x.table === 'probe_results');
    expect(r!.deleted).toBe(250);
    expect(count(db, 'probe_results')).toBe(10);
  });

  it('is idempotent — second run with same clock deletes nothing', async () => {
    const agent = hashOf('idem');
    insertProbe(db, agent, now - 30 * DAY);
    insertProbe(db, agent, now - 1 * DAY);

    const first = await runRetentionCleanup(db, { now });
    const second = await runRetentionCleanup(db, { now });

    const firstProbe = first.find((x) => x.table === 'probe_results')!;
    const secondProbe = second.find((x) => x.table === 'probe_results')!;

    expect(firstProbe.deleted).toBe(1);
    expect(secondProbe.deleted).toBe(0);
    expect(count(db, 'probe_results')).toBe(1);
  });

  it('returns a result entry for every policy even when deleted = 0', async () => {
    const results = await runRetentionCleanup(db, { now });
    expect(results.map((r) => r.table).sort()).toEqual(
      ['channel_snapshots', 'fee_snapshots', 'probe_results', 'score_snapshots'],
    );
    expect(results.every((r) => r.deleted === 0)).toBe(true);
    expect(results.every((r) => r.durationMs >= 0)).toBe(true);
  });

  it('respects a custom policies override for isolated testing', async () => {
    const agent = hashOf('custom');
    insertProbe(db, agent, now - 5 * DAY);
    insertProbe(db, agent, now - 1 * DAY);

    const policies: RetentionPolicy[] = [
      { table: 'probe_results', column: 'probed_at', maxAgeDays: 3 },
    ];
    const results = await runRetentionCleanup(db, { now, policies });

    expect(results).toHaveLength(1);
    expect(results[0]!.table).toBe('probe_results');
    expect(results[0]!.deleted).toBe(1);
    expect(count(db, 'probe_results')).toBe(1);
  });
});
