// Integration tests for GET /api/endpoint/:url_hash — Bayesian detail view
// for a single HTTP endpoint keyed by sha256(canonicalized URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express, { Router } from 'express';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { EndpointController } from '../controllers/endpointController';
import { errorHandler } from '../middleware/errorHandler';
import { createBayesianVerdictService, ingestBayesianObservation } from './helpers/bayesianTestFactory';
import { endpointHash } from '../utils/urlCanonical';
import { sha256 } from '../utils/crypto';
import { OperatorService } from '../services/operatorService';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';

function buildTestApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const serviceEndpointRepo = new ServiceEndpointRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const operatorService = new OperatorService(
    new OperatorRepository(db),
    new OperatorIdentityRepository(db),
    new OperatorOwnershipRepository(db),
    new EndpointStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new ServiceStreamingPosteriorRepository(db),
  );
  const endpointController = new EndpointController(bayesianVerdict, serviceEndpointRepo, agentRepo, operatorService);

  const app = express();
  app.use(express.json());
  const api = Router();
  api.get('/endpoint/:url_hash', endpointController.show);
  app.use('/api', api);
  app.use(errorHandler);

  return { db, app, agentRepo, serviceEndpointRepo, operatorService };
}

describe('GET /api/endpoint/:url_hash', () => {
  let db: Database.Database;
  let app: express.Express;
  let agentRepo: AgentRepository;
  let serviceEndpointRepo: ServiceEndpointRepository;
  let operatorService: OperatorService;

  beforeAll(() => {
    ({ db, app, agentRepo, serviceEndpointRepo, operatorService } = buildTestApp());
  });

  afterAll(() => { db.close(); });

  it('returns 400 when url_hash is not 64-char lowercase hex', async () => {
    const res = await request(app).get('/api/endpoint/NOT-A-HASH');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns Bayesian block with null metadata when url_hash is unknown', async () => {
    const urlHash = sha256('unknown-url');
    const res = await request(app).get(`/api/endpoint/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.urlHash).toBe(urlHash);
    expect(res.body.data.bayesian).toBeDefined();
    expect(typeof res.body.data.bayesian.p_success).toBe('number');
    expect(['SAFE', 'RISKY', 'UNKNOWN', 'INSUFFICIENT']).toContain(res.body.data.bayesian.verdict);
    expect(res.body.data.bayesian.sources).toBeDefined();
    expect(res.body.data.bayesian.convergence).toBeDefined();
    expect(res.body.data.metadata).toBeNull();
    expect(res.body.data.http).toBeNull();
    expect(res.body.data.node).toBeNull();
    expect(typeof res.body.meta.computedAt).toBe('number');
  });

  it('enriches with metadata + http when url_hash matches a trusted service_endpoints row', async () => {
    const url = 'https://example.com/api';
    const urlHash = endpointHash(url);

    const agent = {
      public_key_hash: sha256('node-op'),
      public_key: null,
      alias: 'node-op',
      first_seen: Math.floor(Date.now() / 1000) - 86400,
      last_seen: Math.floor(Date.now() / 1000),
      source: 'manual' as const,
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
    };
    agentRepo.insert(agent);

    serviceEndpointRepo.upsert(agent.public_key_hash, url, 200, 42, '402index');
    serviceEndpointRepo.updateMetadata(url, {
      name: 'Example API',
      description: 'Test service',
      category: 'weather',
      provider: 'acme',
    });
    serviceEndpointRepo.updatePrice(url, 21);

    const res = await request(app).get(`/api/endpoint/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.urlHash).toBe(urlHash);
    expect(res.body.data.metadata).not.toBeNull();
    expect(res.body.data.metadata.url).toBe(url);
    expect(res.body.data.metadata.name).toBe('Example API');
    expect(res.body.data.metadata.category).toBe('weather');
    expect(res.body.data.metadata.priceSats).toBe(21);
    expect(res.body.data.metadata.source).toBe('402index');
    expect(res.body.data.http).not.toBeNull();
    expect(res.body.data.http.status).toBe(200);
    expect(res.body.data.http.latencyMs).toBe(42);
    expect(res.body.data.node).not.toBeNull();
    expect(res.body.data.node.publicKeyHash).toBe(agent.public_key_hash);
    expect(res.body.data.node.alias).toBe('node-op');
  });

  it('reflects SAFE verdict after enough converging observations are seeded', async () => {
    const url = 'https://safe.example.com/api';
    const urlHash = endpointHash(url);
    // Direct insert (bypass seedSafeBayesianObservations): the endpoint lookup
    // path filters transactions by `endpoint_hash`, which for a URL target is
    // a url_hash (not a pubkey). We need a sender/receiver FK target present
    // in `agents`, but we do not want to force urlHash itself into `agents`.
    const now = Math.floor(Date.now() / 1000);
    const senderHash = sha256('endpoint-test-sender');
    const receiverHash = sha256('endpoint-test-receiver');
    for (const hash of [senderHash, receiverHash]) {
      db.prepare(`INSERT OR IGNORE INTO agents (public_key_hash, first_seen, last_seen, source) VALUES (?, ?, ?, 'manual')`)
        .run(hash, now - 365 * 86400, now);
    }
    const insert = db.prepare(`
      INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, status, protocol, endpoint_hash, source)
      VALUES (?, ?, ?, 'small', ?, ?, 'verified', 'l402', ?, ?)
    `);
    // Le verdict lit désormais dans streaming_posteriors (Phase 3 C9) ; on
    // dual-write pour garder les tests qui lisent raw `transactions` verts
    // ET pour alimenter la source de vérité bayésienne. Tier 'nip98' sur
    // report pour atteindre la convergence (weight 1.0, comme probe).
    for (let i = 0; i < 40; i++) {
      const txId = `endpoint-probe-${i}`;
      const ts = now - i * 60;
      insert.run(txId, senderHash, receiverHash, ts, sha256(txId), urlHash, 'probe');
      ingestBayesianObservation(db, {
        success: true, timestamp: ts, source: 'probe', endpointHash: urlHash,
      });
    }
    for (let i = 0; i < 40; i++) {
      const txId = `endpoint-report-${i}`;
      const ts = now - i * 60;
      insert.run(txId, senderHash, receiverHash, ts, sha256(txId), urlHash, 'report');
      ingestBayesianObservation(db, {
        success: true, timestamp: ts, source: 'report', tier: 'nip98', endpointHash: urlHash,
      });
    }

    const res = await request(app).get(`/api/endpoint/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.bayesian.verdict).toBe('SAFE');
    expect(res.body.data.bayesian.p_success).toBeGreaterThanOrEqual(0.80);
    expect(res.body.data.bayesian.ci95_low).toBeGreaterThanOrEqual(0.65);
    expect(res.body.data.bayesian.convergence.converged).toBe(true);
  });

  it('ignores ad_hoc service_endpoints rows (untrusted URL↔agent bindings)', async () => {
    const url = 'https://adhoc.example.com/api';
    const urlHash = endpointHash(url);
    serviceEndpointRepo.upsert(null, url, 200, 10); // default source = 'ad_hoc'
    const res = await request(app).get(`/api/endpoint/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.metadata).toBeNull();
    expect(res.body.data.http).toBeNull();
  });

  // Phase 7 — C11 expose operator_id seulement quand status='verified' ;
  // C12 émet l'advisory OPERATOR_UNVERIFIED pour pending/rejected, jamais
  // pour verified. Vérifie aussi qu'un endpoint sans ownership n'a aucune
  // trace d'operator (ni dans data.operator_id, ni dans advisories).
  describe('C11/C12 — operator_id + OPERATOR_UNVERIFIED advisory', () => {
    it('omits operator_id and OPERATOR_UNVERIFIED when endpoint has no operator claim', async () => {
      const url = 'https://no-operator.example.com/api';
      const urlHash = endpointHash(url);
      const res = await request(app).get(`/api/endpoint/${urlHash}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operator_id).toBeNull();
      const codes = (res.body.data.advisory.advisories as Array<{ code: string }>).map(a => a.code);
      expect(codes).not.toContain('OPERATOR_UNVERIFIED');
    });

    it('emits OPERATOR_UNVERIFIED advisory (info) when ownership claimed but status=pending', async () => {
      const url = 'https://pending-op.example.com/api';
      const urlHash = endpointHash(url);
      const operatorId = 'op-pending-endpoint';
      operatorService.upsertOperator(operatorId);
      operatorService.claimOwnership(operatorId, 'endpoint', urlHash);

      const res = await request(app).get(`/api/endpoint/${urlHash}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operator_id).toBeNull(); // C11 — hidden until verified
      const adv = (res.body.data.advisory.advisories as Array<{ code: string; level: string; data: { operator_status: string } }>)
        .find(a => a.code === 'OPERATOR_UNVERIFIED');
      expect(adv).toBeDefined();
      expect(adv!.level).toBe('info');
      expect(adv!.data.operator_status).toBe('pending');
    });

    it('emits OPERATOR_UNVERIFIED advisory (warning) when operator was explicitly rejected', async () => {
      const url = 'https://rejected-op.example.com/api';
      const urlHash = endpointHash(url);
      const operatorId = 'op-rejected-endpoint';
      operatorService.upsertOperator(operatorId);
      operatorService.claimOwnership(operatorId, 'endpoint', urlHash);
      // Rejected set via repo (no public setter) — simulates admin decision.
      db.prepare(`UPDATE operators SET status='rejected' WHERE operator_id = ?`).run(operatorId);

      const res = await request(app).get(`/api/endpoint/${urlHash}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operator_id).toBeNull();
      const adv = (res.body.data.advisory.advisories as Array<{ code: string; level: string; data: { operator_status: string } }>)
        .find(a => a.code === 'OPERATOR_UNVERIFIED');
      expect(adv).toBeDefined();
      expect(adv!.level).toBe('warning');
      expect(adv!.data.operator_status).toBe('rejected');
    });

    it('exposes operator_id and SUPPRESSES OPERATOR_UNVERIFIED when operator is verified', async () => {
      const url = 'https://verified-op.example.com/api';
      const urlHash = endpointHash(url);
      const operatorId = 'op-verified-endpoint';
      operatorService.upsertOperator(operatorId);
      operatorService.claimOwnership(operatorId, 'endpoint', urlHash);
      // Seed 2/3 verified identities → triggers status='verified' recompute.
      operatorService.claimIdentity(operatorId, 'dns', 'verified-op.example.com');
      operatorService.markIdentityVerified(operatorId, 'dns', 'verified-op.example.com', 'proof-dns-1');
      operatorService.claimIdentity(operatorId, 'nip05', 'alice@verified-op.example.com');
      operatorService.markIdentityVerified(operatorId, 'nip05', 'alice@verified-op.example.com', 'proof-nip05-1');

      const res = await request(app).get(`/api/endpoint/${urlHash}`);
      expect(res.status).toBe(200);
      expect(res.body.data.operator_id).toBe(operatorId);
      const codes = (res.body.data.advisory.advisories as Array<{ code: string }>).map(a => a.code);
      expect(codes).not.toContain('OPERATOR_UNVERIFIED');
    });
  });
});
