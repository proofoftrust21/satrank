// Phase 5.7 — cross-route Bayesian consistency tests.
//
// Sim 4 surfaced that /api/services and /api/services/best returned the
// operator-keyed Bayesian collapse (every endpoint of one operator showing
// p_success=0.923, n_obs=16.495) while /api/intent and /api/services/:hash
// correctly returned per-endpoint posteriors. Phase 5.7 fixed the
// propagation gap; these tests assert that the bug cannot silently come
// back: for the same endpoint URL, every Bayesian-consuming route must
// return identical p_success.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { TrendService } from '../services/trendService';
import { AgentService } from '../services/agentService';
import { IntentService } from '../services/intentService';
import { ServiceController } from '../controllers/serviceController';
import { IntentController } from '../controllers/intentController';
import { EndpointController } from '../controllers/endpointController';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import { endpointHash } from '../utils/urlCanonical';
import type { Agent } from '../types';

let testDb: TestDb;
const NOW = Math.floor(Date.now() / 1000);

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash, public_key: `02${hash.slice(0, 64)}`, alias: 'op',
    first_seen: NOW - 365 * 86400, last_seen: NOW - 60, source: 'attestation',
    total_transactions: 50, total_attestations_received: 0, avg_score: 70,
    capacity_sats: null, positive_ratings: 10, negative_ratings: 0,
    lnplus_rank: 3, hubness_rank: 0, betweenness_rank: 0, hopness_rank: 0,
    unique_peers: null, last_queried_at: null, query_count: 0,
  };
}

interface SeedFixture {
  agentHash: string;
  url: string;
  category: string;
  alpha: number;
  beta: number;
  totalIngestions: number;
  sources?: string[];
  consumption_type?: string;
  provider_contact?: string;
}

async function seed(db: Pool, agentRepo: AgentRepository, repo: ServiceEndpointRepository, f: SeedFixture): Promise<void> {
  await agentRepo.insert(makeAgent(f.agentHash));
  await repo.upsert(f.agentHash, f.url, 200, 200, '402index');
  await repo.updateMetadata(f.url, {
    name: f.url, description: null, category: f.category, provider: null,
  });
  await repo.updatePrice(f.url, 5);
  await db.query(
    'UPDATE service_endpoints SET check_count = $1, success_count = $2, last_checked_at = $3 WHERE url = $4',
    [Math.round(f.alpha + f.beta), Math.round(f.alpha), NOW - 30, f.url],
  );
  if (f.sources != null) {
    await db.query('UPDATE service_endpoints SET sources = $1 WHERE url = $2', [f.sources, f.url]);
  }
  if (f.consumption_type != null) {
    await db.query('UPDATE service_endpoints SET consumption_type = $1 WHERE url = $2', [f.consumption_type, f.url]);
  }
  if (f.provider_contact != null) {
    await db.query('UPDATE service_endpoints SET provider_contact = $1 WHERE url = $2', [f.provider_contact, f.url]);
  }
  await db.query(
    `INSERT INTO endpoint_streaming_posteriors
       (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
     VALUES ($1, 'probe', $2, $3, $4, $5)
     ON CONFLICT (url_hash, source) DO UPDATE SET
       posterior_alpha = EXCLUDED.posterior_alpha,
       posterior_beta = EXCLUDED.posterior_beta,
       last_update_ts = EXCLUDED.last_update_ts,
       total_ingestions = EXCLUDED.total_ingestions`,
    [endpointHash(f.url), f.alpha, f.beta, NOW, f.totalIngestions],
  );
}

function buildApp(db: Pool): express.Express {
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
    bayesianVerdictService: bayesianVerdict,
    trendService,
    probeRepo,
    now: () => NOW,
  });

  const intentController = new IntentController(intentService);
  // Phase 5.7 — service controller now wires bayesianVerdictService.
  const serviceController = new ServiceController(serviceRepo, agentRepo, agentService, bayesianVerdict);
  const endpointController = new EndpointController(bayesianVerdict, serviceRepo, agentRepo);

  const app = express();
  app.use(express.json());
  app.post('/api/intent', intentController.resolve);
  app.get('/api/services', serviceController.search);
  app.get('/api/services/best', serviceController.best);
  app.get('/api/endpoint/:url_hash', endpointController.show);
  app.get('/api/services/:url_hash', endpointController.show);
  return app;
}

describe('Phase 5.7 — cross-route Bayesian consistency', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let serviceRepo: ServiceEndpointRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    db = testDb.pool;
    agentRepo = new AgentRepository(db);
    serviceRepo = new ServiceEndpointRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('GET /api/services returns per-endpoint Bayesian (NOT operator-keyed collapse)', async () => {
    // Three endpoints under the same operator with distinct posteriors.
    const op = sha256('xop');
    const fixtures = [
      { url: 'https://x.example/a', alpha: 9, beta: 1 },   // p ≈ 0.9
      { url: 'https://x.example/b', alpha: 5, beta: 5 },   // p = 0.5
      { url: 'https://x.example/c', alpha: 1, beta: 9 },   // p ≈ 0.1
    ];
    let first = true;
    for (const f of fixtures) {
      if (first) {
        await seed(db, agentRepo, serviceRepo, {
          agentHash: op, url: f.url, category: 'data',
          alpha: f.alpha, beta: f.beta, totalIngestions: f.alpha + f.beta,
        });
        first = false;
      } else {
        await serviceRepo.upsert(op, f.url, 200, 200, '402index');
        await serviceRepo.updateMetadata(f.url, { name: 'x', description: null, category: 'data', provider: null });
        await serviceRepo.updatePrice(f.url, 5);
        await db.query('UPDATE service_endpoints SET check_count = $1, success_count = $2, last_checked_at = $3 WHERE url = $4', [f.alpha + f.beta, f.alpha, NOW - 30, f.url]);
        await db.query(
          `INSERT INTO endpoint_streaming_posteriors (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
           VALUES ($1, 'probe', $2, $3, $4, $5)
           ON CONFLICT (url_hash, source) DO UPDATE SET posterior_alpha = EXCLUDED.posterior_alpha, posterior_beta = EXCLUDED.posterior_beta, last_update_ts = EXCLUDED.last_update_ts, total_ingestions = EXCLUDED.total_ingestions`,
          [endpointHash(f.url), f.alpha, f.beta, NOW, f.alpha + f.beta],
        );
      }
    }

    const app = buildApp(db);
    const r = await request(app).get('/api/services?category=data&limit=10');
    expect(r.status).toBe(200);
    const items = r.body.data;
    expect(items.length).toBe(3);

    const distinctP = new Set(items.map((s: { node: { bayesian: { p_success: number } } }) =>
      Math.round(s.node.bayesian.p_success * 1000) / 1000,
    ));
    // Pre-Phase-5.7 this would have been 1 (all candidates 0.923).
    expect(distinctP.size).toBe(3);
  });

  it('GET /api/services/best ranks bestQuality by per-endpoint p_success', async () => {
    const op = sha256('bestop');
    // 3 candidates same operator, distinct posteriors. bestQuality should pick
    // the highest p_success — pre-Phase-5.7 this was random because all three
    // showed identical Bayesian numbers.
    const fixtures = [
      { url: 'https://b.example/low',  alpha: 2, beta: 8 },
      { url: 'https://b.example/mid',  alpha: 5, beta: 5 },
      { url: 'https://b.example/high', alpha: 9, beta: 1 },
    ];
    let first = true;
    for (const f of fixtures) {
      if (first) {
        await seed(db, agentRepo, serviceRepo, { agentHash: op, url: f.url, category: 'data', alpha: f.alpha, beta: f.beta, totalIngestions: f.alpha + f.beta });
        first = false;
      } else {
        await serviceRepo.upsert(op, f.url, 200, 200, '402index');
        await serviceRepo.updateMetadata(f.url, { name: 'b', description: null, category: 'data', provider: null });
        await serviceRepo.updatePrice(f.url, 5);
        await db.query('UPDATE service_endpoints SET check_count = $1, success_count = $2, last_checked_at = $3 WHERE url = $4', [f.alpha + f.beta, f.alpha, NOW - 30, f.url]);
        await db.query(
          `INSERT INTO endpoint_streaming_posteriors (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
           VALUES ($1, 'probe', $2, $3, $4, $5)
           ON CONFLICT (url_hash, source) DO UPDATE SET posterior_alpha = EXCLUDED.posterior_alpha, posterior_beta = EXCLUDED.posterior_beta, last_update_ts = EXCLUDED.last_update_ts, total_ingestions = EXCLUDED.total_ingestions`,
          [endpointHash(f.url), f.alpha, f.beta, NOW, f.alpha + f.beta],
        );
      }
    }

    const app = buildApp(db);
    const r = await request(app).get('/api/services/best?category=data');
    expect(r.status).toBe(200);
    if (r.body.data.bestQuality) {
      // bestQuality must be the highest-p_success candidate, not arbitrary.
      expect(r.body.data.bestQuality.url).toBe('https://b.example/high');
    }
  });

  it('GET /api/services and /api/intent return identical p_success for the same endpoint', async () => {
    const op = sha256('cross');
    const url = 'https://cross.example/api';
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url, category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
    });
    const app = buildApp(db);

    const sR = await request(app).get('/api/services?category=data&limit=10');
    const iR = await request(app).post('/api/intent').send({ category: 'data', limit: 5 });

    const sRow = sR.body.data.find((s: { url: string }) => s.url === url);
    const iRow = iR.body.candidates.find((c: { endpoint_url: string }) => c.endpoint_url === url);

    expect(sRow).toBeDefined();
    expect(iRow).toBeDefined();
    // Same data layer, same hash → must be the same Bayesian posterior.
    expect(Math.round(sRow.node.bayesian.p_success * 1000)).toBe(
      Math.round(iRow.bayesian.p_success * 1000),
    );
    expect(Math.round(sRow.node.bayesian.n_obs * 100)).toBe(
      Math.round(iRow.bayesian.n_obs * 100),
    );
  });

  it('GET /api/services exposes sources / consumption_type / provider_contact when populated', async () => {
    const op = sha256('meta-svc');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://meta.example/api', category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
      sources: ['402index', 'l402directory'],
      consumption_type: 'api_response',
      provider_contact: '@LnHyper',
    });
    const app = buildApp(db);
    const r = await request(app).get('/api/services?category=data&limit=10');
    expect(r.status).toBe(200);
    const row = r.body.data[0];
    expect(row.sources).toEqual(['402index', 'l402directory']);
    expect(row.consumption_type).toBe('api_response');
    expect(row.provider_contact).toBe('@LnHyper');
  });

  it('GET /api/services exposes single-source sources[]; omits consumption_type / provider_contact when null', async () => {
    // Audit 2026-04-29 — single-source rows used to omit `sources` "for clean
    // payloads", which left agents without any attribution. Now the array is
    // always surfaced (the upsert seeds it with the registry source name);
    // consumption_type / provider_contact stay undefined when the upstream
    // doesn't expose them.
    const op = sha256('clean-svc');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://clean.example/api', category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
      // No sources/consumption_type/provider_contact passed — sources[] still
      // holds whatever upsert injected (here '402index' per seed helper).
    });
    const app = buildApp(db);
    const r = await request(app).get('/api/services?category=data&limit=10');
    expect(r.status).toBe(200);
    const row = r.body.data[0];
    expect(row.sources).toEqual(['402index']);
    expect(row.consumption_type).toBeUndefined();
    expect(row.provider_contact).toBeUndefined();
  });

  it('GET /api/services exposes lastProbeAgeSec and medianLatencyMs', async () => {
    const op = sha256('age-svc');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://age.example/api', category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
    });
    await db.query('UPDATE service_endpoints SET last_latency_ms = $1 WHERE url = $2', [421, 'https://age.example/api']);
    const app = buildApp(db);
    const r = await request(app).get('/api/services?category=data&limit=10');
    expect(r.status).toBe(200);
    const row = r.body.data[0];
    expect(row.lastProbeAgeSec).toBeGreaterThanOrEqual(0);
    expect(row.lastProbeAgeSec).toBeLessThan(120);
    expect(row.medianLatencyMs).toBe(421);
  });

  it('GET /api/services/:hash exposes sources / consumption_type / provider_contact', async () => {
    const op = sha256('det-meta');
    const url = 'https://det.example/api';
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url, category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
      sources: ['402index', 'l402directory'],
      consumption_type: 'api_response',
      provider_contact: '@LnHyper',
    });
    const app = buildApp(db);
    const r = await request(app).get(`/api/services/${endpointHash(url)}`);
    expect(r.status).toBe(200);
    expect(r.body.data.metadata.sources).toEqual(['402index', 'l402directory']);
    expect(r.body.data.metadata.consumption_type).toBe('api_response');
    expect(r.body.data.metadata.provider_contact).toBe('@LnHyper');
  });

  it('GET /api/services/:hash exposes medianLatencyMs and lastProbeAgeSec on http block', async () => {
    const op = sha256('det-age');
    const url = 'https://det-age.example/api';
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url, category: 'data',
      alpha: 7, beta: 3, totalIngestions: 10,
    });
    await db.query('UPDATE service_endpoints SET last_latency_ms = $1 WHERE url = $2', [333, url]);
    const app = buildApp(db);
    const r = await request(app).get(`/api/services/${endpointHash(url)}`);
    expect(r.status).toBe(200);
    expect(r.body.data.http.medianLatencyMs).toBe(333);
    expect(r.body.data.http.lastProbeAgeSec).toBeGreaterThanOrEqual(0);
    expect(r.body.data.http.lastProbeAgeSec).toBeLessThan(120);
  });
});
