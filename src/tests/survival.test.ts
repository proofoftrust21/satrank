// Survival score, gossip freshness flags, channel flow, fee volatility tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ChannelSnapshotRepository } from '../repositories/channelSnapshotRepository';
import { FeeSnapshotRepository } from '../repositories/feeSnapshotRepository';
import { ScoringService } from '../services/scoringService';
import { TrendService } from '../services/trendService';
import { SurvivalService } from '../services/survivalService';
import { ChannelFlowService } from '../services/channelFlowService';
import { FeeVolatilityService } from '../services/feeVolatilityService';
import { computeBaseFlags } from '../utils/flags';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const alias = overrides.alias ?? 'test-agent';
  return {
    public_key_hash: sha256(alias),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 180 * DAY,
    last_seen: NOW - 3600, // 1h ago
    source: 'lightning_graph',
    total_transactions: 50,
    total_attestations_received: 10,
    avg_score: 65,
    capacity_sats: 500000000,
    positive_ratings: 5,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 10,
    ...overrides,
  };
}

// --- Gossip Freshness Flags ---

describe('Gossip freshness flags', () => {
  it('no flag when last_seen < 7 days ago', async () => {
    const agent = makeAgent({ last_seen: NOW - 2 * DAY });
    const delta = { delta7d: null };
    const flags = computeBaseFlags(agent, delta, NOW);
    expect(flags).not.toContain('stale_gossip');
    expect(flags).not.toContain('zombie_gossip');
  });

  it('stale_gossip when last_seen 7-14 days ago', async () => {
    const agent = makeAgent({ last_seen: NOW - 10 * DAY });
    const delta = { delta7d: null };
    const flags = computeBaseFlags(agent, delta, NOW);
    expect(flags).toContain('stale_gossip');
    expect(flags).not.toContain('zombie_gossip');
  });

  it('zombie_gossip when last_seen > 14 days ago', async () => {
    const agent = makeAgent({ last_seen: NOW - 20 * DAY });
    const delta = { delta7d: null };
    const flags = computeBaseFlags(agent, delta, NOW);
    expect(flags).toContain('zombie_gossip');
    expect(flags).not.toContain('stale_gossip');
  });
});

// --- Survival Score ---

describe('SurvivalService', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let snapshotRepo: SnapshotRepository;
  let survivalService: SurvivalService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    probeRepo = new ProbeRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('returns 100/stable for healthy agent with good probes and fresh gossip', async () => {
    const agent = makeAgent({ alias: 'healthy', last_seen: NOW - 3600 });
    await agentRepo.insert(agent);

    // Seed reachable probes
    for (let i = 0; i < 5; i++) {
      await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - i * 3600, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: 500, failure_reason: null });
    }

    const result = await survivalService.compute(agent);
    expect(result.score).toBe(100);
    expect(result.prediction).toBe('stable');
    expect(result.signals.probeStability).toContain('100%');
  });

  it('returns 0/likely_dead for agent with 0% uptime and zombie gossip', async () => {
    const agent = makeAgent({ alias: 'dead-agent', last_seen: NOW - 20 * DAY });
    await agentRepo.insert(agent);

    // Seed unreachable probes
    for (let i = 0; i < 5; i++) {
      await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - i * 3600, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });
    }

    const result = await survivalService.compute(agent);
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.prediction).toBe('likely_dead');
    expect(result.signals.gossipFreshness).toContain('zombie');
  });

  it('returns at_risk for agent with declining probe uptime', async () => {
    const agent = makeAgent({ alias: 'declining', last_seen: NOW - 8 * DAY });
    await agentRepo.insert(agent);

    // Mixed probes: some reachable, some not (60% uptime)
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - 4 * 3600, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: 500, failure_reason: null });
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - 3 * 3600, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: 500, failure_reason: null });
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - 2 * 3600, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: 500, failure_reason: null });
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - 1 * 3600, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });
    await probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });

    const result = await survivalService.compute(agent);
    // 60% uptime → -15 probe, stale gossip → -10 = score 75 → stable or at_risk
    expect(result.score).toBeLessThan(100);
    expect(result.signals.gossipFreshness).toContain('stale');
  });

  it('returns likely_dead for nonexistent agent', async () => {
    const result = await survivalService.compute(sha256('nonexistent'));
    expect(result.score).toBe(0);
    expect(result.prediction).toBe('likely_dead');
  });

  it('signal 1 is neutral when no 7d snapshots exist', async () => {
    const agent = makeAgent({ alias: 'no-history' });
    await agentRepo.insert(agent);

    // No snapshots → signal 1 neutral
    const result = await survivalService.compute(agent);
    expect(result.signals.scoreTrajectory).toBe('insufficient data');
  });
});

// --- Channel Flow ---

describe('ChannelFlowService', async () => {
  let db: Pool;
  let channelSnapshotRepo: ChannelSnapshotRepository;
  let channelFlowService: ChannelFlowService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    channelSnapshotRepo = new ChannelSnapshotRepository(db);
    channelFlowService = new ChannelFlowService(channelSnapshotRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('returns null when no snapshots exist', async () => {
    expect(await channelFlowService.computeFlow(sha256('nobody'))).toBeNull();
  });

  it('detects declining channel flow', async () => {
    const hash = sha256('declining-node');
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 20, capacity_sats: 5_000_000_000, snapshot_at: NOW - 8 * DAY });
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 15, capacity_sats: 3_000_000_000, snapshot_at: NOW });

    const flow = await channelFlowService.computeFlow(hash);
    expect(flow).not.toBeNull();
    expect(flow!.net7d).toBe(-5);
    expect(flow!.capacityDelta7d).toBe(-2_000_000_000);
    expect(flow!.trend).toBe('declining');
  });

  it('detects growing channel flow', async () => {
    const hash = sha256('growing-node');
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 10, capacity_sats: 1_000_000_000, snapshot_at: NOW - 8 * DAY });
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 16, capacity_sats: 3_000_000_000, snapshot_at: NOW });

    const flow = await channelFlowService.computeFlow(hash);
    expect(flow!.net7d).toBe(6);
    expect(flow!.trend).toBe('growing');
  });

  it('detects severe capacity drain', async () => {
    const hash = sha256('draining-node');
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 10, capacity_sats: 5_000_000_000, snapshot_at: NOW - DAY });
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 8, capacity_sats: 2_000_000_000, snapshot_at: NOW });

    const flags = await channelFlowService.computeDrainFlags(hash);
    expect(flags).toContain('severe_capacity_drain');
  });

  it('no drain flag for stable capacity', async () => {
    const hash = sha256('stable-node');
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 10, capacity_sats: 5_000_000_000, snapshot_at: NOW - DAY });
    await channelSnapshotRepo.insert({ agent_hash: hash, channel_count: 10, capacity_sats: 4_800_000_000, snapshot_at: NOW });

    const flags = await channelFlowService.computeDrainFlags(hash);
    expect(flags).toEqual([]);
  });
});

// --- Fee Volatility ---

describe('FeeVolatilityService', async () => {
  let db: Pool;
  let feeSnapshotRepo: FeeSnapshotRepository;
  let agentRepo: AgentRepository;
  let feeVolatilityService: FeeVolatilityService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    feeSnapshotRepo = new FeeSnapshotRepository(db);
    agentRepo = new AgentRepository(db);
    feeVolatilityService = new FeeVolatilityService(feeSnapshotRepo, agentRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('returns null when agent has no public key', async () => {
    const agent = makeAgent({ alias: 'no-pubkey', public_key: null });
    await agentRepo.insert(agent);
    expect(await feeVolatilityService.compute(agent.public_key_hash)).toBeNull();
  });

  it('returns null when no fee snapshots exist', async () => {
    const agent = makeAgent({ alias: 'no-fees' });
    await agentRepo.insert(agent);
    expect(await feeVolatilityService.compute(agent.public_key_hash)).toBeNull();
  });

  it('returns stable when fees do not change', async () => {
    const agent = makeAgent({ alias: 'stable-fees' });
    await agentRepo.insert(agent);

    // Two snapshots with same fees
    await feeSnapshotRepo.insertBatch([
      { channel_id: 'ch1', node1_pub: agent.public_key!, node2_pub: 'other', fee_base_msat: 1000, fee_rate_ppm: 100, snapshot_at: NOW - 2 * DAY },
      { channel_id: 'ch1', node1_pub: agent.public_key!, node2_pub: 'other', fee_base_msat: 1000, fee_rate_ppm: 100, snapshot_at: NOW },
    ]);

    const result = await feeVolatilityService.compute(agent.public_key_hash);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(result!.interpretation).toBe('stable');
  });
});
