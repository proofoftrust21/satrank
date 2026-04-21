// Phase 7 — CHECKPOINT 2 : end-to-end integration test.
//
// Scénario : un operator synthétique "op-verified-producer" avec
//   - 2 identités vérifiées (dns + nip05) → status='verified'
//   - 2 endpoints rattachés avec evidence
//
// On vérifie que :
//   1. GET /api/operator/:id retourne un bayesian agrégé cohérent
//      (somme des 2 endpoints, status=verified, identities exposées)
//   2. resolveHierarchicalPrior(operatorId) adopte le prior operator
//      avec scaling 0.5× (Précision 1 / C10)
//   3. La chaîne est coherente : l'évidence injectée côté endpoint
//      est visible côté catalog ET côté operator_streaming aggregate
//      (via operator ingest déclenché sur la même ingestion).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
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
  OperatorStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { OperatorController } from '../controllers/operatorController';
import { errorHandler } from '../middleware/errorHandler';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  OPERATOR_PRIOR_WEIGHT,
  PRIOR_MIN_EFFECTIVE_OBS,
} from '../config/bayesianConfig';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('Phase 7 CHECKPOINT 2 — end-to-end synthetic operator scenario', async () => {
  let pool: Pool;
  let app: express.Express;
  let operatorService: OperatorService;
  let bayesianService: BayesianScoringService;
  let operators: OperatorRepository;
  let endpointPosteriors: EndpointStreamingPosteriorRepository;
  let operatorPosteriors: OperatorStreamingPosteriorRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    operators = new OperatorRepository(pool);
    const identities = new OperatorIdentityRepository(pool);
    const ownerships = new OperatorOwnershipRepository(pool);
    endpointPosteriors = new EndpointStreamingPosteriorRepository(pool);
    const nodePosteriors = new NodeStreamingPosteriorRepository(pool);
    const servicePosteriors = new ServiceStreamingPosteriorRepository(pool);
    operatorPosteriors = new OperatorStreamingPosteriorRepository(pool);
    const routePosteriors = new RouteStreamingPosteriorRepository(pool);
    const agentRepo = new AgentRepository(pool);
    const serviceEndpointRepo = new ServiceEndpointRepository(pool);

    operatorService = new OperatorService(
      operators,
      identities,
      ownerships,
      endpointPosteriors,
      nodePosteriors,
      servicePosteriors,
    );

    bayesianService = new BayesianScoringService(
      endpointPosteriors,
      servicePosteriors,
      operatorPosteriors,
      nodePosteriors,
      routePosteriors,
      new EndpointDailyBucketsRepository(pool),
      new ServiceDailyBucketsRepository(pool),
      new OperatorDailyBucketsRepository(pool),
      new NodeDailyBucketsRepository(pool),
      new RouteDailyBucketsRepository(pool),
    );

    const controller = new OperatorController({
      operatorService,
      serviceEndpointRepo,
      agentRepo,
    });

    app = express();
    app.use(express.json());
    app.get('/api/operator/:id', controller.show);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('synthetic operator + 2 identités vérifiées + 2 endpoints → GET cohérent + prior hiérarchique', async () => {
    const OP_ID = 'op-verified-producer';
    const EP1 = 'a'.repeat(64);
    const EP2 = 'b'.repeat(64);

    // 1. Upsert operator + 2 ownerships sur endpoints
    await operatorService.upsertOperator(OP_ID, NOW);
    await operatorService.claimOwnership(OP_ID, 'endpoint', EP1, NOW);
    await operatorService.claimOwnership(OP_ID, 'endpoint', EP2, NOW);

    // 2. Claim + mark verified sur 2 identités (dns + nip05)
    await operatorService.claimIdentity(OP_ID, 'dns', 'producer.example.com');
    await operatorService.markIdentityVerified(
      OP_ID, 'dns', 'producer.example.com',
      'dns:satrank-operator=op-verified-producer',
      NOW - 100,
    );
    await operatorService.claimIdentity(OP_ID, 'nip05', 'alice@example.com');
    await operatorService.markIdentityVerified(
      OP_ID, 'nip05', 'alice@example.com',
      'nip05:alice@example.com',
      NOW - 50,
    );

    // 3. Inject evidence sur les 2 endpoints ET sur l'operator_streaming
    //    (le ingest applicatif le fait simultanément via BayesianScoringService.ingestStreaming,
    //    qu'on simule ici en appelant les deux repos pour coller au hot path réel)
    await bayesianService.ingestStreaming({
      success: true, timestamp: NOW, source: 'probe',
      endpointHash: EP1, operatorId: OP_ID,
    });
    // 19 autres succès + 1 échec sur EP1 (20 obs)
    for (let i = 0; i < 19; i++) {
      await bayesianService.ingestStreaming({
        success: true, timestamp: NOW, source: 'probe',
        endpointHash: EP1, operatorId: OP_ID,
      });
    }
    await bayesianService.ingestStreaming({
      success: false, timestamp: NOW, source: 'probe',
      endpointHash: EP1, operatorId: OP_ID,
    });
    // 15 succès + 5 échecs sur EP2 (20 obs)
    for (let i = 0; i < 15; i++) {
      await bayesianService.ingestStreaming({
        success: true, timestamp: NOW, source: 'probe',
        endpointHash: EP2, operatorId: OP_ID,
      });
    }
    for (let i = 0; i < 5; i++) {
      await bayesianService.ingestStreaming({
        success: false, timestamp: NOW, source: 'probe',
        endpointHash: EP2, operatorId: OP_ID,
      });
    }

    // --- Assertion 1 : GET /api/operator/:id ---
    const res = await request(app).get(`/api/operator/${OP_ID}`);
    expect(res.status).toBe(200);
    const body = res.body.data;

    // status=verified (2 identités verified → seuil 2/3 atteint)
    expect(body.operator.status).toBe('verified');
    expect(body.operator.verification_score).toBe(2);

    // 2 identités exposées avec verified_at
    expect(body.identities).toHaveLength(2);
    for (const id of body.identities as Array<{ verified_at: number | null }>) {
      expect(id.verified_at).not.toBeNull();
    }

    // Catalog : 2 endpoints (Précision 2)
    expect(body.catalog.endpoints).toHaveLength(2);
    // resources_counted = 2 (tous les endpoints ont de l'evidence > prior)
    expect(body.bayesian.resources_counted).toBe(2);

    // Bayesian aggregate cohérent : 20 + 20 = 40 observations agrégées,
    // ~34 succès / 6 échecs → p_success ≈ 34/40 = 0.85. Le prior initial
    // (1.5, 1.5) ajoute un peu d'écart, on attend p ∈ [0.78, 0.88].
    expect(body.bayesian.p_success).toBeGreaterThan(0.78);
    expect(body.bayesian.p_success).toBeLessThan(0.88);
    expect(body.bayesian.n_obs_effective).toBeGreaterThan(38);
    expect(body.bayesian.n_obs_effective).toBeLessThan(42);
    expect(body.bayesian.posterior_alpha).toBeGreaterThan(DEFAULT_PRIOR_ALPHA + 30);
    expect(body.bayesian.posterior_beta).toBeGreaterThan(DEFAULT_PRIOR_BETA);

    // --- Assertion 2 : resolveHierarchicalPrior utilise bien l'operator ---
    // L'operator_streaming a été alimenté par 40 obs (34 succès, 6 échecs),
    // donc nObsEff raw ≈ 40 ≥ seuil 30 → adoption niveau operator.
    const prior = await bayesianService.resolveHierarchicalPrior({ operatorId: OP_ID });
    expect(prior.source).toBe('operator');

    // Scaling C10 : α_scaled = 1.5 + 0.5 × (α_op − 1.5). Évidence halved.
    const opRaw = await operatorPosteriors.readAllSourcesDecayed(OP_ID, NOW);
    const rawAlphaExcess =
      (opRaw.probe.posteriorAlpha - DEFAULT_PRIOR_ALPHA) +
      (opRaw.report.posteriorAlpha - DEFAULT_PRIOR_ALPHA) +
      (opRaw.paid.posteriorAlpha - DEFAULT_PRIOR_ALPHA);
    const rawBetaExcess =
      (opRaw.probe.posteriorBeta - DEFAULT_PRIOR_BETA) +
      (opRaw.report.posteriorBeta - DEFAULT_PRIOR_BETA) +
      (opRaw.paid.posteriorBeta - DEFAULT_PRIOR_BETA);

    // Le prior retourné doit correspondre à (α₀ + 0.5×excess_raw, β₀ + 0.5×excess_raw)
    expect(prior.alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + OPERATOR_PRIOR_WEIGHT * rawAlphaExcess, 3);
    expect(prior.beta).toBeCloseTo(DEFAULT_PRIOR_BETA + OPERATOR_PRIOR_WEIGHT * rawBetaExcess, 3);

    // --- Assertion 3 : seuil appliqué sur raw, pas scalé ---
    // Sanity check : le raw passe bien au-dessus du seuil.
    expect(rawAlphaExcess + rawBetaExcess).toBeGreaterThanOrEqual(PRIOR_MIN_EFFECTIVE_OBS);

    // --- Assertion 4 : un ENFANT peut tirer parti du prior operator ---
    // Nouveau endpoint "child" sans evidence propre : si on l'interroge avec
    // operatorId comme contexte, il hérite du prior operator scalé.
    const childPrior = await bayesianService.resolveHierarchicalPrior({
      operatorId: OP_ID,
      serviceHash: null,
    });
    expect(childPrior.source).toBe('operator');
    // p_success du prior scalé reflète le signal operator (~0.85 agrégé) mais
    // légèrement tiré vers 0.5 par le prior flat (effet shrinkage attendu).
    const pChild = childPrior.alpha / (childPrior.alpha + childPrior.beta);
    expect(pChild).toBeGreaterThan(0.7);
    expect(pChild).toBeLessThan(0.9);
  });

  it('operator avec < 30 obs cumulées → prior fallback (operator non adopté)', async () => {
    const OP_ID = 'op-too-thin';
    await operatorService.upsertOperator(OP_ID, NOW);
    await operatorService.claimOwnership(OP_ID, 'endpoint', 'c'.repeat(64), NOW);

    // Seulement 10 observations → en dessous du seuil de 30.
    for (let i = 0; i < 8; i++) {
      await bayesianService.ingestStreaming({
        success: true, timestamp: NOW, source: 'probe',
        endpointHash: 'c'.repeat(64), operatorId: OP_ID,
      });
    }
    for (let i = 0; i < 2; i++) {
      await bayesianService.ingestStreaming({
        success: false, timestamp: NOW, source: 'probe',
        endpointHash: 'c'.repeat(64), operatorId: OP_ID,
      });
    }

    const prior = await bayesianService.resolveHierarchicalPrior({ operatorId: OP_ID });
    // n_obs_eff raw = 10 < 30 → fallback (flat, pas operator)
    expect(prior.source).toBe('flat');
    expect(prior.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(prior.beta).toBe(DEFAULT_PRIOR_BETA);
  });

  it('operator unverified (0 identités) → GET retourne status=pending mais bayesian reste calculé', async () => {
    const OP_ID = 'op-pending';
    await operatorService.upsertOperator(OP_ID, NOW);
    await operatorService.claimOwnership(OP_ID, 'endpoint', 'd'.repeat(64), NOW);
    for (let i = 0; i < 10; i++) {
      await bayesianService.ingestStreaming({
        success: true, timestamp: NOW, source: 'probe',
        endpointHash: 'd'.repeat(64), operatorId: OP_ID,
      });
    }

    const res = await request(app).get(`/api/operator/${OP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.operator.status).toBe('pending');
    expect(res.body.data.operator.verification_score).toBe(0);
    expect(res.body.data.identities).toHaveLength(0);
    // Bayesian reste disponible — le ranking ne gate pas sur le status.
    expect(res.body.data.bayesian.p_success).toBeGreaterThan(0.8);
  });
});
