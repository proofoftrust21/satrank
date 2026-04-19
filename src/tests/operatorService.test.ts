// Phase 7 — tests opérationnels de OperatorService (status 2/3, agrégation).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
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
import { OperatorService } from '../services/operatorService';
import { DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA } from '../config/bayesianConfig';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const operators = new OperatorRepository(db);
  const identities = new OperatorIdentityRepository(db);
  const ownerships = new OperatorOwnershipRepository(db);
  const endpointPosteriors = new EndpointStreamingPosteriorRepository(db);
  const nodePosteriors = new NodeStreamingPosteriorRepository(db);
  const servicePosteriors = new ServiceStreamingPosteriorRepository(db);
  const service = new OperatorService(
    operators,
    identities,
    ownerships,
    endpointPosteriors,
    nodePosteriors,
    servicePosteriors,
  );
  return { db, operators, identities, ownerships, endpointPosteriors, nodePosteriors, servicePosteriors, service };
}

describe('OperatorService — règle dure 2/3 preuves convergentes', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('upsertOperator crée un pending', () => {
    ctx.service.upsertOperator('op1', 1000);
    expect(ctx.operators.findById('op1')!.status).toBe('pending');
  });

  it('1 identité vérifiée → reste pending (seuil non atteint)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimIdentity('op1', 'dns', 'example.com');
    const status = ctx.service.markIdentityVerified('op1', 'dns', 'example.com', 'proof1');
    expect(status).toBe('pending');
    expect(ctx.operators.findById('op1')!.verification_score).toBe(1);
  });

  it('2 identités vérifiées → status verified (règle dure)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimIdentity('op1', 'dns', 'example.com');
    ctx.service.claimIdentity('op1', 'nip05', 'alice@example.com');
    ctx.service.markIdentityVerified('op1', 'dns', 'example.com', 'p1');
    const status = ctx.service.markIdentityVerified('op1', 'nip05', 'alice@example.com', 'p2');
    expect(status).toBe('verified');
    expect(ctx.operators.findById('op1')!.verification_score).toBe(2);
  });

  it('3 identités vérifiées → score 3, status verified', () => {
    ctx.service.upsertOperator('op1', 1000);
    for (const [type, value] of [
      ['dns', 'example.com'],
      ['nip05', 'alice@example.com'],
      ['ln_pubkey', '02abc'],
    ] as const) {
      ctx.service.claimIdentity('op1', type, value);
      ctx.service.markIdentityVerified('op1', type, value, `p-${type}`);
    }
    const row = ctx.operators.findById('op1')!;
    expect(row.status).toBe('verified');
    expect(row.verification_score).toBe(3);
  });

  it('status verified reste sticky si une preuve disparaît (pas de downgrade auto)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimIdentity('op1', 'dns', 'example.com');
    ctx.service.claimIdentity('op1', 'nip05', 'alice@example.com');
    ctx.service.markIdentityVerified('op1', 'dns', 'example.com', 'p1');
    ctx.service.markIdentityVerified('op1', 'nip05', 'alice@example.com', 'p2');
    expect(ctx.operators.findById('op1')!.status).toBe('verified');
    // Retire la preuve DNS.
    ctx.identities.remove('op1', 'dns', 'example.com');
    ctx.service.recomputeStatus('op1');
    // Score baisse à 1, mais status reste 'verified' (pas de downgrade auto).
    const after = ctx.operators.findById('op1')!;
    expect(after.verification_score).toBe(1);
    expect(after.status).toBe('verified');
  });

  it('rejected reste gelé (jamais auto-upgrade vers verified)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.operators.updateVerification('op1', 0, 'rejected');
    ctx.service.claimIdentity('op1', 'dns', 'a.com');
    ctx.service.claimIdentity('op1', 'nip05', 'b@c.com');
    ctx.service.markIdentityVerified('op1', 'dns', 'a.com', 'p1');
    const status = ctx.service.markIdentityVerified('op1', 'nip05', 'b@c.com', 'p2');
    expect(status).toBe('rejected');
  });

  it('recomputeStatus throw si operator inexistant', () => {
    expect(() => ctx.service.recomputeStatus('ghost')).toThrow(/not found/);
  });
});

describe('OperatorService — claimOwnership + verifyOwnership', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('claimOwnership node/endpoint/service persiste', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'node', 'pk1');
    ctx.service.claimOwnership('op1', 'endpoint', 'h1');
    ctx.service.claimOwnership('op1', 'service', 's1');
    const cat = ctx.service.getOperatorCatalog('op1')!;
    expect(cat.ownedNodes).toHaveLength(1);
    expect(cat.ownedEndpoints).toHaveLength(1);
    expect(cat.ownedServices).toHaveLength(1);
  });

  it('verifyOwnership pose verified_at', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'node', 'pk1', 1000);
    ctx.service.verifyOwnership('op1', 'node', 'pk1', 5000);
    const cat = ctx.service.getOperatorCatalog('op1')!;
    expect(cat.ownedNodes[0].verified_at).toBe(5000);
  });
});

describe('OperatorService — aggregateBayesianForOperator', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('operator sans ressource → prior flat, pSuccess NaN, nObs=0', () => {
    ctx.service.upsertOperator('op1', 1000);
    const agg = ctx.service.aggregateBayesianForOperator('op1', 1000);
    expect(agg.posteriorAlpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(agg.posteriorBeta).toBe(DEFAULT_PRIOR_BETA);
    expect(agg.nObsEffective).toBe(0);
    expect(Number.isNaN(agg.pSuccess)).toBe(true);
    expect(agg.resourcesCounted).toBe(0);
  });

  it('1 endpoint avec 10 succès → pSuccess ≈ 10+α₀ / 10+α₀+β₀', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'endpoint', 'h1', 1000);
    // Ingère 10 succès sur la source 'probe' pour l'endpoint h1.
    ctx.endpointPosteriors.ingest('h1', 'probe', { successDelta: 10, failureDelta: 0, nowSec: 1000 });

    const agg = ctx.service.aggregateBayesianForOperator('op1', 1000);
    // α = α₀ + 10, β = β₀ (observations décayées à Δt=0 → pas de perte)
    expect(agg.posteriorAlpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 10, 3);
    expect(agg.posteriorBeta).toBeCloseTo(DEFAULT_PRIOR_BETA, 3);
    expect(agg.nObsEffective).toBeCloseTo(10, 3);
    expect(agg.pSuccess).toBeGreaterThan(0.8);
    expect(agg.resourcesCounted).toBe(1);
  });

  it('2 endpoints additionnent leurs évidences (somme de pseudo-obs)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'endpoint', 'h1', 1000);
    ctx.service.claimOwnership('op1', 'endpoint', 'h2', 1000);
    ctx.endpointPosteriors.ingest('h1', 'probe', { successDelta: 5, failureDelta: 0, nowSec: 1000 });
    ctx.endpointPosteriors.ingest('h2', 'probe', { successDelta: 5, failureDelta: 5, nowSec: 1000 });

    const agg = ctx.service.aggregateBayesianForOperator('op1', 1000);
    expect(agg.nObsEffective).toBeCloseTo(15, 3);
    expect(agg.resourcesCounted).toBe(2);
    // Moyenne : 10 succès sur 15 obs → p_success ≈ (10 + α₀) / (15 + α₀ + β₀)
    const expected = (10 + DEFAULT_PRIOR_ALPHA) / (15 + DEFAULT_PRIOR_ALPHA + DEFAULT_PRIOR_BETA);
    expect(agg.pSuccess).toBeCloseTo(expected, 2);
  });

  it('agrège cross-types : 1 node + 1 endpoint + 1 service', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'node', 'pk1');
    ctx.service.claimOwnership('op1', 'endpoint', 'h1');
    ctx.service.claimOwnership('op1', 'service', 's1');
    ctx.nodePosteriors.ingest('pk1', 'report', { successDelta: 3, failureDelta: 1, nowSec: 1000 });
    ctx.endpointPosteriors.ingest('h1', 'probe', { successDelta: 2, failureDelta: 2, nowSec: 1000 });
    ctx.servicePosteriors.ingest('s1', 'paid', { successDelta: 5, failureDelta: 0, nowSec: 1000 });

    const agg = ctx.service.aggregateBayesianForOperator('op1', 1000);
    // Total obs = 3+1 + 2+2 + 5+0 = 13
    expect(agg.nObsEffective).toBeCloseTo(13, 3);
    expect(agg.resourcesCounted).toBe(3);
  });

  it('ne compte pas une ressource qui n\'a pas d\'évidence (excès=0)', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimOwnership('op1', 'endpoint', 'h-empty');
    ctx.service.claimOwnership('op1', 'endpoint', 'h-full');
    ctx.endpointPosteriors.ingest('h-full', 'probe', { successDelta: 3, failureDelta: 0, nowSec: 1000 });

    const agg = ctx.service.aggregateBayesianForOperator('op1', 1000);
    expect(agg.resourcesCounted).toBe(1); // h-empty n'est pas compté
    expect(agg.nObsEffective).toBeCloseTo(3, 3);
  });
});

describe('OperatorService — getOperatorCatalog', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('renvoie null pour un operator inconnu', () => {
    expect(ctx.service.getOperatorCatalog('ghost')).toBeNull();
  });

  it('renvoie le catalogue complet + agrégat', () => {
    ctx.service.upsertOperator('op1', 1000);
    ctx.service.claimIdentity('op1', 'dns', 'example.com');
    ctx.service.claimOwnership('op1', 'endpoint', 'h1', 1000);
    ctx.endpointPosteriors.ingest('h1', 'probe', { successDelta: 7, failureDelta: 0, nowSec: 1000 });

    const cat = ctx.service.getOperatorCatalog('op1', 1000)!;
    expect(cat.operator.operator_id).toBe('op1');
    expect(cat.identities).toHaveLength(1);
    expect(cat.ownedEndpoints).toHaveLength(1);
    expect(cat.aggregated.nObsEffective).toBeCloseTo(7, 3);
  });
});
