// Tests for LND graph crawler, auto-indexation, and batch verdict
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { AttestationService } from '../services/attestationService';
import { StatsService } from '../services/statsService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { AutoIndexService } from '../services/autoIndexService';
import { LndGraphCrawler } from '../crawler/lndGraphCrawler';
import { AgentController } from '../controllers/agentController';
import { AttestationController } from '../controllers/attestationController';
import { HealthController } from '../controllers/healthController';
import { createAgentRoutes } from '../routes/agent';
import { createAttestationRoutes } from '../routes/attestation';
import { createHealthRoutes } from '../routes/health';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandler';
import { sha256 } from '../utils/crypto';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import type { LndGraphClient, LndGetInfoResponse, LndGraph, LndNodeInfo, LndQueryRoutesResponse } from '../crawler/lndGraphClient';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Mock LND client
class MockLndClient implements LndGraphClient {
  syncedToGraph = true;
  nodes: LndGraph['nodes'] = [];
  edges: LndGraph['edges'] = [];
  singleNodes = new Map<string, LndNodeInfo>();

  async getInfo(): Promise<LndGetInfoResponse> {
    return {
      synced_to_graph: this.syncedToGraph,
      identity_pubkey: '02' + 'a'.repeat(64),
      alias: 'TestNode',
      num_active_channels: 10,
      num_peers: 5,
      block_height: 800000,
    };
  }

  async getGraph(): Promise<LndGraph> {
    return { nodes: this.nodes, edges: this.edges };
  }

  async getNodeInfo(pubkey: string): Promise<LndNodeInfo | null> {
    return this.singleNodes.get(pubkey) ?? null;
  }

  async queryRoutes(_pubkey: string, _amountSats: number): Promise<LndQueryRoutesResponse> {
    return { routes: [] };
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(`lnd-test-${Math.random()}`),
    public_key: null,
    alias: 'test-agent',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 50,
    total_attestations_received: 0,
    avg_score: 60,
    capacity_sats: null,
    positive_ratings: 10,
    negative_ratings: 1,
    lnplus_rank: 3,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

describe('LndGraphCrawler', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let mockClient: MockLndClient;
  let crawler: LndGraphCrawler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
    mockClient = new MockLndClient();
    crawler = new LndGraphCrawler(mockClient, agentRepo);
  });

  afterEach(() => { db.close(); });

  it('indexes nodes from graph', async () => {
    const pubkey = '02' + 'b'.repeat(64);
    mockClient.nodes = [{
      pub_key: pubkey,
      alias: 'TestNode1',
      color: '#000000',
      addresses: [],
      last_update: NOW - 100,
    }];
    mockClient.edges = [{
      channel_id: '123',
      chan_point: 'abc:0',
      capacity: '1000000',
      node1_pub: pubkey,
      node2_pub: '03' + 'c'.repeat(64),
      node1_policy: null,
      node2_policy: null,
    }];

    const result = await crawler.run();

    expect(result.syncedToGraph).toBe(true);
    expect(result.nodesFetched).toBe(1);
    expect(result.newAgents).toBe(1);
    expect(result.errors).toHaveLength(0);

    const agent = agentRepo.findByHash(sha256(pubkey));
    expect(agent).toBeDefined();
    expect(agent!.alias).toBe('TestNode1');
    expect(agent!.source).toBe('lightning_graph');
    expect(agent!.public_key).toBe(pubkey);
    expect(agent!.total_transactions).toBe(1); // 1 channel
    expect(agent!.capacity_sats).toBe(1000000);
  });

  it('returns early when not synced to graph', async () => {
    mockClient.syncedToGraph = false;

    const result = await crawler.run();

    expect(result.syncedToGraph).toBe(false);
    expect(result.nodesFetched).toBe(0);
    expect(result.errors).toContain('LND node not synced to graph');
  });

  it('updates existing agents on re-crawl', async () => {
    const pubkey = '02' + 'd'.repeat(64);
    agentRepo.insert({
      ...makeAgent(),
      public_key_hash: sha256(pubkey),
      public_key: pubkey,
      alias: 'OldName',
      source: 'lightning_graph',
      total_transactions: 5,
      capacity_sats: 500000,
    });

    mockClient.nodes = [{
      pub_key: pubkey,
      alias: 'NewName',
      color: '#ffffff',
      addresses: [],
      last_update: NOW,
    }];
    mockClient.edges = [
      { channel_id: '1', chan_point: 'a:0', capacity: '2000000', node1_pub: pubkey, node2_pub: '03' + 'e'.repeat(64), node1_policy: null, node2_policy: null },
      { channel_id: '2', chan_point: 'b:0', capacity: '3000000', node1_pub: pubkey, node2_pub: '03' + 'f'.repeat(64), node1_policy: null, node2_policy: null },
    ];

    const result = await crawler.run();
    expect(result.updatedAgents).toBe(1);

    const updated = agentRepo.findByHash(sha256(pubkey));
    expect(updated!.alias).toBe('NewName');
    expect(updated!.total_transactions).toBe(2); // 2 channels
    expect(updated!.capacity_sats).toBe(5000000); // 2M + 3M
  });

  it('indexes single node for auto-indexation', async () => {
    const pubkey = '02' + 'a1'.repeat(32);
    mockClient.singleNodes.set(pubkey, {
      node: {
        pub_key: pubkey,
        alias: 'SingleNode',
        color: '#111111',
        addresses: [],
        last_update: NOW,
      },
      num_channels: 15,
      total_capacity: '50000000',
    });

    const result = await crawler.indexSingleNode(pubkey);
    expect(result).toBe('created');

    const agent = agentRepo.findByHash(sha256(pubkey));
    expect(agent).toBeDefined();
    expect(agent!.alias).toBe('SingleNode');
    expect(agent!.total_transactions).toBe(15);
    expect(agent!.capacity_sats).toBe(50000000);
  });

  it('returns not_found for unknown node', async () => {
    const result = await crawler.indexSingleNode('02' + 'ff'.repeat(32));
    expect(result).toBe('not_found');
  });
});

describe('AutoIndexService', () => {
  it('identifies Lightning pubkeys (static method)', () => {
    expect(AutoIndexService.isLightningPubkey('02' + 'a'.repeat(64))).toBe(true);
    expect(AutoIndexService.isLightningPubkey('03' + 'b'.repeat(64))).toBe(true);
    expect(AutoIndexService.isLightningPubkey('04' + 'c'.repeat(64))).toBe(false); // wrong prefix
    expect(AutoIndexService.isLightningPubkey('a'.repeat(64))).toBe(false); // no 02/03 prefix
    expect(AutoIndexService.isLightningPubkey('02abc')).toBe(false); // too short
  });

  it('returns false when no LND crawler configured', () => {
    const service = new AutoIndexService(null, {} as AgentRepository, {} as ScoringService, 10);
    const result = service.tryAutoIndex('02' + 'a'.repeat(64));
    expect(result).toBe(false);
  });

  it('rate limits auto-indexation requests', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);

    const mockClient = new MockLndClient();
    // Add nodes so indexSingleNode doesn't fail
    for (let i = 0; i < 15; i++) {
      const pk = '02' + i.toString(16).padStart(2, '0') + 'a'.repeat(62);
      mockClient.singleNodes.set(pk, {
        node: { pub_key: pk, alias: `Node${i}`, color: '#000', addresses: [], last_update: NOW },
        num_channels: 1,
        total_capacity: '100000',
      });
    }

    const crawler = new LndGraphCrawler(mockClient, agentRepo);
    const service = new AutoIndexService(crawler, agentRepo, scoringService, 3); // limit to 3/min

    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const pk = '02' + i.toString(16).padStart(2, '0') + 'a'.repeat(62);
      results.push(service.tryAutoIndex(pk));
    }

    // First 3 should succeed, last 2 should be rate limited
    expect(results.slice(0, 3)).toEqual([true, true, true]);
    expect(results.slice(3)).toEqual([false, false]);

    db.close();
  });
});

describe('Batch verdict endpoint', () => {
  let db: Database.Database;
  let app: express.Express;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const bayesianVerdictService = createBayesianVerdictService(db);
    const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService);
    const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
    const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
    const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), bayesianVerdictService);
    const agentController = new AgentController(agentService, agentRepo, verdictService);
    const attestationController = new AttestationController(attestationService);
    const healthController = new HealthController(statsService);

    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    const { Router } = express;
    const api = Router();
    api.use(createAgentRoutes(agentController));
    api.use(createAttestationRoutes(attestationController));
    api.use(createHealthRoutes(healthController));
    app.use('/api', api);
    app.use(errorHandler);
  });

  afterEach(() => { db.close(); });

  it('POST /api/verdicts returns verdicts for multiple hashes', async () => {
    const agent1 = makeAgent({ public_key_hash: sha256('batch-a1'), alias: 'BatchA1' });
    const agent2 = makeAgent({ public_key_hash: sha256('batch-a2'), alias: 'BatchA2' });
    agentRepo.insert(agent1);
    agentRepo.insert(agent2);

    const res = await request(app)
      .post('/api/verdicts')
      .send({ hashes: [agent1.public_key_hash, agent2.public_key_hash] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].publicKeyHash).toBe(agent1.public_key_hash);
    expect(res.body.data[0].verdict).toBeDefined();
    expect(res.body.data[1].publicKeyHash).toBe(agent2.public_key_hash);
  });

  it('POST /api/verdicts returns INSUFFICIENT for missing hashes', async () => {
    const unknownHash = sha256('definitely-unknown-batch');

    const res = await request(app)
      .post('/api/verdicts')
      .send({ hashes: [unknownHash] });

    expect(res.status).toBe(200);
    expect(res.body.data[0].verdict).toBe('INSUFFICIENT');
  });

  it('POST /api/verdicts rejects empty array', async () => {
    const res = await request(app)
      .post('/api/verdicts')
      .send({ hashes: [] });

    expect(res.status).toBe(400);
  });

  it('POST /api/verdicts rejects invalid hashes', async () => {
    const res = await request(app)
      .post('/api/verdicts')
      .send({ hashes: ['not-a-hash'] });

    expect(res.status).toBe(400);
  });

  it('POST /api/verdicts rejects more than 100 hashes', async () => {
    const hashes = Array.from({ length: 101 }, (_, i) => sha256(`overflow-${i}`));
    const res = await request(app)
      .post('/api/verdicts')
      .send({ hashes });

    expect(res.status).toBe(400);
  });
});

describe('Free attestations verification', () => {
  let db: Database.Database;
  let app: express.Express;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const bayesianVerdictService = createBayesianVerdictService(db);
    const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService);
    const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
    const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
    const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, new RiskService(), bayesianVerdictService);
    const agentController = new AgentController(agentService, agentRepo, verdictService);
    const attestationController = new AttestationController(attestationService);
    const healthController = new HealthController(statsService);

    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    const { Router } = express;
    const api = Router();
    api.use(createAgentRoutes(agentController));
    api.use(createAttestationRoutes(attestationController));
    api.use(createHealthRoutes(healthController));
    app.use('/api', api);
    app.use(errorHandler);
  });

  afterEach(() => { db.close(); });

  it('POST /attestation is NOT L402-gated (uses apiKey auth only)', async () => {
    // In dev mode, apiKey auth passes through when API_KEY is not set
    const attester = makeAgent({ public_key_hash: sha256('free-attester'), alias: 'FreeAttester' });
    const subject = makeAgent({ public_key_hash: sha256('free-subject'), alias: 'FreeSubject' });
    agentRepo.insert(attester);
    agentRepo.insert(subject);

    // Create a transaction for the attestation to reference
    const { v4: uuid } = await import('uuid');
    const txId = uuid();
    db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
      VALUES (?, ?, ?, 'small', ?, ?, null, 'verified', 'bolt11')
    `).run(txId, attester.public_key_hash, subject.public_key_hash, NOW, sha256(txId));

    const res = await request(app)
      .post('/api/attestation')
      .send({
        txId,
        attesterHash: attester.public_key_hash,
        subjectHash: subject.public_key_hash,
        score: 90,
        category: 'successful_transaction',
      });

    // Should succeed without L402 payment (dev mode: no API_KEY required)
    expect(res.status).toBe(201);
    expect(res.body.data.attestationId).toBeDefined();
  });

  it('OpenAPI spec marks attestation as apiKey auth, not L402', async () => {
    // Import the spec
    const { openapiSpec } = await import('../openapi');
    const attestationPath = openapiSpec.paths['/attestations'];
    expect(attestationPath.post.security).toEqual([{ apiKey: [] }]);
    // Should NOT have l402 in security
    expect(attestationPath.post.security).not.toContainEqual({ l402: [] });
  });
});
