// Phase 3 refactor — StreamingPosteriorRepository (C3).
//
// Garantis mathématiques et structurelles :
//   - ingest sur une row vierge pose α=α₀+success, β=β₀+failure, last_update=nowSec
//   - ingest successif : décroissance appliquée avant addition des nouveaux deltas
//   - readDecayed sans row → prior flat, nObsEffective = 0
//   - readDecayed avec row : (α,β) décroissent vers (α₀,β₀) à t→∞
//   - Δt=0 → pas de décroissance (identité)
//   - Δt=τ → facteur exp(-1) ≈ 0.368 sur l'excès
//   - CHECK constraint SQL sur source (observer rejeté) — garanti par v35,
//     on vérifie juste que le repo ne tente pas d'écrire 'observer'
//   - route repo : caller_hash/target_hash écrits à la création, inchangés ensuite
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
  decayPosterior,
} from '../repositories/streamingPosteriorRepository';
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_SECONDS,
} from '../config/bayesianConfig';
let testDb: TestDb;

const NOW = 1_776_000_000;

describe('decayPosterior — formule pure', () => {
  it('Δt=0 → identité (pas de décroissance)', async () => {
    const { alpha, beta } = decayPosterior(10, 3, NOW, NOW);
    expect(alpha).toBeCloseTo(10, 9);
    expect(beta).toBeCloseTo(3, 9);
  });

  it('Δt=τ → excès au-dessus du prior multiplié par e⁻¹', async () => {
    // α_stored=10 → excès = 10 - 1.5 = 8.5. Après décroissance e⁻¹ : 8.5/e + 1.5
    // β_stored=3 → excès = 3 - 1.5 = 1.5. Après décroissance e⁻¹ : 1.5/e + 1.5
    const { alpha, beta } = decayPosterior(10, 3, NOW, NOW + TAU_SECONDS);
    expect(alpha).toBeCloseTo(8.5 * Math.exp(-1) + DEFAULT_PRIOR_ALPHA, 9);
    expect(beta).toBeCloseTo(1.5 * Math.exp(-1) + DEFAULT_PRIOR_BETA, 9);
  });

  it('Δt→∞ → convergence vers le prior flat', async () => {
    const { alpha, beta } = decayPosterior(100, 50, 0, NOW + 365 * 86400);
    expect(alpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA, 2);
    expect(beta).toBeCloseTo(DEFAULT_PRIOR_BETA, 2);
  });

  it('atTs < lastUpdate → Δt clamp à 0 (jamais de « négation »)', async () => {
    const { alpha, beta } = decayPosterior(10, 3, NOW, NOW - 86400);
    expect(alpha).toBeCloseTo(10, 9);
    expect(beta).toBeCloseTo(3, 9);
  });
});

describe('EndpointStreamingPosteriorRepository', async () => {
  let db: Pool;
  let repo: EndpointStreamingPosteriorRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new EndpointStreamingPosteriorRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('ingest sur row vierge crée une ligne au prior + deltas', async () => {
    await repo.ingest('h1', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    const stored = await repo.findStored('h1', 'probe');
    expect(stored).toBeDefined();
    expect(stored!.posteriorAlpha).toBeCloseTo(DEFAULT_PRIOR_ALPHA + 1, 9);
    expect(stored!.posteriorBeta).toBeCloseTo(DEFAULT_PRIOR_BETA, 9);
    expect(stored!.lastUpdateTs).toBe(NOW);
    expect(stored!.totalIngestions).toBe(1);
  });

  it('ingest successif décroit puis additionne', async () => {
    // t=0 : 1 succès (α=2.5, β=1.5)
    await repo.ingest('h1', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    // t=τ : 1 nouvel échec. Avant d'additionner, l'état décroit :
    //   α_decayed = (2.5 - 1.5)/e + 1.5 = 1/e + 1.5 ≈ 1.868
    //   β_decayed = (1.5 - 1.5)/e + 1.5 = 1.5
    // Puis +1 sur β : β_final ≈ 2.5
    await repo.ingest('h1', 'probe', { successDelta: 0, failureDelta: 1, nowSec: NOW + TAU_SECONDS });

    const stored = await repo.findStored('h1', 'probe');
    expect(stored!.posteriorAlpha).toBeCloseTo(1 / Math.E + DEFAULT_PRIOR_ALPHA, 6);
    expect(stored!.posteriorBeta).toBeCloseTo(DEFAULT_PRIOR_BETA + 1, 6);
    expect(stored!.lastUpdateTs).toBe(NOW + TAU_SECONDS);
    expect(stored!.totalIngestions).toBe(2);
  });

  it('readDecayed sans row renvoie le prior flat', async () => {
    const dec = await repo.readDecayed('missing', 'probe', NOW);
    expect(dec.posteriorAlpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(dec.posteriorBeta).toBe(DEFAULT_PRIOR_BETA);
    expect(dec.nObsEffective).toBe(0);
    expect(dec.lastUpdateTs).toBe(0);
  });

  it('readDecayed applique la décroissance jusqu\'à atTs', async () => {
    // 5 succès à t=NOW → α ≈ 6.5, β ≈ 1.5, n_obs_effective ≈ 5
    for (let i = 0; i < 5; i++) {
      await repo.ingest('h2', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    }
    // Lecture à t=NOW+τ : excès multiplié par e⁻¹
    const dec = await repo.readDecayed('h2', 'probe', NOW + TAU_SECONDS);
    expect(dec.nObsEffective).toBeCloseTo(5 * Math.exp(-1), 6);
    expect(dec.posteriorAlpha).toBeCloseTo(5 * Math.exp(-1) + DEFAULT_PRIOR_ALPHA, 6);
  });

  it('readAllSourcesDecayed renvoie les 3 sources', async () => {
    await repo.ingest('h3', 'probe', { successDelta: 2, failureDelta: 0, nowSec: NOW });
    await repo.ingest('h3', 'report', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    // Pas d'ingestion 'paid' → prior flat attendu
    const sources = await repo.readAllSourcesDecayed('h3', NOW);
    expect(sources.probe.nObsEffective).toBeCloseTo(2, 9);
    expect(sources.report.nObsEffective).toBeCloseTo(1, 9);
    expect(sources.paid.nObsEffective).toBe(0);
  });

  it('CHECK constraint rejette une source "observer"', async () => {
    // Le repo n'exposant pas d'écriture directe, on teste via le SQL brut :
    await expect(
      db.query(
        `INSERT INTO endpoint_streaming_posteriors
         (url_hash, source, posterior_alpha, posterior_beta, last_update_ts)
         VALUES ($1, 'observer', 1.5, 1.5, $2)`,
        ['h4', NOW],
      ),
    ).rejects.toThrow(/check constraint|violates check/i);
  });

  it('pruneStale supprime les rows plus vieilles que le cutoff', async () => {
    await repo.ingest('old', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW - 90 * 86400 });
    await repo.ingest('recent', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    const deleted = await repo.pruneStale(NOW - 30 * 86400);
    expect(deleted).toBe(1);
    expect(await repo.findStored('old', 'probe')).toBeUndefined();
    expect(await repo.findStored('recent', 'probe')).toBeDefined();
  });
});

describe('RouteStreamingPosteriorRepository', async () => {
  let db: Pool;
  let repo: RouteStreamingPosteriorRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new RouteStreamingPosteriorRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('ingest stocke caller_hash et target_hash à la création', async () => {
    await repo.ingest('route-1', 'caller-A', 'target-B', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    const stored = await repo.findStored('route-1', 'probe');
    expect(stored!.callerHash).toBe('caller-A');
    expect(stored!.targetHash).toBe('target-B');
  });

  it('ingest successif met à jour α/β sans réécrire caller/target', async () => {
    await repo.ingest('route-2', 'caller-A', 'target-B', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    // Appel avec caller/target différents — l'UPDATE ne touche pas ces colonnes
    await repo.ingest('route-2', 'caller-X', 'target-Y', 'probe', { successDelta: 0, failureDelta: 1, nowSec: NOW + 86400 });
    const stored = await repo.findStored('route-2', 'probe');
    expect(stored!.callerHash).toBe('caller-A');
    expect(stored!.targetHash).toBe('target-B');
    expect(stored!.totalIngestions).toBe(2);
  });
});

describe('Node / Service / Operator repositories — smoke', async () => {
  let db: Pool;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
});

  afterEach(async () => { await teardownTestPool(testDb); });

  it('écrivent et relisent sur leur table dédiée', async () => {
    const nodeRepo = new NodeStreamingPosteriorRepository(db);
    const svcRepo = new ServiceStreamingPosteriorRepository(db);
    const opRepo = new OperatorStreamingPosteriorRepository(db);

    await nodeRepo.ingest('pk1', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    await svcRepo.ingest('sv1', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });
    await opRepo.ingest('op1', 'probe', { successDelta: 1, failureDelta: 0, nowSec: NOW });

    expect((await nodeRepo.findStored('pk1', 'probe'))!.posteriorAlpha).toBeCloseTo(2.5, 9);
    expect((await svcRepo.findStored('sv1', 'probe'))!.posteriorAlpha).toBeCloseTo(2.5, 9);
    expect((await opRepo.findStored('op1', 'probe'))!.posteriorAlpha).toBeCloseTo(2.5, 9);
  });
});
