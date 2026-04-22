// Snapshot retention purge tests — 3-tier logic
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { v4 as uuid } from 'uuid';
import { AgentRepository } from '../repositories/agentRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
let testDb: TestDb;

const DAY = 86400;

async function ensureAgent(agentRepo: AgentRepository, hash: string): Promise<void> {
  if (!(await agentRepo.findByHash(hash))) {
    await agentRepo.insert({
      public_key_hash: hash,
      public_key: null,
      alias: `agent-${hash.slice(0, 8)}`,
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
  }
}

async function insertSnapshot(agentRepo: AgentRepository, repo: SnapshotRepository, agentHash: string, computedAt: number): Promise<void> {
  await ensureAgent(agentRepo, agentHash);
  await repo.insert({
    snapshot_id: uuid(),
    agent_hash: agentHash,
    p_success: 0.5,
    ci95_low: 0.45,
    ci95_high: 0.55,
    n_obs: 10,
    posterior_alpha: 6.5,
    posterior_beta: 6.5,
    window: '7d',
    computed_at: computedAt,
    updated_at: computedAt,
  });
}

describe('SnapshotRepository.purgeOldSnapshots', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let repo: SnapshotRepository;
  let now: number;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    repo = new SnapshotRepository(db);
    // Snap to midday UTC to avoid day-boundary flakiness (purgeOldSnapshots
    // uses its own Date.now() which may differ by 1-2 seconds)
    now = Math.floor(Date.now() / 1000);
    now = now - (now % 86400) + 43200;
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('deletes all snapshots older than 30 days', async () => {
    const agent = 'a'.repeat(64);
    await insertSnapshot(agentRepo, repo, agent, now - 31 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 35 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 60 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 1 * DAY);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(3);
    expect(await repo.countByAgent(agent)).toBe(1);
  });

  it('keeps all snapshots within the last 7 days', async () => {
    const agent = 'b'.repeat(64);
    await insertSnapshot(agentRepo, repo, agent, now - 1 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 1 * DAY + 300);
    await insertSnapshot(agentRepo, repo, agent, now - 1 * DAY + 600);
    await insertSnapshot(agentRepo, repo, agent, now - 2 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 6 * DAY);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(0);
    expect(await repo.countByAgent(agent)).toBe(5);
  });

  it('keeps only 1 snapshot per day between 7 and 30 days', async () => {
    const agent = 'c'.repeat(64);
    const tenDaysAgo = now - 10 * DAY;

    await insertSnapshot(agentRepo, repo, agent, tenDaysAgo);
    await insertSnapshot(agentRepo, repo, agent, tenDaysAgo + 300);
    await insertSnapshot(agentRepo, repo, agent, tenDaysAgo - 300);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(2);
    expect(await repo.countByAgent(agent)).toBe(1);

    const surviving = await repo.findHistoryByAgent(agent, 1, 0);
    expect(surviving[0].computed_at).toBe(tenDaysAgo + 300);
  });

  it('handles multiple agents independently in 7-30 day window', async () => {
    const agentA = 'd'.repeat(64);
    const agentB = 'e'.repeat(64);
    const fifteenDaysAgo = now - 15 * DAY;

    await insertSnapshot(agentRepo, repo, agentA, fifteenDaysAgo);
    await insertSnapshot(agentRepo, repo, agentA, fifteenDaysAgo + 100);
    await insertSnapshot(agentRepo, repo, agentA, fifteenDaysAgo + 200);

    await insertSnapshot(agentRepo, repo, agentB, fifteenDaysAgo);
    await insertSnapshot(agentRepo, repo, agentB, fifteenDaysAgo + 50);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(3);
    expect(await repo.countByAgent(agentA)).toBe(1);
    expect(await repo.countByAgent(agentB)).toBe(1);
  });

  it('keeps snapshots on different days in 7-30 day window', async () => {
    const agent = 'f'.repeat(64);

    await insertSnapshot(agentRepo, repo, agent, now - 10 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 15 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 20 * DAY);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(0);
    expect(await repo.countByAgent(agent)).toBe(3);
  });

  it('applies all 3 tiers in a single purge', async () => {
    const agent = 'abcd'.repeat(16);

    // Tier 1: recent (< 7 days) — keep all
    await insertSnapshot(agentRepo, repo, agent, now - 2 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 2 * DAY + 100);

    // Tier 2: mid-range (7-30 days) — 3 on same day, keep 1
    const midDay = now - 14 * DAY;
    await insertSnapshot(agentRepo, repo, agent, midDay);
    await insertSnapshot(agentRepo, repo, agent, midDay + 100);
    await insertSnapshot(agentRepo, repo, agent, midDay + 200);

    // Tier 3: old (> 30 days) — delete all
    await insertSnapshot(agentRepo, repo, agent, now - 40 * DAY);
    await insertSnapshot(agentRepo, repo, agent, now - 50 * DAY);

    const purged = await repo.purgeOldSnapshots();

    expect(purged).toBe(4);
    expect(await repo.countByAgent(agent)).toBe(3);
  });

  it('returns 0 when nothing to purge', async () => {
    const purged = await repo.purgeOldSnapshots();
    expect(purged).toBe(0);
  });
});
