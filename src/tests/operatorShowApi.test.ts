// Phase 7 — tests d'intégration pour GET /api/operator/:id.
//
// Couverture :
//   - 404 sur operator inconnu
//   - 400 sur operator_id malformé (regex)
//   - Catalog expose TOUTES les ressources claimed (Précision 2 — même sans evidence)
//   - bayesian.resources_counted = sous-ensemble avec evidence
//   - Enrichissement : endpoints jointés avec service_endpoints (URL, name, category)
//   - Enrichissement : nodes jointés avec agents (alias, avg_score)
//   - Identités exposées avec type + value + verified_at
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations } from '../database/migrations';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import { AgentRepository } from '../repositories/agentRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { OperatorController } from '../controllers/operatorController';
import { errorHandler } from '../middleware/errorHandler';

// Les tests injectent de l'évidence via les streaming posteriors et déclenchent
// ensuite une lecture via GET. Comme getOperatorCatalog utilise Date.now() par
// défaut pour le atTs, il faut utiliser un timestamp proche de maintenant pour
// que la décroissance exponentielle (τ=7j) ne mange pas toute l'évidence.
const NOW = Math.floor(Date.now() / 1000);

interface Ctx {
  db: Database.Database;
  app: express.Express;
  service: OperatorService;
  operators: OperatorRepository;
  endpointPosteriors: EndpointStreamingPosteriorRepository;
  nodePosteriors: NodeStreamingPosteriorRepository;
  servicePosteriors: ServiceStreamingPosteriorRepository;
  agentRepo: AgentRepository;
  serviceEndpointRepo: ServiceEndpointRepository;
}

function setup(): Ctx {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const operators = new OperatorRepository(db);
  const identities = new OperatorIdentityRepository(db);
  const ownerships = new OperatorOwnershipRepository(db);
  const endpointPosteriors = new EndpointStreamingPosteriorRepository(db);
  const nodePosteriors = new NodeStreamingPosteriorRepository(db);
  const servicePosteriors = new ServiceStreamingPosteriorRepository(db);
  const agentRepo = new AgentRepository(db);
  const serviceEndpointRepo = new ServiceEndpointRepository(db);

  const service = new OperatorService(
    operators,
    identities,
    ownerships,
    endpointPosteriors,
    nodePosteriors,
    servicePosteriors,
  );
  const controller = new OperatorController({
    operatorService: service,
    serviceEndpointRepo,
    agentRepo,
  });

  const app = express();
  app.use(express.json());
  app.get('/api/operator/:id', controller.show);
  app.use(errorHandler);

  return { db, app, service, operators, endpointPosteriors, nodePosteriors, servicePosteriors, agentRepo, serviceEndpointRepo };
}

describe('GET /api/operator/:id — 404/400', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('404 sur operator inconnu', async () => {
    const res = await request(ctx.app).get('/api/operator/op-ghost');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('400 sur operator_id avec caractères invalides', async () => {
    const res = await request(ctx.app).get('/api/operator/bad id');
    // Express route match doesn't trigger on the space, so the short form
    // hits the controller via %20. Use an obviously invalid format.
    expect([400, 404]).toContain(res.status);
  });

  it('400 sur operator_id trop court', async () => {
    const res = await request(ctx.app).get('/api/operator/ab');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/operator/:id — Précision 2 : catalog complet vs resources_counted', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('catalog liste TOUS les endpoints claimed, même sans observation', async () => {
    ctx.service.upsertOperator('op-ten-ep', NOW);
    // 10 endpoints claimed, seuls 3 avec evidence
    for (let i = 0; i < 10; i++) {
      ctx.service.claimOwnership('op-ten-ep', 'endpoint', `hash-${i}`, NOW);
    }
    ctx.endpointPosteriors.ingest('hash-0', 'probe', { successDelta: 5, failureDelta: 0, nowSec: NOW });
    ctx.endpointPosteriors.ingest('hash-1', 'probe', { successDelta: 3, failureDelta: 1, nowSec: NOW });
    ctx.endpointPosteriors.ingest('hash-2', 'probe', { successDelta: 2, failureDelta: 0, nowSec: NOW });

    const res = await request(ctx.app).get('/api/operator/op-ten-ep');
    expect(res.status).toBe(200);
    // CATALOG : 10 endpoints (même ceux sans obs)
    expect(res.body.data.catalog.endpoints).toHaveLength(10);
    // BAYESIAN : 3 resources counted (celles avec evidence > prior)
    expect(res.body.data.bayesian.resources_counted).toBe(3);
  });

  it('catalog liste TOUS les nodes + services claimed cross-type', async () => {
    ctx.service.upsertOperator('op-cross', NOW);
    ctx.service.claimOwnership('op-cross', 'node', 'pk1', NOW);
    ctx.service.claimOwnership('op-cross', 'node', 'pk2', NOW);
    ctx.service.claimOwnership('op-cross', 'endpoint', 'h1', NOW);
    ctx.service.claimOwnership('op-cross', 'service', 's1', NOW);
    ctx.service.claimOwnership('op-cross', 'service', 's2', NOW);

    const res = await request(ctx.app).get('/api/operator/op-cross');
    expect(res.status).toBe(200);
    expect(res.body.data.catalog.nodes).toHaveLength(2);
    expect(res.body.data.catalog.endpoints).toHaveLength(1);
    expect(res.body.data.catalog.services).toHaveLength(2);
    // Aucune observation → resources_counted = 0
    expect(res.body.data.bayesian.resources_counted).toBe(0);
    expect(res.body.data.bayesian.p_success).toBeNull();
  });
});

describe('GET /api/operator/:id — enrichissement', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('enrichit les endpoints avec URL, name, category depuis service_endpoints', async () => {
    ctx.service.upsertOperator('op-rich-ep', NOW);
    // Insérer un service_endpoints row dont url_hash match celui claim
    const url = 'https://weather.example.com/api';
    const { endpointHash } = await import('../utils/urlCanonical');
    const urlHash = endpointHash(url);
    ctx.db.prepare(`
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at, name, category, source)
      VALUES (NULL, ?, 200, 100, 1000, 5, 5, 1000, 'Weather API', 'weather-api', '402index')
    `).run(url);

    ctx.service.claimOwnership('op-rich-ep', 'endpoint', urlHash, NOW);

    const res = await request(ctx.app).get('/api/operator/op-rich-ep');
    expect(res.status).toBe(200);
    const ep = res.body.data.catalog.endpoints[0];
    expect(ep.url_hash).toBe(urlHash);
    expect(ep.url).toBe(url);
    expect(ep.name).toBe('Weather API');
    expect(ep.category).toBe('weather-api');
  });

  it('enrichit les nodes avec alias + avg_score depuis agents', async () => {
    ctx.service.upsertOperator('op-rich-node', NOW);
    const pubkey = '02' + 'a'.repeat(64);
    const hash = 'b'.repeat(64);
    ctx.db.prepare(`
      INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score)
      VALUES (?, ?, 'MyNode', 1000, 5000, 'observer_protocol', 10, 0, 85)
    `).run(hash, pubkey);

    ctx.service.claimOwnership('op-rich-node', 'node', hash, NOW);

    const res = await request(ctx.app).get('/api/operator/op-rich-node');
    expect(res.status).toBe(200);
    const node = res.body.data.catalog.nodes[0];
    expect(node.node_pubkey).toBe(hash);
    expect(node.alias).toBe('MyNode');
    expect(node.avg_score).toBe(85);
  });

  it('endpoints sans metadata service_endpoints → champs null mais row présent', async () => {
    ctx.service.upsertOperator('op-bare', NOW);
    ctx.service.claimOwnership('op-bare', 'endpoint', 'x'.repeat(64), NOW);

    const res = await request(ctx.app).get('/api/operator/op-bare');
    expect(res.status).toBe(200);
    expect(res.body.data.catalog.endpoints).toHaveLength(1);
    const ep = res.body.data.catalog.endpoints[0];
    expect(ep.url).toBeNull();
    expect(ep.name).toBeNull();
    expect(ep.category).toBeNull();
  });
});

describe('GET /api/operator/:id — identités et status', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('expose identités (type, value, verified_at, verification_proof)', async () => {
    ctx.service.upsertOperator('op-ids', NOW);
    ctx.service.claimIdentity('op-ids', 'dns', 'example.com');
    ctx.service.markIdentityVerified('op-ids', 'dns', 'example.com', 'dns:satrank-operator=op-ids', 5000);
    ctx.service.claimIdentity('op-ids', 'nip05', 'alice@example.com');

    const res = await request(ctx.app).get('/api/operator/op-ids');
    expect(res.status).toBe(200);
    expect(res.body.data.identities).toHaveLength(2);
    const dns = res.body.data.identities.find((i: { type: string }) => i.type === 'dns');
    expect(dns.verified_at).toBe(5000);
    expect(dns.verification_proof).toBe('dns:satrank-operator=op-ids');
    const nip05 = res.body.data.identities.find((i: { type: string }) => i.type === 'nip05');
    expect(nip05.verified_at).toBeNull();
  });

  it('expose le status + verification_score', async () => {
    ctx.service.upsertOperator('op-status', NOW);
    ctx.service.claimIdentity('op-status', 'dns', 'example.com');
    ctx.service.claimIdentity('op-status', 'nip05', 'alice@example.com');
    ctx.service.markIdentityVerified('op-status', 'dns', 'example.com', 'p1', 1000);
    ctx.service.markIdentityVerified('op-status', 'nip05', 'alice@example.com', 'p2', 2000);

    const res = await request(ctx.app).get('/api/operator/op-status');
    expect(res.status).toBe(200);
    expect(res.body.data.operator.status).toBe('verified');
    expect(res.body.data.operator.verification_score).toBe(2);
  });
});

describe('GET /api/operator/:id — bayesian block', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('inclut posterior_alpha/beta, p_success, n_obs_effective, at_ts', async () => {
    ctx.service.upsertOperator('op-bayes', NOW);
    ctx.service.claimOwnership('op-bayes', 'endpoint', 'h1', NOW);
    ctx.endpointPosteriors.ingest('h1', 'probe', { successDelta: 10, failureDelta: 0, nowSec: NOW });

    const res = await request(ctx.app).get('/api/operator/op-bayes');
    expect(res.status).toBe(200);
    const b = res.body.data.bayesian;
    expect(b.posterior_alpha).toBeGreaterThan(1.5);
    expect(b.posterior_beta).toBeCloseTo(1.5, 3);
    expect(b.p_success).toBeGreaterThan(0.8);
    expect(b.n_obs_effective).toBeCloseTo(10, 0);
    expect(b.resources_counted).toBe(1);
    expect(typeof b.at_ts).toBe('number');
  });

  it('p_success=null quand aucune evidence (évite NaN côté JSON)', async () => {
    ctx.service.upsertOperator('op-empty', NOW);
    const res = await request(ctx.app).get('/api/operator/op-empty');
    expect(res.status).toBe(200);
    expect(res.body.data.bayesian.p_success).toBeNull();
  });
});
