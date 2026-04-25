// Heartbeat behavior of BayesianVerdictService.snapshotAndPersist.
//
// /api/health flags `scoringStale` when MAX(computed_at) > 7200s (2h). The
// snapshot writer is gated by SNAPSHOT_CHANGE_THRESHOLD || SNAPSHOT_HEARTBEAT_SEC,
// so a mature cohort with stable posteriors used to never insert and the
// staleness flag false-positived (incident 2026-04-25). The heartbeat must
// stay strictly below the staleness threshold — these tests pin that contract.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import {
  createBayesianVerdictService,
  seedSafeBayesianObservations,
} from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;

async function ensureAgent(agentRepo: AgentRepository, hash: string, now: number): Promise<void> {
  if (!(await agentRepo.findByHash(hash))) {
    await agentRepo.insert({
      public_key_hash: hash,
      public_key: null,
      alias: `agent-${hash.slice(0, 8)}`,
      first_seen: now - 30 * 86400,
      last_seen: now,
      source: 'manual',
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
    });
  }
}

describe('BayesianVerdictService.snapshotAndPersist heartbeat', () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let snapshotRepo: SnapshotRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    snapshotRepo = new SnapshotRepository(db);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('inserts the first snapshot when no previous row exists', async () => {
    const target = sha256('heartbeat-fresh');
    const now = Math.floor(Date.now() / 1000);
    await ensureAgent(agentRepo, target, now);
    await seedSafeBayesianObservations(db, target, { now });

    const verdict = createBayesianVerdictService(db);
    (verdict as unknown as { snapshotRepo: SnapshotRepository }).snapshotRepo = snapshotRepo;

    await verdict.snapshotAndPersist(target);

    const latest = await snapshotRepo.findLatestByAgent(target);
    expect(latest).toBeDefined();
  });

  it('skips a second insert when p_success is unchanged and previous row is fresh', async () => {
    const target = sha256('heartbeat-stable-fresh');
    const now = Math.floor(Date.now() / 1000);
    await ensureAgent(agentRepo, target, now);
    await seedSafeBayesianObservations(db, target, { now });

    const verdict = createBayesianVerdictService(db);
    (verdict as unknown as { snapshotRepo: SnapshotRepository }).snapshotRepo = snapshotRepo;

    await verdict.snapshotAndPersist(target);
    const first = await snapshotRepo.findLatestByAgent(target);
    expect(first).toBeDefined();

    // Second call within the heartbeat window with the same observations →
    // p_success delta is exactly 0 → no new row.
    await verdict.snapshotAndPersist(target);
    const history = await snapshotRepo.findHistoryByAgent(target, 10, 0);
    expect(history.length).toBe(1);
    expect(history[0].computed_at).toBe(first!.computed_at);
  });

  it('forces a new snapshot when previous row crosses the 1h heartbeat — and stays under the /api/health 2h staleness threshold', async () => {
    const target = sha256('heartbeat-stable-aged');
    const now = Math.floor(Date.now() / 1000);
    await ensureAgent(agentRepo, target, now);
    await seedSafeBayesianObservations(db, target, { now });

    const verdict = createBayesianVerdictService(db);
    (verdict as unknown as { snapshotRepo: SnapshotRepository }).snapshotRepo = snapshotRepo;

    await verdict.snapshotAndPersist(target);
    const first = await snapshotRepo.findLatestByAgent(target);
    expect(first).toBeDefined();

    // Backdate the existing snapshot by 1h + 1s — past the heartbeat window
    // but still well under the 2h /api/health staleness threshold. This is
    // the regression-pinning case: incident 2026-04-25.
    const aged = now - 3601;
    await db.query(
      'UPDATE score_snapshots SET computed_at = $1 WHERE snapshot_id = $2',
      [aged, first!.snapshot_id],
    );

    await verdict.snapshotAndPersist(target);
    const history = await snapshotRepo.findHistoryByAgent(target, 10, 0);
    expect(history.length).toBe(2);
    // The newest row's computed_at must be within the 2h /api/health window —
    // i.e. the heartbeat must rescue MAX(computed_at) before staleness trips.
    const newest = history[0];
    const STALE_THRESHOLD_SEC = 7200;
    expect(now - newest.computed_at).toBeLessThan(STALE_THRESHOLD_SEC);
  });
});
