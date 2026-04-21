// Phase 5 — /api/intent + /api/intent/categories integration tests.
// Monte le controller derrière un mini-express + supertest et vérifie la
// validation zod, le 400 INVALID_CATEGORY, le format snake_case et le meta.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
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
import { endpointHash } from '../utils/urlCanonical';
import { errorHandler } from '../middleware/errorHandler';
import {
  createBayesianVerdictService,
  seedSafeBayesianObservations,
} from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
let testDb: TestDb;

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

function buildApp(db: Pool, withOperators = false): { app: express.Express; operatorService: OperatorService | null } {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  const probeRepo = new ProbeRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdict, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const operatorService = withOperators
    ? new OperatorService(
        new OperatorRepository(db),
        new OperatorIdentityRepository(db),
        new OperatorOwnershipRepository(db),
        new EndpointStreamingPosteriorRepository(db),
        new NodeStreamingPosteriorRepository(db),
        new ServiceStreamingPosteriorRepository(db),
      )
    : null;
  const intentService = new IntentService({
    serviceEndpointRepo: serviceRepo,
    agentRepo,
    agentService,
    trendService,
    probeRepo,
    ...(operatorService ? { operatorService } : {}),
  });
  const controller = new IntentController(intentService);

  const app = express();
  app.use(express.json());
  app.post('/api/intent', controller.resolve);
  app.get('/api/intent/categories', controller.categories);
  app.use(errorHandler);
  return { app, operatorService };
}

async function seed(db: Pool, hash: string, url: string, opts: {
  name: string;
  category: string;
  priceSats: number;
  safe?: boolean;
}): Promise<void> {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  await agentRepo.insert(makeAgent(hash));
  await serviceRepo.upsert(hash, url, 200, 120, '402index');
  await serviceRepo.updateMetadata(url, {
    name: opts.name, description: null, category: opts.category, provider: null,
  });
  await serviceRepo.updatePrice(url, opts.priceSats);
  if (opts.safe) await seedSafeBayesianObservations(db, hash, { now: NOW });
}

describe('/api/intent integration', async () => {
  let db: Pool;
  let app: express.Express;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    app = buildApp(db).app;
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  describe('GET /api/intent/categories', async () => {
    it('retourne les catégories avec endpoint_count et active_count', async () => {
      await seed(db, sha256('w1'), 'https://weather.example/one', { name: 'w1', category: 'weather', priceSats: 5, safe: true });
      await seed(db, sha256('w2'), 'https://weather.example/two', { name: 'w2', category: 'weather', priceSats: 7 });
      await seed(db, sha256('d1'), 'https://data.example/one', { name: 'd1', category: 'data', priceSats: 3, safe: true });

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

  describe('POST /api/intent', async () => {
    it('retourne les candidats snake_case avec bayesian + advisory + health', async () => {
      await seed(db, sha256('w1'), 'https://weather.example/one', { name: 'paris-forecast', category: 'weather', priceSats: 5, safe: true });

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
      await seed(db, sha256('b1'), 'https://bitcoin.example/x', { name: 'b1', category: 'bitcoin', priceSats: 5, safe: true });
      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'lightning' });
      expect(res.status).toBe(200);
      expect(res.body.intent.category).toBe('bitcoin');
      expect(res.body.candidates).toHaveLength(1);
    });

    it('filtre budget_sats', async () => {
      await seed(db, sha256('cheap'), 'https://x.example/cheap', { name: 'cheap', category: 'tools', priceSats: 3, safe: true });
      await seed(db, sha256('expensive'), 'https://x.example/expensive', { name: 'expensive', category: 'tools', priceSats: 50, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'tools', budget_sats: 10 });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].service_name).toBe('cheap');
    });

    it('filtre keywords AND', async () => {
      await seed(db, sha256('pf'), 'https://x.example/pf', { name: 'paris-forecast', category: 'weather', priceSats: 3, safe: true });
      await seed(db, sha256('lf'), 'https://x.example/lf', { name: 'london-forecast', category: 'weather', priceSats: 3, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'weather', keywords: ['paris', 'forecast'] });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].service_name).toBe('paris-forecast');
    });

    it('strictness=relaxed avec FALLBACK_RELAXED quand aucun SAFE', async () => {
      // Endpoint cold (pas de seedSafe) → verdict INSUFFICIENT → relaxed.
      await seed(db, sha256('cold-api'), 'https://cold.example/api', { name: 'cold', category: 'tools', priceSats: 5 });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'tools' });
      expect(res.status).toBe(200);
      expect(res.body.meta.strictness).toBe('relaxed');
      expect(res.body.meta.warnings).toContain('FALLBACK_RELAXED');
      expect(res.body.candidates).toHaveLength(1);
    });

    it('strictness=degraded avec NO_CANDIDATES quand pool vide', async () => {
      await seed(db, sha256('other'), 'https://other.example/x', { name: 'other', category: 'weather', priceSats: 5, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'weather', budget_sats: 1 }); // budget trop bas → vide
      expect(res.status).toBe(200);
      expect(res.body.meta.strictness).toBe('degraded');
      expect(res.body.meta.warnings).toContain('NO_CANDIDATES');
      expect(res.body.candidates).toEqual([]);
      expect(res.body.meta.total_matched).toBe(0);
    });

    it('tri p_success DESC puis price_sats ASC', async () => {
      // Deux endpoints également SAFE (seedSafe) → tri tertiaire sur price.
      await seed(db, sha256('srt-a'), 'https://s.example/a', { name: 'srt-a', category: 'tools', priceSats: 20, safe: true });
      await seed(db, sha256('srt-b'), 'https://s.example/b', { name: 'srt-b', category: 'tools', priceSats: 3, safe: true });

      const res = await request(app)
        .post('/api/intent')
        .send({ category: 'tools' });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(2);
      expect(res.body.candidates[0].service_name).toBe('srt-b');
      expect(res.body.candidates[0].rank).toBe(1);
      expect(res.body.candidates[1].service_name).toBe('srt-a');
      expect(res.body.candidates[1].rank).toBe(2);
    });

    it('meta contient total_matched + returned + strictness + warnings', async () => {
      for (let i = 0; i < 3; i++) {
        await seed(db, sha256(`x-${i}`), `https://x.example/${i}`, { name: `x-${i}`, category: 'tools', priceSats: i + 1, safe: true });
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

  // Phase 7 — C11 expose operator_id per candidate (verified only), C12 émet
  // OPERATOR_UNVERIFIED pour chaque candidat rattaché à un operator non-verified.
  describe('C11/C12 — operator_id + OPERATOR_UNVERIFIED per candidate', async () => {
    let appWithOps: express.Express;
    let operatorService: OperatorService;

    beforeEach(async () => {
      const wired = buildApp(db, true);
      appWithOps = wired.app;
      operatorService = wired.operatorService!;
    });

    it('operator_id=null and no OPERATOR_UNVERIFIED when candidate endpoint has no operator', async () => {
      await seed(db, sha256('w-no-op'), 'https://w-no-op.example/api', { name: 'w-no-op', category: 'weather', priceSats: 5, safe: true });

      const res = await request(appWithOps)
        .post('/api/intent')
        .send({ category: 'weather' });
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].operator_id).toBeNull();
      const codes = (res.body.candidates[0].advisory.advisories as Array<{ code: string }>).map(a => a.code);
      expect(codes).not.toContain('OPERATOR_UNVERIFIED');
    });

    it('operator_id=null + OPERATOR_UNVERIFIED (info) quand operator rattaché mais pending', async () => {
      const url = 'https://w-pending.example/api';
      await seed(db, sha256('w-pending'), url, { name: 'w-pending', category: 'weather', priceSats: 5, safe: true });
      const opId = 'op-intent-pending';
      await operatorService.upsertOperator(opId);
      await operatorService.claimOwnership(opId, 'endpoint', endpointHash(url));

      const res = await request(appWithOps)
        .post('/api/intent')
        .send({ category: 'weather' });
      expect(res.status).toBe(200);
      const cand = res.body.candidates[0];
      expect(cand.operator_id).toBeNull();
      const adv = (cand.advisory.advisories as Array<{ code: string; level: string; data: { operator_status: string } }>)
        .find(a => a.code === 'OPERATOR_UNVERIFIED');
      expect(adv).toBeDefined();
      expect(adv!.level).toBe('info');
      expect(adv!.data.operator_status).toBe('pending');
    });

    it('operator_id exposé + PAS d\'OPERATOR_UNVERIFIED quand operator verified', async () => {
      const url = 'https://w-verified.example/api';
      await seed(db, sha256('w-verified'), url, { name: 'w-verified', category: 'weather', priceSats: 5, safe: true });
      const opId = 'op-intent-verified';
      await operatorService.upsertOperator(opId);
      await operatorService.claimOwnership(opId, 'endpoint', endpointHash(url));
      await operatorService.claimIdentity(opId, 'dns', 'w-verified.example');
      await operatorService.markIdentityVerified(opId, 'dns', 'w-verified.example', 'proof-dns');
      await operatorService.claimIdentity(opId, 'nip05', 'op@w-verified.example');
      await operatorService.markIdentityVerified(opId, 'nip05', 'op@w-verified.example', 'proof-nip05');

      const res = await request(appWithOps)
        .post('/api/intent')
        .send({ category: 'weather' });
      expect(res.status).toBe(200);
      const cand = res.body.candidates[0];
      expect(cand.operator_id).toBe(opId);
      const codes = (cand.advisory.advisories as Array<{ code: string }>).map(a => a.code);
      expect(codes).not.toContain('OPERATOR_UNVERIFIED');
    });
  });
});
