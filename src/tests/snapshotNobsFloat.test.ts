// Regression test for Phase 12B Finding A:
// score_snapshots.n_obs must accept decayed float values (nObsEffective).
// Prior to the fix, the column was BIGINT in the Postgres port and rejected
// any non-integer value with "invalid input syntax for type bigint: ...".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';

let testDb: TestDb;

describe('SnapshotRepository.insert — n_obs float values (Finding A regression)', () => {
  let agentRepo: AgentRepository;
  let repo: SnapshotRepository;
  const agentHash = 'a'.repeat(64);

  beforeEach(async () => {
    testDb = await setupTestPool();
    agentRepo = new AgentRepository(testDb.pool);
    repo = new SnapshotRepository(testDb.pool);
    await agentRepo.insert({
      public_key_hash: agentHash,
      public_key: null,
      alias: 'finding-a-regression',
      first_seen: 1500000000,
      last_seen: 1700000000,
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
    });
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  async function insertWithNObs(nObs: number): Promise<number> {
    const snapshotId = uuid();
    await repo.insert({
      snapshot_id: snapshotId,
      agent_hash: agentHash,
      p_success: 0.5,
      ci95_low: 0.45,
      ci95_high: 0.55,
      n_obs: nObs,
      posterior_alpha: 6.5,
      posterior_beta: 6.5,
      window: '7d',
      computed_at: 1700000000,
      updated_at: 1700000000,
    });
    const { rows } = await testDb.pool.query<{ n_obs: number }>(
      'SELECT n_obs FROM score_snapshots WHERE snapshot_id = $1',
      [snapshotId],
    );
    return rows[0].n_obs;
  }

  it('accepts the canonical failing value 0.987', async () => {
    const stored = await insertWithNObs(0.987);
    expect(stored).toBeCloseTo(0.987, 6);
  });

  it('accepts 0 (legacy snapshots pre-streaming)', async () => {
    const stored = await insertWithNObs(0);
    expect(stored).toBe(0);
  });

  it('accepts a typical integer-like value 42', async () => {
    const stored = await insertWithNObs(42);
    expect(stored).toBe(42);
  });

  it('accepts a fractional value above 1 (e.g. 12.375)', async () => {
    const stored = await insertWithNObs(12.375);
    expect(stored).toBeCloseTo(12.375, 6);
  });

  it('accepts a large value within DOUBLE PRECISION range', async () => {
    const stored = await insertWithNObs(1_000_000.125);
    expect(stored).toBeCloseTo(1_000_000.125, 3);
  });
});
