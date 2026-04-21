// Tests for the post-bitcoind scoring calibration:
//   - Diversity prefers unique_peers, falls back to BTC when missing
//   - Regularity is multi-axis (uptime/latency/hops) above 3 probes, gossip fallback below
//   - Probe latency/short-hop bonuses are gone (removed double-counting)
//   - Probe unreachable penalty (−10) is preserved
//
// These tests pin the new calibration — if anyone tweaks the formulas without
// updating them, the suite will catch the regression.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeLnAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 1_000_000_000, // 10 BTC
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    query_count: 0,
    unique_peers: null,
    last_queried_at: null,
    ...overrides,
  };
}

describe('Diversity — prefers unique_peers when available', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let scoring: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('50 peers → diversity ~63', async () => {
    const a = makeLnAgent('peer-50', { unique_peers: 50, capacity_sats: 100_000_000 });
    await agentRepo.insert(a);
    await db.query('UPDATE agents SET unique_peers = $1 WHERE public_key_hash = $2', [50, a.public_key_hash]);

    const result = await scoring.computeScore(a.public_key_hash);
    expect(result.components.diversity).toBeGreaterThanOrEqual(60);
    expect(result.components.diversity).toBeLessThanOrEqual(66);
  });

  it('500 peers → diversity = 100', async () => {
    const a = makeLnAgent('peer-500', { capacity_sats: 100_000_000 });
    await agentRepo.insert(a);
    await db.query('UPDATE agents SET unique_peers = $1 WHERE public_key_hash = $2', [500, a.public_key_hash]);

    const result = await scoring.computeScore(a.public_key_hash);
    expect(result.components.diversity).toBe(100);
  });

  it('a node with 500 BTC but only 2 peers gets low diversity (penalises concentration)', async () => {
    const concentrated = makeLnAgent('concentrated', { capacity_sats: 50_000_000_000 }); // 500 BTC
    await agentRepo.insert(concentrated);
    await db.query('UPDATE agents SET unique_peers = $1 WHERE public_key_hash = $2', [2, concentrated.public_key_hash]);

    const result = await scoring.computeScore(concentrated.public_key_hash);
    // log(3) / log(501) * 100 ≈ 17.7 → 18. Should NOT be 100 despite the huge capacity.
    expect(result.components.diversity).toBeLessThan(25);
    expect(result.components.diversity).toBeGreaterThan(10);
  });

  it('a small node with 20 peers beats a big node with 2 peers', async () => {
    const diverse = makeLnAgent('diverse-small', { capacity_sats: 50_000_000 }); // 0.5 BTC
    await agentRepo.insert(diverse);
    await db.query('UPDATE agents SET unique_peers = $1 WHERE public_key_hash = $2', [20, diverse.public_key_hash]);

    const concentrated = makeLnAgent('concentrated-big', { capacity_sats: 50_000_000_000 }); // 500 BTC
    await agentRepo.insert(concentrated);
    await db.query('UPDATE agents SET unique_peers = $1 WHERE public_key_hash = $2', [2, concentrated.public_key_hash]);

    const d = await scoring.computeScore(diverse.public_key_hash);
    const c = await scoring.computeScore(concentrated.public_key_hash);
    expect(d.components.diversity).toBeGreaterThan(c.components.diversity);
  });

  it('falls back to BTC capacity formula when unique_peers is null', async () => {
    const a = makeLnAgent('no-peers', { capacity_sats: 5_900_000_000, unique_peers: null });
    await agentRepo.insert(a);

    const result = await scoring.computeScore(a.public_key_hash);
    // 59 BTC fallback → ~92 (unchanged from legacy formula)
    expect(result.components.diversity).toBeGreaterThan(80);
  });
});

describe('Regularity — multi-axis with ≥3 probes, gossip fallback below', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let scoring: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  async function insertProbes(hash: string, rows: Array<{ reachable: 0 | 1; latency_ms: number | null; hops: number | null }>): Promise<void> {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await probeRepo.insert({
        target_hash: hash,
        probed_at: NOW - i * 3600,
        reachable: row.reachable,
        latency_ms: row.latency_ms,
        hops: row.hops,
        estimated_fee_msat: null,
        failure_reason: row.reachable === 1 ? null : 'no_route',
      });
    }
  }

  it('100% uptime + stable latency + stable hops → regularity 100', async () => {
    const a = makeLnAgent('stable-100');
    await agentRepo.insert(a);
    await insertProbes(a.public_key_hash, Array(5).fill({ reachable: 1, latency_ms: 120, hops: 3 }));

    const r = await scoring.computeScore(a.public_key_hash);
    expect(r.components.regularity).toBe(100);
  });

  it('100% uptime + variable latency (cv≈1) → regularity drops to ~85-90', async () => {
    const a = makeLnAgent('uptime-only-jitter');
    await agentRepo.insert(a);
    // High-variance latency: mean ≈ 400, stddev ≈ 400, cv ≈ 1 → exp(-1) ≈ 0.37 → 7 latency points
    await insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 900, hops: 3 },
      { reachable: 1, latency_ms: 200, hops: 3 },
      { reachable: 1, latency_ms: 1200, hops: 3 },
      { reachable: 1, latency_ms: 300, hops: 3 },
    ]);
    const result = await scoring.computeScore(a.public_key_hash);
    const r = result.components.regularity;
    expect(r).toBeGreaterThan(80);
    expect(r).toBeLessThan(90);
  });

  it('80% uptime + stable latency + stable hops → regularity ~86', async () => {
    const a = makeLnAgent('mostly-up');
    await agentRepo.insert(a);
    // 4/5 reachable = 80% uptime
    await insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 0, latency_ms: null, hops: null },
    ]);
    // uptime 0.8 * 70 = 56, latency 1.0 * 20 = 20, hops 1.0 * 10 = 10 → 86
    const result = await scoring.computeScore(a.public_key_hash);
    const r = result.components.regularity;
    expect(r).toBeGreaterThan(83);
    expect(r).toBeLessThan(90);
  });

  it('50% uptime + stable → regularity drops further', async () => {
    const a = makeLnAgent('half-up');
    await agentRepo.insert(a);
    await insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 0, latency_ms: null, hops: null },
      { reachable: 0, latency_ms: null, hops: null },
      { reachable: 0, latency_ms: null, hops: null },
    ]);
    // uptime 0.5 * 70 = 35, latency 1.0 * 20 = 20, hops 1.0 * 10 = 10 → 65
    const result = await scoring.computeScore(a.public_key_hash);
    const r = result.components.regularity;
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(70);
  });

  it('<3 probes → falls back to gossip recency (preserves legacy behaviour)', async () => {
    const recent = makeLnAgent('recent-no-probes', { last_seen: NOW - DAY });
    const dead = makeLnAgent('dead-no-probes', { last_seen: NOW - 90 * DAY });
    await agentRepo.insert(recent);
    await agentRepo.insert(dead);

    const rRecent = await scoring.computeScore(recent.public_key_hash);
    const rDead = await scoring.computeScore(dead.public_key_hash);
    expect(rRecent.components.regularity).toBeGreaterThan(90);
    expect(rDead.components.regularity).toBeLessThan(45);
  });

  it('regularity is NOT pushed to 100 by uptime alone — this is the anti-saturation contract', async () => {
    // This is THE test for the calibration goal. Without the old bonus system,
    // a 100%-uptime node with any latency jitter or hop variance MUST come in below 100.
    const a = makeLnAgent('pure-uptime');
    await agentRepo.insert(a);
    await insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 50, hops: 2 },
      { reachable: 1, latency_ms: 500, hops: 5 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 300, hops: 2 },
    ]);
    const r = await scoring.computeScore(a.public_key_hash);
    expect(r.components.regularity).toBeLessThan(100);
  });
});

describe('Probe bonuses — removed', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let scoring: ScoringService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('a single fast short-hop probe does NOT inflate the total score', async () => {
    // Pre-removal this would have added +5 to any reachable node with latency<500 and hops≤3.
    // Post-removal, a single probe doesn't even trigger the multi-axis regularity path
    // (< 3 probes), so the score should match a probe-free baseline.
    const noProbe = makeLnAgent('no-probe-baseline');
    await agentRepo.insert(noProbe);
    const baseline = await scoring.computeScore(noProbe.public_key_hash);

    const oneProbe = makeLnAgent('one-probe');
    await agentRepo.insert(oneProbe);
    await probeRepo.insert({
      target_hash: oneProbe.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 50,
      hops: 2,
      estimated_fee_msat: 10,
      failure_reason: null,
    });
    const withProbe = await scoring.computeScore(oneProbe.public_key_hash);

    expect(withProbe.total).toBe(baseline.total);
  });

  it('unreachable-penalty is graduated by failure cause', async () => {
    // Test node has fresh gossip (last_seen = NOW) and no disabled channels
    // → classified as "liquidity constraint" → ×0.90 (mildest penalty)
    const a = makeLnAgent('was-reachable');
    await agentRepo.insert(a);
    const beforeRes = await scoring.computeScore(a.public_key_hash);
    const before = beforeRes.total;

    // Insert a fresh unreachable probe (within PROBE_FRESHNESS_TTL)
    await probeRepo.insert({
      target_hash: a.public_key_hash,
      probed_at: NOW,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });
    const afterRes = await scoring.computeScore(a.public_key_hash);
    const after = afterRes.total;
    expect(after).toBeLessThan(before);
    // Graduated penalty for fresh-gossip + no disabled channels = ×0.90
    expect(after).toBeGreaterThanOrEqual(Math.round(before * 0.90) - 1);
    expect(after).toBeLessThanOrEqual(Math.round(before * 0.90) + 1);
  });
});

describe('ProbeRepository — new stats methods', async () => {
  let db: Pool;
  let probeRepo: ProbeRepository;
  const hash = sha256('stats-target');

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    probeRepo = new ProbeRepository(db);
    // Stub an agent row so FK passes
    await db.query(
      `INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES ($1, $2, $3, 'manual')`,
      [hash, NOW, NOW],
    );
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('getLatencyStats ignores unreachable probes', async () => {
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: null, failure_reason: null });
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 200, hops: 3, estimated_fee_msat: null, failure_reason: null });
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });

    const stats = await probeRepo.getLatencyStats(hash, 86400);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(150);
    // sqrt((100-150)^2 + (200-150)^2) / 2) = sqrt(2500) = 50
    expect(stats.stddev).toBeCloseTo(50, 0);
  });

  it('getLatencyStats returns count=0 when no reachable probes exist', async () => {
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });
    const stats = await probeRepo.getLatencyStats(hash, 86400);
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.stddev).toBe(0);
  });

  it('getHopStats computes mean and stddev correctly', async () => {
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: null, failure_reason: null });
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 4, estimated_fee_msat: null, failure_reason: null });
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 6, estimated_fee_msat: null, failure_reason: null });

    const stats = await probeRepo.getHopStats(hash, 86400);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(4, 0);
    // stddev of [2,4,6] with mean 4 = sqrt(((4+0+4)/3)) ≈ 1.63
    expect(stats.stddev).toBeGreaterThan(1.5);
    expect(stats.stddev).toBeLessThan(1.7);
  });

  it('windowSec excludes old probes', async () => {
    await probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: null, failure_reason: null });
    await probeRepo.insert({ target_hash: hash, probed_at: NOW - 86400 * 8, reachable: 1, latency_ms: 999, hops: 10, estimated_fee_msat: null, failure_reason: null });
    // Last-7d window → only the first probe
    const stats = await probeRepo.getLatencyStats(hash, 7 * 86400);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBe(100);
  });
});
