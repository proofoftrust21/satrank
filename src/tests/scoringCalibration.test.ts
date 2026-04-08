// Tests for the post-bitcoind scoring calibration:
//   - Diversity prefers unique_peers, falls back to BTC when missing
//   - Regularity is multi-axis (uptime/latency/hops) above 3 probes, gossip fallback below
//   - Probe latency/short-hop bonuses are gone (removed double-counting)
//   - Probe unreachable penalty (−10) is preserved
//
// These tests pin the new calibration — if anyone tweaks the formulas without
// updating them, the suite will catch the regression.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

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

describe('Diversity — prefers unique_peers when available', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let scoring: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(() => db.close());

  it('50 peers → diversity ~63', () => {
    const a = makeLnAgent('peer-50', { unique_peers: 50, capacity_sats: 100_000_000 });
    agentRepo.insert(a);
    db.prepare('UPDATE agents SET unique_peers = ? WHERE public_key_hash = ?').run(50, a.public_key_hash);

    const result = scoring.computeScore(a.public_key_hash);
    expect(result.components.diversity).toBeGreaterThanOrEqual(60);
    expect(result.components.diversity).toBeLessThanOrEqual(66);
  });

  it('500 peers → diversity = 100', () => {
    const a = makeLnAgent('peer-500', { capacity_sats: 100_000_000 });
    agentRepo.insert(a);
    db.prepare('UPDATE agents SET unique_peers = ? WHERE public_key_hash = ?').run(500, a.public_key_hash);

    const result = scoring.computeScore(a.public_key_hash);
    expect(result.components.diversity).toBe(100);
  });

  it('a node with 500 BTC but only 2 peers gets low diversity (penalises concentration)', () => {
    const concentrated = makeLnAgent('concentrated', { capacity_sats: 50_000_000_000 }); // 500 BTC
    agentRepo.insert(concentrated);
    db.prepare('UPDATE agents SET unique_peers = ? WHERE public_key_hash = ?').run(2, concentrated.public_key_hash);

    const result = scoring.computeScore(concentrated.public_key_hash);
    // log(3) / log(501) * 100 ≈ 17.7 → 18. Should NOT be 100 despite the huge capacity.
    expect(result.components.diversity).toBeLessThan(25);
    expect(result.components.diversity).toBeGreaterThan(10);
  });

  it('a small node with 20 peers beats a big node with 2 peers', () => {
    const diverse = makeLnAgent('diverse-small', { capacity_sats: 50_000_000 }); // 0.5 BTC
    agentRepo.insert(diverse);
    db.prepare('UPDATE agents SET unique_peers = ? WHERE public_key_hash = ?').run(20, diverse.public_key_hash);

    const concentrated = makeLnAgent('concentrated-big', { capacity_sats: 50_000_000_000 }); // 500 BTC
    agentRepo.insert(concentrated);
    db.prepare('UPDATE agents SET unique_peers = ? WHERE public_key_hash = ?').run(2, concentrated.public_key_hash);

    const d = scoring.computeScore(diverse.public_key_hash);
    const c = scoring.computeScore(concentrated.public_key_hash);
    expect(d.components.diversity).toBeGreaterThan(c.components.diversity);
  });

  it('falls back to BTC capacity formula when unique_peers is null', () => {
    const a = makeLnAgent('no-peers', { capacity_sats: 5_900_000_000, unique_peers: null });
    agentRepo.insert(a);

    const result = scoring.computeScore(a.public_key_hash);
    // 59 BTC fallback → ~92 (unchanged from legacy formula)
    expect(result.components.diversity).toBeGreaterThan(80);
  });
});

describe('Regularity — multi-axis with ≥3 probes, gossip fallback below', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let scoring: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(() => db.close());

  function insertProbes(hash: string, rows: Array<{ reachable: 0 | 1; latency_ms: number | null; hops: number | null }>): void {
    rows.forEach((row, i) => {
      probeRepo.insert({
        target_hash: hash,
        probed_at: NOW - i * 3600,
        reachable: row.reachable,
        latency_ms: row.latency_ms,
        hops: row.hops,
        estimated_fee_msat: null,
        failure_reason: row.reachable === 1 ? null : 'no_route',
      });
    });
  }

  it('100% uptime + stable latency + stable hops → regularity 100', () => {
    const a = makeLnAgent('stable-100');
    agentRepo.insert(a);
    insertProbes(a.public_key_hash, Array(5).fill({ reachable: 1, latency_ms: 120, hops: 3 }));

    expect(scoring.computeScore(a.public_key_hash).components.regularity).toBe(100);
  });

  it('100% uptime + variable latency (cv≈1) → regularity drops to ~85-90', () => {
    const a = makeLnAgent('uptime-only-jitter');
    agentRepo.insert(a);
    // High-variance latency: mean ≈ 400, stddev ≈ 400, cv ≈ 1 → exp(-1) ≈ 0.37 → 7 latency points
    insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 900, hops: 3 },
      { reachable: 1, latency_ms: 200, hops: 3 },
      { reachable: 1, latency_ms: 1200, hops: 3 },
      { reachable: 1, latency_ms: 300, hops: 3 },
    ]);
    const r = scoring.computeScore(a.public_key_hash).components.regularity;
    expect(r).toBeGreaterThan(80);
    expect(r).toBeLessThan(90);
  });

  it('80% uptime + stable latency + stable hops → regularity ~86', () => {
    const a = makeLnAgent('mostly-up');
    agentRepo.insert(a);
    // 4/5 reachable = 80% uptime
    insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 0, latency_ms: null, hops: null },
    ]);
    // uptime 0.8 * 70 = 56, latency 1.0 * 20 = 20, hops 1.0 * 10 = 10 → 86
    const r = scoring.computeScore(a.public_key_hash).components.regularity;
    expect(r).toBeGreaterThan(83);
    expect(r).toBeLessThan(90);
  });

  it('50% uptime + stable → regularity drops further', () => {
    const a = makeLnAgent('half-up');
    agentRepo.insert(a);
    insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 0, latency_ms: null, hops: null },
      { reachable: 0, latency_ms: null, hops: null },
      { reachable: 0, latency_ms: null, hops: null },
    ]);
    // uptime 0.5 * 70 = 35, latency 1.0 * 20 = 20, hops 1.0 * 10 = 10 → 65
    const r = scoring.computeScore(a.public_key_hash).components.regularity;
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(70);
  });

  it('<3 probes → falls back to gossip recency (preserves legacy behaviour)', () => {
    const recent = makeLnAgent('recent-no-probes', { last_seen: NOW - DAY });
    const dead = makeLnAgent('dead-no-probes', { last_seen: NOW - 90 * DAY });
    agentRepo.insert(recent);
    agentRepo.insert(dead);

    expect(scoring.computeScore(recent.public_key_hash).components.regularity).toBeGreaterThan(90);
    expect(scoring.computeScore(dead.public_key_hash).components.regularity).toBeLessThan(45);
  });

  it('regularity is NOT pushed to 100 by uptime alone — this is the anti-saturation contract', () => {
    // This is THE test for the calibration goal. Without the old bonus system,
    // a 100%-uptime node with any latency jitter or hop variance MUST come in below 100.
    const a = makeLnAgent('pure-uptime');
    agentRepo.insert(a);
    insertProbes(a.public_key_hash, [
      { reachable: 1, latency_ms: 50, hops: 2 },
      { reachable: 1, latency_ms: 500, hops: 5 },
      { reachable: 1, latency_ms: 100, hops: 3 },
      { reachable: 1, latency_ms: 300, hops: 2 },
    ]);
    expect(scoring.computeScore(a.public_key_hash).components.regularity).toBeLessThan(100);
  });
});

describe('Probe bonuses — removed', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;
  let scoring: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(() => db.close());

  it('a single fast short-hop probe does NOT inflate the total score', () => {
    // Pre-removal this would have added +5 to any reachable node with latency<500 and hops≤3.
    // Post-removal, a single probe doesn't even trigger the multi-axis regularity path
    // (< 3 probes), so the score should match a probe-free baseline.
    const noProbe = makeLnAgent('no-probe-baseline');
    agentRepo.insert(noProbe);
    const baseline = scoring.computeScore(noProbe.public_key_hash);

    const oneProbe = makeLnAgent('one-probe');
    agentRepo.insert(oneProbe);
    probeRepo.insert({
      target_hash: oneProbe.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 50,
      hops: 2,
      estimated_fee_msat: 10,
      failure_reason: null,
    });
    const withProbe = scoring.computeScore(oneProbe.public_key_hash);

    expect(withProbe.total).toBe(baseline.total);
  });

  it('unreachable-penalty (−10) is still applied', () => {
    const a = makeLnAgent('was-reachable');
    agentRepo.insert(a);
    const before = scoring.computeScore(a.public_key_hash).total;

    // Insert a fresh unreachable probe (within PROBE_FRESHNESS_TTL)
    probeRepo.insert({
      target_hash: a.public_key_hash,
      probed_at: NOW,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });
    const after = scoring.computeScore(a.public_key_hash).total;
    expect(after).toBeLessThan(before);
    // Penalty is exactly −10 from the constant, clamped to ≥0
    expect(before - after).toBe(Math.min(10, before));
  });
});

describe('ProbeRepository — new stats methods', () => {
  let db: Database.Database;
  let probeRepo: ProbeRepository;
  const hash = sha256('stats-target');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    probeRepo = new ProbeRepository(db);
    // Stub an agent row so FK passes
    db.prepare(`INSERT INTO agents (public_key_hash, first_seen, last_seen, source) VALUES (?, ?, ?, 'manual')`).run(hash, NOW, NOW);
  });

  afterEach(() => db.close());

  it('getLatencyStats ignores unreachable probes', () => {
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: null, failure_reason: null });
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 200, hops: 3, estimated_fee_msat: null, failure_reason: null });
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });

    const stats = probeRepo.getLatencyStats(hash, 86400);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(150);
    // sqrt((100-150)^2 + (200-150)^2) / 2) = sqrt(2500) = 50
    expect(stats.stddev).toBeCloseTo(50, 0);
  });

  it('getLatencyStats returns count=0 when no reachable probes exist', () => {
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });
    const stats = probeRepo.getLatencyStats(hash, 86400);
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.stddev).toBe(0);
  });

  it('getHopStats computes mean and stddev correctly', () => {
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: null, failure_reason: null });
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 4, estimated_fee_msat: null, failure_reason: null });
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 6, estimated_fee_msat: null, failure_reason: null });

    const stats = probeRepo.getHopStats(hash, 86400);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(4, 0);
    // stddev of [2,4,6] with mean 4 = sqrt(((4+0+4)/3)) ≈ 1.63
    expect(stats.stddev).toBeGreaterThan(1.5);
    expect(stats.stddev).toBeLessThan(1.7);
  });

  it('windowSec excludes old probes', () => {
    probeRepo.insert({ target_hash: hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 3, estimated_fee_msat: null, failure_reason: null });
    probeRepo.insert({ target_hash: hash, probed_at: NOW - 86400 * 8, reachable: 1, latency_ms: 999, hops: 10, estimated_fee_msat: null, failure_reason: null });
    // Last-7d window → only the first probe
    const stats = probeRepo.getLatencyStats(hash, 7 * 86400);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBe(100);
  });
});
