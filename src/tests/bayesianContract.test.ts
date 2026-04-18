// Contract tests pour GET /api/bayesian/:target — shape canonique Phase 3.
// Vérifie que la réponse respecte strictement le contrat OpenAPI :
//   - champs racine : p_success, ci95_low, ci95_high, n_obs, verdict, window
//   - sources : { probe, report, paid } avec chaque entrée null-safe
//   - convergence : { converged, sources_above_threshold, threshold }
//   - prior_source : operator | service | flat

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { runMigrations } from '../database/migrations';
import {
  EndpointAggregateRepository,
  ServiceAggregateRepository,
  OperatorAggregateRepository,
  NodeAggregateRepository,
  RouteAggregateRepository,
} from '../repositories/aggregatesRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
import { BayesianController } from '../controllers/bayesianController';
import { createBayesianRoutes } from '../routes/bayesian';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandler';

const NOW = Math.floor(Date.now() / 1000);

function buildApp() {
  const db = new Database(':memory:');
  // FK relaxée ici pour ne pas devoir insérer des agents bidon — le contrat
  // teste l'endpoint qui lit la table transactions en mode read-through.
  db.pragma('foreign_keys = OFF');
  runMigrations(db);

  const endpointRepo = new EndpointAggregateRepository(db);
  const serviceRepo = new ServiceAggregateRepository(db);
  const operatorRepo = new OperatorAggregateRepository(db);
  const nodeRepo = new NodeAggregateRepository(db);
  const routeRepo = new RouteAggregateRepository(db);
  const bayesian = new BayesianScoringService(endpointRepo, serviceRepo, operatorRepo, nodeRepo, routeRepo);
  const verdictService = new BayesianVerdictService(db, bayesian);
  const controller = new BayesianController(verdictService);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api', createBayesianRoutes(controller));
  app.use(errorHandler);

  return { app, db, bayesian };
}

function insertTx(db: Database.Database, overrides: Partial<{ tx_id: string; status: string; source: string; endpoint_hash: string; timestamp: number }>) {
  const tx = {
    tx_id: overrides.tx_id ?? 'tx-' + Math.random().toString(36).slice(2, 10),
    sender_hash: 'a'.repeat(64),
    receiver_hash: 'b'.repeat(64),
    amount_bucket: 'medium',
    timestamp: overrides.timestamp ?? NOW,
    payment_hash: 'p'.repeat(64),
    preimage: null as string | null,
    status: overrides.status ?? 'verified',
    protocol: 'l402',
    endpoint_hash: overrides.endpoint_hash ?? 'endpoint-test',
    operator_id: null,
    source: overrides.source ?? 'probe',
    window_bucket: '2026-04-18',
  };
  db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
                              payment_hash, preimage, status, protocol,
                              endpoint_hash, operator_id, source, window_bucket)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tx.tx_id, tx.sender_hash, tx.receiver_hash, tx.amount_bucket, tx.timestamp,
    tx.payment_hash, tx.preimage, tx.status, tx.protocol,
    tx.endpoint_hash, tx.operator_id, tx.source, tx.window_bucket,
  );
}

describe('GET /api/bayesian/:target — shape canonique', () => {
  let env: ReturnType<typeof buildApp>;
  beforeEach(() => { env = buildApp(); });
  afterEach(() => { env.db.close(); });

  it('retourne 200 avec le shape complet même sans données (INSUFFICIENT)', async () => {
    const res = await request(env.app).get('/api/bayesian/empty-target');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      target: 'empty-target',
      verdict: 'INSUFFICIENT',
      prior_source: 'flat',
    });
    expect(typeof res.body.p_success).toBe('number');
    expect(typeof res.body.ci95_low).toBe('number');
    expect(typeof res.body.ci95_high).toBe('number');
    expect(typeof res.body.n_obs).toBe('number');
    expect(['24h', '7d', '30d']).toContain(res.body.window);
    expect(res.body.sources).toEqual({ probe: null, report: null, paid: null });
    expect(res.body.convergence).toMatchObject({
      converged: false,
      sources_above_threshold: [],
      threshold: 0.80,
    });
    expect(typeof res.body.computed_at).toBe('number');
  });

  it('retourne sources.probe peuplé quand il y a des probes', async () => {
    for (let i = 0; i < 25; i++) {
      insertTx(env.db, { endpoint_hash: 'probe-target', status: 'verified', source: 'probe' });
    }
    const res = await request(env.app).get('/api/bayesian/probe-target');
    expect(res.status).toBe(200);
    expect(res.body.sources.probe).not.toBeNull();
    expect(res.body.sources.probe.p_success).toBeGreaterThan(0.5);
    expect(res.body.sources.probe.n_obs).toBeCloseTo(25, 0);
    expect(res.body.sources.report).toBeNull();
    expect(res.body.sources.paid).toBeNull();
  });

  it('retourne verdict SAFE quand ≥ 2 sources convergent au-dessus du seuil', async () => {
    for (let i = 0; i < 20; i++) {
      insertTx(env.db, { endpoint_hash: 'safe-target', status: 'verified', source: 'probe' });
    }
    for (let i = 0; i < 20; i++) {
      insertTx(env.db, { endpoint_hash: 'safe-target', status: 'verified', source: 'observer' });
    }
    // probe + observer sont tous deux mappés sur bayesian 'probe' → 1 source
    // pour garantir une 2ème source, on ajoute des reports
    for (let i = 0; i < 20; i++) {
      insertTx(env.db, { endpoint_hash: 'safe-target', status: 'verified', source: 'report' });
    }
    const res = await request(env.app).get('/api/bayesian/safe-target?reporter_tier=nip98');
    expect(res.status).toBe(200);
    expect(res.body.convergence.converged).toBe(true);
    expect(res.body.convergence.sources_above_threshold.length).toBeGreaterThanOrEqual(2);
    expect(res.body.verdict).toBe('SAFE');
    expect(res.body.verdict_reason).toMatch(/converged/);
  });

  it('retourne verdict RISKY quand signal négatif clair (p < 0.50)', async () => {
    // 20 failures + 5 successes → p ≈ 5/25 = 0.20
    for (let i = 0; i < 20; i++) {
      insertTx(env.db, { endpoint_hash: 'risky-target', status: 'failed', source: 'probe' });
    }
    for (let i = 0; i < 5; i++) {
      insertTx(env.db, { endpoint_hash: 'risky-target', status: 'verified', source: 'probe' });
    }
    const res = await request(env.app).get('/api/bayesian/risky-target');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('RISKY');
    expect(res.body.p_success).toBeLessThan(0.50);
    expect(res.body.verdict_reason).toMatch(/p_success/);
  });

  it('hérite du prior operator quand query contient operator_id avec données', async () => {
    // Alimente le prior operator sur 30d (fenêtre fallback quand pas de données endpoint)
    const opAgg = new OperatorAggregateRepository(env.db);
    opAgg.upsert('op-rich', '30d', { successDelta: 40, failureDelta: 5, updatedAt: NOW });
    const res = await request(env.app).get('/api/bayesian/new-target?operator_id=op-rich');
    expect(res.status).toBe(200);
    expect(res.body.prior_source).toBe('operator');
  });

  it('valide les paramètres — reporter_tier invalide → 400', async () => {
    const res = await request(env.app).get('/api/bayesian/x?reporter_tier=superadmin');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('le champ weight_total d\'une source reflète la pondération par source_weight', async () => {
    // 10 reports (tier medium = 0.5) → weight_total ≈ 5
    for (let i = 0; i < 10; i++) {
      insertTx(env.db, { endpoint_hash: 'weight-target', status: 'verified', source: 'report' });
    }
    const res = await request(env.app).get('/api/bayesian/weight-target?reporter_tier=medium');
    expect(res.status).toBe(200);
    expect(res.body.sources.report).not.toBeNull();
    // weight_total = sum(0.5 × exp(-age/τ)) ≤ 10×0.5 = 5.0 ; et > 0
    expect(res.body.sources.report.weight_total).toBeGreaterThan(0);
    expect(res.body.sources.report.weight_total).toBeLessThanOrEqual(5.0);
  });

  it('le champ sources n\'a que les 3 clés attendues — pas de fuite de shape', async () => {
    const res = await request(env.app).get('/api/bayesian/any');
    expect(Object.keys(res.body.sources).sort()).toEqual(['paid', 'probe', 'report']);
  });
});
