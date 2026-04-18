// Probe routing tests — reachability data integration
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
import type { LndGraphClient, LndQueryRoutesResponse } from '../crawler/lndGraphClient';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`agent-${Math.random()}`),
    public_key: null,
    alias: 'test-agent',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 1_000_000_000,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

describe('Probe repository', () => {
  let db: Database.Database;
  let probeRepo: ProbeRepository;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    probeRepo = new ProbeRepository(db);
    agentRepo = new AgentRepository(db);
  });

  afterEach(() => db.close());

  it('inserts and retrieves a probe result', () => {
    const agent = makeAgent({ public_key_hash: sha256('probe-test') });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 120,
      hops: 3,
      estimated_fee_msat: 50,
      failure_reason: null,
    });

    const latest = probeRepo.findLatest(agent.public_key_hash);
    expect(latest).toBeDefined();
    expect(latest!.reachable).toBe(1);
    expect(latest!.latency_ms).toBe(120);
    expect(latest!.hops).toBe(3);
    expect(latest!.estimated_fee_msat).toBe(50);
    expect(latest!.failure_reason).toBeNull();
  });

  it('findLatest returns the most recent probe', () => {
    const agent = makeAgent({ public_key_hash: sha256('probe-latest') });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW - 3600,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });
    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 200,
      hops: 4,
      estimated_fee_msat: 100,
      failure_reason: null,
    });

    const latest = probeRepo.findLatest(agent.public_key_hash);
    expect(latest!.reachable).toBe(1);
    expect(latest!.probed_at).toBe(NOW);
  });

  it('findByTarget returns paginated results', () => {
    const agent = makeAgent({ public_key_hash: sha256('probe-paginate') });
    agentRepo.insert(agent);

    for (let i = 0; i < 5; i++) {
      probeRepo.insert({
        target_hash: agent.public_key_hash,
        probed_at: NOW - i * 3600,
        reachable: 1,
        latency_ms: 100 + i * 10,
        hops: 3,
        estimated_fee_msat: 50,
        failure_reason: null,
      });
    }

    const page1 = probeRepo.findByTarget(agent.public_key_hash, 2, 0);
    expect(page1).toHaveLength(2);
    expect(page1[0].probed_at).toBe(NOW); // most recent first

    const page2 = probeRepo.findByTarget(agent.public_key_hash, 2, 2);
    expect(page2).toHaveLength(2);
  });

  it('countProbedAgents counts distinct targets', () => {
    const a1 = makeAgent({ public_key_hash: sha256('pa1') });
    const a2 = makeAgent({ public_key_hash: sha256('pa2') });
    agentRepo.insert(a1);
    agentRepo.insert(a2);

    probeRepo.insert({ target_hash: a1.public_key_hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: 10, failure_reason: null });
    probeRepo.insert({ target_hash: a1.public_key_hash, probed_at: NOW - 100, reachable: 1, latency_ms: 110, hops: 2, estimated_fee_msat: 10, failure_reason: null });
    probeRepo.insert({ target_hash: a2.public_key_hash, probed_at: NOW, reachable: 0, latency_ms: null, hops: null, estimated_fee_msat: null, failure_reason: 'no_route' });

    expect(probeRepo.countProbedAgents()).toBe(2);
  });

  it('purgeOlderThan removes old probes', async () => {
    const agent = makeAgent({ public_key_hash: sha256('purge-probe') });
    agentRepo.insert(agent);

    probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW - 100000, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: 10, failure_reason: null });
    probeRepo.insert({ target_hash: agent.public_key_hash, probed_at: NOW, reachable: 1, latency_ms: 100, hops: 2, estimated_fee_msat: 10, failure_reason: null });

    const purged = await probeRepo.purgeOlderThan(50000);
    expect(purged).toBe(1);

    const remaining = probeRepo.findByTarget(agent.public_key_hash, 10, 0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].probed_at).toBe(NOW);
  });
});

describe('Probe scoring integration', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let probeRepo: ProbeRepository;
  let scoringService: ScoringService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  });

  afterEach(() => db.close());

  it('penalizes unreachable nodes', () => {
    const agent = makeAgent({ public_key_hash: sha256('unreachable-node'), capacity_sats: 5_000_000_000 });
    agentRepo.insert(agent);

    // Score without probe
    const scoreNoprobe = scoringService.computeScore(agent.public_key_hash);

    // Reset snapshot cache
    db.exec('DELETE FROM score_snapshots');

    // Add unreachable probe
    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });

    const scoreWithProbe = scoringService.computeScore(agent.public_key_hash);
    expect(scoreWithProbe.total).toBeLessThan(scoreNoprobe.total);
  });

  it('multi-axis regularity rewards stable latency and stable hops', () => {
    // Stable node: 5 probes, identical latency and hop count → full multi-axis score
    const stableAgent = makeAgent({ public_key_hash: sha256('stable-node'), capacity_sats: 5_000_000_000, last_seen: NOW - 100 * DAY });
    agentRepo.insert(stableAgent);
    for (let i = 0; i < 5; i++) {
      probeRepo.insert({
        target_hash: stableAgent.public_key_hash,
        probed_at: NOW - i * 3600,
        reachable: 1,
        latency_ms: 100,  // perfectly stable
        hops: 2,          // perfectly stable
        estimated_fee_msat: 10,
        failure_reason: null,
      });
    }

    // Jittery node: 5 probes, same uptime, but wildly varying latency and hop counts
    const jitteryAgent = makeAgent({ public_key_hash: sha256('jittery-node'), capacity_sats: 5_000_000_000, last_seen: NOW - 100 * DAY });
    agentRepo.insert(jitteryAgent);
    const jitterLatencies = [100, 800, 200, 1500, 300];
    const jitterHops = [2, 5, 3, 6, 4];
    for (let i = 0; i < 5; i++) {
      probeRepo.insert({
        target_hash: jitteryAgent.public_key_hash,
        probed_at: NOW - i * 3600,
        reachable: 1,
        latency_ms: jitterLatencies[i],
        hops: jitterHops[i],
        estimated_fee_msat: 10,
        failure_reason: null,
      });
    }

    const stableScore = scoringService.computeScore(stableAgent.public_key_hash);
    const jitteryScore = scoringService.computeScore(jitteryAgent.public_key_hash);

    // Multi-axis regularity: uptime*70 + latency_consistency*20 + hop_stability*10
    // Stable: 100%*70 + 1.0*20 + 1.0*10 = 100
    expect(stableScore.components.regularity).toBe(100);
    // Jittery: 100% uptime (70) + very low consistency + low hop stability → well below 100
    expect(jitteryScore.components.regularity).toBeLessThan(85);
    expect(stableScore.components.regularity).toBeGreaterThan(jitteryScore.components.regularity);
  });

  it('100% uptime alone does not max out regularity — stability matters', () => {
    // This is the anti-saturation guarantee: a node that is always reachable but whose
    // route keeps shifting should NOT score 100 on regularity.
    const agent = makeAgent({ public_key_hash: sha256('uptime-only'), capacity_sats: 5_000_000_000, last_seen: NOW - 100 * DAY });
    agentRepo.insert(agent);
    // 6 probes, all reachable, but big hop stddev
    const hops = [2, 5, 2, 6, 2, 6];
    for (let i = 0; i < 6; i++) {
      probeRepo.insert({
        target_hash: agent.public_key_hash,
        probed_at: NOW - i * 3600,
        reachable: 1,
        latency_ms: 100 + i * 200, // also varying
        hops: hops[i],
        estimated_fee_msat: 10,
        failure_reason: null,
      });
    }
    const { components } = scoringService.computeScore(agent.public_key_hash);
    // uptime 100% → 70, but the other axes reduce the total meaningfully
    expect(components.regularity).toBeGreaterThan(70);
    expect(components.regularity).toBeLessThan(95);
  });

  it('ignores stale probe data', () => {
    const agent = makeAgent({ public_key_hash: sha256('stale-probe'), capacity_sats: 5_000_000_000 });
    agentRepo.insert(agent);

    // Add old unreachable probe (> 24h)
    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW - 100_000,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });

    // Score without fresh probe should not be penalized
    const score1 = scoringService.computeScore(agent.public_key_hash);

    // Score a fresh one with no probe repo for comparison
    const scoringNoProbe = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);
    db.exec('DELETE FROM score_snapshots');
    const score2 = scoringNoProbe.computeScore(agent.public_key_hash);

    expect(score1.total).toBe(score2.total);
  });
});

describe('Probe verdict integration', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let attestationRepo: AttestationRepository;
  let snapshotRepo: SnapshotRepository;
  let probeRepo: ProbeRepository;
  let verdictService: VerdictService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const riskService = new RiskService();
    verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo);
  });

  afterEach(() => db.close());

  it('flags unreachable nodes', async () => {
    const agent = makeAgent({ public_key_hash: sha256('unreachable-verdict'), total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });

    const verdict = await verdictService.getVerdict(agent.public_key_hash);
    expect(verdict.flags).toContain('unreachable');
    expect(verdict.verdict).toBe('RISKY');
  });

  it('does not flag unreachable when gossip is fresh and score is high', async () => {
    const agent = makeAgent({
      public_key_hash: sha256('fresh-gossip-unreachable'),
      total_transactions: 500,
      capacity_sats: 10_000_000_000,
      last_seen: NOW - 3600, // 1 hour ago — gossip is fresh
    });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });

    const verdict = await verdictService.getVerdict(agent.public_key_hash);
    // Fresh gossip + high score = positional probe failure, not dead node
    expect(verdict.flags).not.toContain('unreachable');
    expect(verdict.verdict).not.toBe('RISKY');
  });

  it('does not flag reachable nodes', async () => {
    const agent = makeAgent({ public_key_hash: sha256('reachable-verdict'), total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 150,
      hops: 3,
      estimated_fee_msat: 50,
      failure_reason: null,
    });

    const verdict = await verdictService.getVerdict(agent.public_key_hash);
    expect(verdict.flags).not.toContain('unreachable');
  });

  it('returns probe evidence in agent score', () => {
    const agent = makeAgent({ public_key_hash: sha256('probe-evidence'), public_key: '02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' });
    agentRepo.insert(agent);

    probeRepo.insert({
      target_hash: agent.public_key_hash,
      probed_at: NOW,
      reachable: 1,
      latency_ms: 200,
      hops: 4,
      estimated_fee_msat: 75,
      failure_reason: null,
    });

    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo, probeRepo);

    const result = agentService.getAgentScore(agent.public_key_hash);
    expect(result.evidence.probe).not.toBeNull();
    expect(result.evidence.probe!.reachable).toBe(true);
    expect(result.evidence.probe!.latencyMs).toBe(200);
    expect(result.evidence.probe!.hops).toBe(4);
    expect(result.evidence.probe!.estimatedFeeMsat).toBe(75);
    expect(result.evidence.probe!.probedAt).toBe(NOW);
  });

  it('returns null probe evidence when not probed', () => {
    const agent = makeAgent({ public_key_hash: sha256('no-probe-evidence') });
    agentRepo.insert(agent);

    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo, probeRepo);

    const result = agentService.getAgentScore(agent.public_key_hash);
    expect(result.evidence.probe).toBeNull();
  });
});

// --- Mock LND client for pathfinding tests ---
function makeMockLndClient(response: LndQueryRoutesResponse): LndGraphClient {
  return {
    getInfo: async () => ({ synced_to_graph: true, identity_pubkey: '02aaa', alias: 'mock', num_active_channels: 1, num_peers: 1, block_height: 800000 }),
    getGraph: async () => ({ nodes: [], edges: [] }),
    getNodeInfo: async () => null,
    queryRoutes: async (_pubkey: string, _amt: number, _source?: string) => response,
  };
}

const CALLER_PUBKEY = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_PUBKEY = '03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('Personalized pathfinding', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let probeRepo: ProbeRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    probeRepo = new ProbeRepository(db);
  });

  afterEach(() => db.close());

  function buildVerdictService(lndClient?: LndGraphClient): VerdictService {
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const riskService = new RiskService();
    return new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, lndClient);
  }

  it('returns pathfinding result when route exists', async () => {
    const caller = makeAgent({ public_key_hash: sha256(CALLER_PUBKEY), public_key: CALLER_PUBKEY });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const mockClient = makeMockLndClient({
      routes: [{
        total_time_lock: 100,
        total_fees: '5',
        total_fees_msat: '5000',
        total_amt: '1005',
        total_amt_msat: '1005000',
        hops: [
          { chan_id: '1', chan_capacity: '1000000', amt_to_forward: '1000', fee: '3', fee_msat: '3000', pub_key: '02ccc' },
          { chan_id: '2', chan_capacity: '500000', amt_to_forward: '1000', fee: '2', fee_msat: '2000', pub_key: TARGET_PUBKEY },
        ],
      }],
    });

    const verdictService = buildVerdictService(mockClient);
    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    expect(result.pathfinding).not.toBeNull();
    expect(result.pathfinding!.reachable).toBe(true);
    expect(result.pathfinding!.hops).toBe(2);
    expect(result.pathfinding!.estimatedFeeMsat).toBe(5000);
    expect(result.pathfinding!.alternatives).toBe(1);
    expect(result.pathfinding!.source).toBe('lnd_queryroutes');
    expect(result.pathfinding!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.flags).not.toContain('unreachable_from_caller');
  });

  it('flags unreachable_from_caller when no route exists', async () => {
    const caller = makeAgent({ public_key_hash: sha256(CALLER_PUBKEY), public_key: CALLER_PUBKEY });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const mockClient = makeMockLndClient({ routes: [] });
    const verdictService = buildVerdictService(mockClient);
    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    expect(result.pathfinding).not.toBeNull();
    expect(result.pathfinding!.reachable).toBe(false);
    expect(result.pathfinding!.hops).toBeNull();
    expect(result.pathfinding!.estimatedFeeMsat).toBeNull();
    expect(result.flags).toContain('unreachable_from_caller');
  });

  it('live pathfinding overrides stale unreachable probe', async () => {
    const caller = makeAgent({ public_key_hash: sha256(CALLER_PUBKEY), public_key: CALLER_PUBKEY });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    // Stale probe says unreachable
    probeRepo.insert({
      target_hash: target.public_key_hash,
      probed_at: NOW - 3600, // 1 hour ago — within PROBE_FRESHNESS_TTL
      reachable: 0,
      latency_ms: null,
      hops: null,
      estimated_fee_msat: null,
      failure_reason: 'no_route',
    });

    // Live pathfinding says reachable (node came back online)
    const mockClient = makeMockLndClient({
      routes: [{
        total_time_lock: 100, total_fees: '0', total_fees_msat: '0',
        total_amt: '1000', total_amt_msat: '1000000',
        hops: [
          { chan_id: '1', chan_capacity: '1000000', amt_to_forward: '1000', fee: '0', fee_msat: '0', pub_key: TARGET_PUBKEY },
        ],
      }],
    });

    const verdictService = buildVerdictService(mockClient);
    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    // Live overrides stale: unreachable flag must be removed
    expect(result.pathfinding).not.toBeNull();
    expect(result.pathfinding!.reachable).toBe(true);
    expect(result.flags).not.toContain('unreachable');
    // High-score node with live route should be SAFE, not RISKY
    expect(result.verdict).not.toBe('RISKY');
  });

  it('returns null pathfinding when caller has no Lightning pubkey', async () => {
    const caller = makeAgent({ public_key_hash: sha256('hash-only-caller'), public_key: null });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const mockClient = makeMockLndClient({ routes: [] });
    const verdictService = buildVerdictService(mockClient);
    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    expect(result.pathfinding).toBeNull();
  });

  it('returns null pathfinding when no LND client configured', async () => {
    const caller = makeAgent({ public_key_hash: sha256(CALLER_PUBKEY), public_key: CALLER_PUBKEY });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    const verdictService = buildVerdictService(); // no LND client
    const result = await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    expect(result.pathfinding).toBeNull();
  });

  it('returns null pathfinding when caller_pubkey not provided', async () => {
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(target);

    const mockClient = makeMockLndClient({ routes: [] });
    const verdictService = buildVerdictService(mockClient);
    const result = await verdictService.getVerdict(target.public_key_hash);

    expect(result.pathfinding).toBeNull();
  });

  it('caches pathfinding results', async () => {
    const caller = makeAgent({ public_key_hash: sha256(CALLER_PUBKEY), public_key: CALLER_PUBKEY });
    const target = makeAgent({ public_key_hash: sha256(TARGET_PUBKEY), public_key: TARGET_PUBKEY, total_transactions: 500, capacity_sats: 10_000_000_000 });
    agentRepo.insert(caller);
    agentRepo.insert(target);

    let callCount = 0;
    const mockClient: LndGraphClient = {
      ...makeMockLndClient({ routes: [] }),
      queryRoutes: async () => {
        callCount++;
        return { routes: [] };
      },
    };

    const verdictService = buildVerdictService(mockClient);

    await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);
    await verdictService.getVerdict(target.public_key_hash, caller.public_key_hash);

    expect(callCount).toBe(1); // second call should hit cache
  });
});
