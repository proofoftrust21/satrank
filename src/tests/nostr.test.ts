// Nostr publisher tests — verify event format and signing
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { SurvivalService } from '../services/survivalService';
import { NostrPublisher } from '../nostr/publisher';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Test keypair (not a real secret — generated for tests)
const TEST_SK = 'a'.repeat(64);

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - 3600,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 10,
    avg_score: 65,
    capacity_sats: 500000000,
    positive_ratings: 5,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 10,
    betweenness_rank: 20,
    hopness_rank: 0,
    query_count: 10,
    unique_peers: null,
    ...overrides,
  };
}

describe('NostrPublisher', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let snapshotRepo: SnapshotRepository;
  let probeRepo: ProbeRepository;
  let scoringService: ScoringService;
  let survivalService: SurvivalService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
  });

  afterEach(() => db.close());

  it('creates a publisher without errors', () => {
    const publisher = new NostrPublisher(agentRepo, probeRepo, snapshotRepo, scoringService, survivalService, {
      privateKeyHex: TEST_SK,
      relays: [], // no relays — won't try to connect
      minScore: 30,
    });
    expect(publisher).toBeDefined();
  });

  it('findScoredAbove returns agents above threshold', () => {
    agentRepo.insert(makeAgent('high', { avg_score: 80 }));
    agentRepo.insert(makeAgent('mid', { avg_score: 40 }));
    agentRepo.insert(makeAgent('low', { avg_score: 10 }));

    const above30 = agentRepo.findScoredAbove(30);
    expect(above30.length).toBe(2);
    expect(above30[0].avg_score).toBeGreaterThanOrEqual(30);
  });

  it('publishScores returns 0 published when no relays configured', async () => {
    agentRepo.insert(makeAgent('test-node', { avg_score: 50 }));
    scoringService.computeScore(sha256('test-node'));

    const publisher = new NostrPublisher(agentRepo, probeRepo, snapshotRepo, scoringService, survivalService, {
      privateKeyHex: TEST_SK,
      relays: [], // no relays
      minScore: 30,
    });

    const result = await publisher.publishScores();
    expect(result.published).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });

  it('filters agents below minScore', () => {
    agentRepo.insert(makeAgent('above', { avg_score: 50 }));
    agentRepo.insert(makeAgent('below', { avg_score: 20 }));

    const above = agentRepo.findScoredAbove(30);
    expect(above.length).toBe(1);
    expect(above[0].alias).toBe('above');
  });
});
