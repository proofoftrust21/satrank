// Phase 5 — /api/intent + /api/intent/categories integration tests.
// Monte le controller derrière un mini-express + supertest et vérifie la
// validation zod, le 400 INVALID_CATEGORY, le format snake_case et le meta.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { TrendService } from '../services/trendService';
import { AgentService } from '../services/agentService';
import { IntentService } from '../services/intentService';
import { IntentController } from '../controllers/intentController';
import { errorHandler } from '../middleware/errorHandler';
import {
  createBayesianVerdictService,
  seedSafeBayesianObservations,
} from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: `02${hash.slice(0, 64)}`,
    alias: 'operator',
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 50,
    total_attestations_received: 0,
    avg_score: 70,
    capacity_sats: null,
    positive_ratings: 10,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

function buildApp(db: Database.Database): express.Express {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  const probeRepo = new ProbeRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdict, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const intentService = new IntentService({
    serviceEndpointRepo: serviceRepo,
    agentRepo,
    agentService,
    trendService,
    probeRepo,
  });
  const controller = new IntentController(intentService);

  const app = express();
  app.use(express.json());
  app.post('/api/intent', controller.resolve);
  app.get('/api/intent/categories', controller.categories);
  app.use(errorHandler);
  return app;
}

function seed(db: Database.Database, hash: string, url: string, opts: {
  name: string;
  category: string;
  priceSats: number;
  safe?: boolean;
}): void {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  agentRepo.insert(makeAgent(hash));
  serviceRepo.upsert(hash, url, 200, 120, '402index');
  serviceRepo.updateMetadata(url, {
    name: opts.name, description: null, category: opts.category, provider: null,
  });
  serviceRepo.updatePrice(url, opts.priceSats);
  if (opts.safe) seedSafeBayesianObservations(db, hash, { now: NOW });
}

describe('/api/intent integration', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = buildApp(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('GET /api/intent/categories', () => {
    it('retourne les catégories avec endpoint_count et active_count', async () => {
      seed(db, sha256('w1'), 'https://weather.example/one', { name: 'w1', category: 'weather', priceSats: 5, safe: true });
      seed(db, sha256('w2'), 'https://weather.example/two', { name: 'w2', category: 'weather', priceSats: 7 });
      seed(db, sha256('d1'), 'https://data.example/one', { name: 'd1', category: 'data', priceSats: 3, safe: true });

      const res = await request(app).get('/api/intent/categories');
      expect(res.status).toBe(200);
      const weather = res.body.categories.find((c: { name: string }) => c.name === 'weather');
      expect(weather).toBeDefined();
      expect(weather.endpoint_count).toBe(2);
      // active_count nécessite ≥3 probes ; ici check_count = 1 donc 0.
      expect(weather.active_count).toBe(0);
      const data = res.body.categories.find((c: { name: string }) => c.name === 'data');
      expect(data).toBeDefined();
      expect(data.endpoint_count).toBe(1);
    });

    it('retourne un tableau vide si aucune catégorie', async () => {
      const res = await request(app).get('/api/intent/categories');
      expect(res.status).toBe(200);
      expect(res.body.categories).toEqual([]);
    });
  });

  describe('POST /api/intent', () => {
    it('retourne les candidats snake_case avec bayesian + advisory + health', async () => {
      seed(db, sha256('w1'), 'https://weather.example/one', { name: 'paris-forecast', category: 'weather', priceSats: 5, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'weather', caller: 'test-caller' });

      expect(res.status).toBe(200);
      expect(res.body.intent.category).toBe('weather');
      expect(res.body.intent.resolved_at).toBeGreaterThan(0);
      expect(res.body.candidates).toHaveLength(1);
      const c = res.body.candidates[0];
      expect(c.rank).toBe(1);
      expect(c.endpoint_url).toBe('https://weather.example/one');
      expect(c.endpoint_hash).toBeDefined();
      expect(c.service_name).toBe('paris-forecast');
      expect(c.price_sats).toBe(5);
      expect(c.bayesian).toBeDefined();
      expect(c.advisory).toBeDefined();
      expect(c.health).toBeDefined();
      expect(res.body.meta.strictness).toBe('strict');
    });

    it('400 INVALID_CATEGORY_FORMAT si format invalide', async () => {
      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'UPPERCASE!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('400 INVALID_CATEGORY si catégorie inconnue du pool trusted', async () => {
      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'nonexistent-cat' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CATEGORY');
    });

    it('normalise la catégorie via alias (ex. lightning → bitcoin)', async () => {
      seed(db, sha256('b1'), 'https://bitcoin.example/x', { name: 'b1', category: 'bitcoin', priceSats: 5, safe: true });
      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'lightning' });
      expect(res.status).toBe(200);
      expect(res.body.intent.category).toBe('bitcoin');
      expect(res.body.candidates).toHaveLength(1);
    });

    it('filtre budget_sats', async () => {
      seed(db, sha256('cheap'), 'https://x.example/cheap', { name: 'cheap', category: 'tools', priceSats: 3, safe: true });
      seed(db, sha256('expensive'), 'https://x.example/expensive', { name: 'expensive', category: 'tools', priceSats: 50, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'tools', budget_sats: 10 });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].service_name).toBe('cheap');
    });

    it('filtre keywords AND', async () => {
      seed(db, sha256('pf'), 'https://x.example/pf', { name: 'paris-forecast', category: 'weather', priceSats: 3, safe: true });
      seed(db, sha256('lf'), 'https://x.example/lf', { name: 'london-forecast', category: 'weather', priceSats: 3, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'weather', keywords: ['paris', 'forecast'] });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].service_name).toBe('paris-forecast');
    });

    it('meta contient total_matched + returned + strictness + warnings', async () => {
      for (let i = 0; i < 3; i++) {
        seed(db, sha256(`x-${i}`), `https://x.example/${i}`, { name: `x-${i}`, category: 'tools', priceSats: i + 1, safe: true });
      }

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'tools', limit: 2 });
      expect(res.status).toBe(200);
      expect(res.body.meta.total_matched).toBe(3);
      expect(res.body.meta.returned).toBe(2);
      expect(res.body.meta.strictness).toBe('strict');
      expect(res.body.meta.warnings).toEqual([]);
    });
  });
});
