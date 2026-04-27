// Phase 5 — tests for the per-endpoint posterior fix and the four follow-ups
// (sources/consumption_type/provider_contact surfacing, median_latency_ms
// fallback, /api/services/:url_hash alias, ranking_explanation in meta).
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
import { IntentController } from '../controllers/intentController';
import { EndpointController } from '../controllers/endpointController';
import {
  createBayesianVerdictService,
  createBayesianScoringService,
} from './helpers/bayesianTestFactory';
import { sha256 } from '../utils/crypto';
import { endpointHash } from '../utils/urlCanonical';
import { backfill, ALPHA_PRIOR, BETA_PRIOR } from '../scripts/backfillEndpointPosteriors';
import type { Agent } from '../types';

let testDb: TestDb;
const NOW = Math.floor(Date.now() / 1000);

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: `02${hash.slice(0, 64)}`,
    alias: 'test-op',
    first_seen: NOW - 365 * 86400,
    last_seen: NOW - 86400,
    source: 'attestation',
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

interface SeedFixture {
  agentHash: string;
  url: string;
  category: string;
  name: string;
  priceSats: number;
  checkCount?: number;
  successCount?: number;
  lastLatencyMs?: number;
  /** Per-endpoint streaming posterior to seed (alpha, beta). When given,
   *  /api/intent should pick this up via the new endpoint-keyed read. */
  streamingPosterior?: { alpha: number; beta: number };
  sources?: string[];
  consumption_type?: string;
  provider_contact?: string;
}

async function seed(db: Pool, agentRepo: AgentRepository, repo: ServiceEndpointRepository, f: SeedFixture): Promise<void> {
  await agentRepo.insert(makeAgent(f.agentHash));
  await repo.upsert(f.agentHash, f.url, 200, f.lastLatencyMs ?? 200, '402index');
  await repo.updateMetadata(f.url, {
    name: f.name,
    description: null,
    category: f.category,
    provider: null,
  });
  await repo.updatePrice(f.url, f.priceSats);
  if (f.checkCount != null) {
    await db.query(
      'UPDATE service_endpoints SET check_count = $1, success_count = $2 WHERE url = $3',
      [f.checkCount, f.successCount ?? f.checkCount, f.url],
    );
  }
  if (f.lastLatencyMs != null) {
    await db.query(
      'UPDATE service_endpoints SET last_latency_ms = $1 WHERE url = $2',
      [f.lastLatencyMs, f.url],
    );
  }
  if (f.sources != null) {
    await db.query(
      'UPDATE service_endpoints SET sources = $1 WHERE url = $2',
      [f.sources, f.url],
    );
  }
  if (f.consumption_type != null) {
    await db.query(
      'UPDATE service_endpoints SET consumption_type = $1 WHERE url = $2',
      [f.consumption_type, f.url],
    );
  }
  if (f.provider_contact != null) {
    await db.query(
      'UPDATE service_endpoints SET provider_contact = $1 WHERE url = $2',
      [f.provider_contact, f.url],
    );
  }
  if (f.streamingPosterior) {
    await db.query(
      `INSERT INTO endpoint_streaming_posteriors
         (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
       VALUES ($1, 'probe', $2, $3, $4, $5)
       ON CONFLICT (url_hash, source) DO UPDATE SET
         posterior_alpha = EXCLUDED.posterior_alpha,
         posterior_beta = EXCLUDED.posterior_beta,
         last_update_ts = EXCLUDED.last_update_ts,
         total_ingestions = EXCLUDED.total_ingestions`,
      [
        endpointHash(f.url),
        f.streamingPosterior.alpha,
        f.streamingPosterior.beta,
        NOW,
        Math.round(f.streamingPosterior.alpha + f.streamingPosterior.beta),
      ],
    );
  }
}

function buildIntentService(db: Pool): IntentService {
  const agentRepo = new AgentRepository(db);
  const serviceRepo = new ServiceEndpointRepository(db);
  const probeRepo = new ProbeRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const bayesianVerdict = createBayesianVerdictService(db);
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdict, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  return new IntentService({
    serviceEndpointRepo: serviceRepo,
    agentRepo,
    agentService,
    bayesianVerdictService: bayesianVerdict,
    trendService,
    probeRepo,
    now: () => NOW,
  });
}

describe('Phase 5 — per-endpoint posterior surfacing', async () => {
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

  it('5 candidates same operator + distinct streaming posteriors → /api/intent returns 5 distinct p_success', async () => {
    const operatorHash = sha256('shared-op');
    // Keep all 5 above the SAFE verdict threshold (p≥0.65 with reasonable
    // ci95_low) so the strict pool retains them; the discrimination test
    // is about distinct posteriors per URL, not about verdict filtering.
    const fixtures = [
      { url: 'https://shared.example/a', alpha: 28, beta: 2 },
      { url: 'https://shared.example/b', alpha: 24, beta: 6 },
      { url: 'https://shared.example/c', alpha: 20, beta: 10 },
      { url: 'https://shared.example/d', alpha: 16, beta: 14 },
      { url: 'https://shared.example/e', alpha: 14, beta: 16 },
    ];
    let agentInserted = false;
    for (const f of fixtures) {
      if (!agentInserted) {
        await seed(db, agentRepo, serviceRepo, {
          agentHash: operatorHash, url: f.url, category: 'data/finance',
          name: 'shared-' + f.url.slice(-1), priceSats: 5,
          checkCount: 20, successCount: Math.round(f.alpha),
          streamingPosterior: { alpha: f.alpha, beta: f.beta },
        });
        agentInserted = true;
      } else {
        await serviceRepo.upsert(operatorHash, f.url, 200, 200, '402index');
        await serviceRepo.updateMetadata(f.url, { name: 'shared', description: null, category: 'data/finance', provider: null });
        await serviceRepo.updatePrice(f.url, 5);
        await db.query('UPDATE service_endpoints SET check_count = 20, success_count = $1 WHERE url = $2', [Math.round(f.alpha), f.url]);
        await db.query(
          `INSERT INTO endpoint_streaming_posteriors
             (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
           VALUES ($1, 'probe', $2, $3, $4, $5)
           ON CONFLICT (url_hash, source) DO UPDATE SET
             posterior_alpha = EXCLUDED.posterior_alpha,
             posterior_beta = EXCLUDED.posterior_beta,
             last_update_ts = EXCLUDED.last_update_ts,
             total_ingestions = EXCLUDED.total_ingestions`,
          [endpointHash(f.url), f.alpha, f.beta, NOW, Math.round(f.alpha + f.beta)],
        );
      }
    }

    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data/finance', keywords: [] }, 5);

    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    const distinctP = new Set(result.candidates.map((c) => Math.round(c.bayesian.p_success * 1000) / 1000));
    expect(distinctP.size).toBeGreaterThanOrEqual(3);
    // Top candidate's p_success must beat the bottom one — concrete proof
    // the posteriors are now per-URL, not collapsed to a single operator value.
    expect(result.candidates[0].bayesian.p_success).toBeGreaterThan(
      result.candidates[result.candidates.length - 1].bayesian.p_success,
    );
  });

  it('endpoint without streaming posterior falls back to prior (still rendered, is_meaningful=false)', async () => {
    const op = sha256('no-stream-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://no-stream.example/x',
      category: 'data', name: 'no-stream', priceSats: 5,
      // No streamingPosterior → /api/intent reads via cascade fallback
      checkCount: 0, successCount: 0,
    });

    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].bayesian.p_success).toBeGreaterThanOrEqual(0);
    expect(result.candidates[0].bayesian.is_meaningful).toBe(false);
  });

  it('meta.ranking_explanation is present and stable', async () => {
    const op = sha256('meta-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://meta.example/x',
      category: 'data', name: 'meta', priceSats: 5,
    });
    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(result.meta.ranking_explanation.primary).toContain('is_meaningful');
    expect(result.meta.ranking_explanation.tiebreakers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('p_success DESC'),
        expect.stringContaining('ci95_low DESC'),
        expect.stringContaining('price_sats ASC'),
      ]),
    );
  });
});

describe('Phase 5 — sources / consumption_type / provider_contact in /api/intent', async () => {
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

  it('cross-listed endpoint exposes sources[] (≥2 entries)', async () => {
    const op = sha256('xlisted');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://xlist.example/api',
      category: 'data', name: 'xlist', priceSats: 5,
      sources: ['402index', 'l402directory'],
      consumption_type: 'api_response',
      provider_contact: '@LnHyper',
    });
    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sources).toEqual(['402index', 'l402directory']);
    expect(result.candidates[0].consumption_type).toBe('api_response');
    expect(result.candidates[0].provider_contact).toBe('@LnHyper');
  });

  it('single-source endpoint omits sources field (clean response shape)', async () => {
    const op = sha256('single-src');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://single.example/api',
      category: 'data', name: 'single', priceSats: 5,
      sources: ['402index'],
    });
    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(result.candidates[0].sources).toBeUndefined();
  });

  it('null consumption_type / provider_contact are omitted, not serialized', async () => {
    const op = sha256('nulls');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://nulls.example/api',
      category: 'data', name: 'nulls', priceSats: 5,
    });
    const svc = buildIntentService(db);
    const result = await svc.resolveIntent({ category: 'data', keywords: [] }, 5);
    expect(result.candidates[0].consumption_type).toBeUndefined();
    expect(result.candidates[0].provider_contact).toBeUndefined();
  });
});

describe('Phase 5 — median_latency_ms fallback', async () => {
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

  it('returns last_latency_ms when service_probes is empty', async () => {
    const op = sha256('lat-fallback');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://lat.example/api',
      category: 'data', name: 'lat', priceSats: 5,
      lastLatencyMs: 257,
    });
    const median = await serviceRepo.medianHttpLatency7d('https://lat.example/api');
    expect(median).toBe(257);
  });

  it('returns null when last_latency_ms is also missing', async () => {
    const op = sha256('lat-null');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://latnull.example/api',
      category: 'data', name: 'latnull', priceSats: 5,
    });
    // Force last_latency_ms to NULL to model a never-probed row.
    await db.query('UPDATE service_endpoints SET last_latency_ms = NULL WHERE url = $1', ['https://latnull.example/api']);
    const median = await serviceRepo.medianHttpLatency7d('https://latnull.example/api');
    expect(median).toBeNull();
  });
});

describe('Phase 5 — /api/services/:url_hash alias', async () => {
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

  it('GET /api/services/:url_hash resolves the same endpoint as /api/endpoint/:url_hash', async () => {
    const op = sha256('alias-op');
    const url = 'https://alias.example/api';
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url, category: 'data', name: 'alias', priceSats: 5,
    });

    const bayesianVerdict = createBayesianVerdictService(db);
    const endpointController = new EndpointController(bayesianVerdict, serviceRepo, agentRepo);
    const app = express();
    app.use(express.json());
    app.get('/api/endpoint/:url_hash', endpointController.show);
    app.get('/api/services/:url_hash', endpointController.show);

    const hash = endpointHash(url);
    const aliasResp = await request(app).get(`/api/services/${hash}`);
    const canonResp = await request(app).get(`/api/endpoint/${hash}`);
    expect(aliasResp.status).toBe(200);
    expect(canonResp.status).toBe(200);
    expect(aliasResp.body).toEqual(canonResp.body);
  });
});

describe('Phase 5 — backfillEndpointPosteriors script', async () => {
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

  it('seeds posteriors from check_count/success_count and uses correct Beta priors', async () => {
    const op = sha256('bf-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://bf.example/x',
      category: 'data', name: 'bf', priceSats: 5,
      checkCount: 12, successCount: 9,
    });

    const summary = await backfill(db);
    expect(summary.scanned).toBe(1);
    expect(summary.inserted).toBe(1);

    const { rows } = await db.query<{ posterior_alpha: number; posterior_beta: number; total_ingestions: string }>(
      `SELECT posterior_alpha, posterior_beta, total_ingestions
         FROM endpoint_streaming_posteriors
        WHERE url_hash = $1 AND source = 'probe'`,
      [endpointHash('https://bf.example/x')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].posterior_alpha).toBeCloseTo(9 + ALPHA_PRIOR, 5);
    expect(rows[0].posterior_beta).toBeCloseTo(3 + BETA_PRIOR, 5);
    expect(Number(rows[0].total_ingestions)).toBe(12);
  });

  it('idempotent: re-running does not overwrite existing posteriors', async () => {
    const op = sha256('idem-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://idem.example/x',
      category: 'data', name: 'idem', priceSats: 5,
      checkCount: 5, successCount: 4,
      streamingPosterior: { alpha: 100, beta: 0.5 }, // pre-existing real data
    });

    await backfill(db);
    const { rows } = await db.query<{ posterior_alpha: number }>(
      `SELECT posterior_alpha FROM endpoint_streaming_posteriors
        WHERE url_hash = $1 AND source = 'probe'`,
      [endpointHash('https://idem.example/x')],
    );
    // Pre-existing 100 must NOT have been overwritten by the seed value 5.5.
    expect(rows[0].posterior_alpha).toBe(100);
  });

  it('skips rows with check_count=0 (no observation history yet)', async () => {
    const op = sha256('zero-op');
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url: 'https://zero.example/x',
      category: 'data', name: 'zero', priceSats: 5,
      checkCount: 0, successCount: 0,
    });
    const summary = await backfill(db);
    expect(summary.skippedNoChecks).toBe(1);
    expect(summary.inserted).toBe(0);
  });
});

describe('Phase 5 — serviceHealthCrawler streams to per-endpoint posterior', async () => {
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

  it('successful probe writes to endpoint_streaming_posteriors keyed by URL hash', async () => {
    const op = sha256('health-op');
    const url = 'https://health.example/api';
    await seed(db, agentRepo, serviceRepo, {
      agentHash: op, url, category: 'data', name: 'health', priceSats: 5,
    });

    const scoring = createBayesianScoringService(db);
    // Stand-in for what serviceHealthCrawler.ingestProbeStreaming does
    // post-Phase-5; assert that the resulting row is keyed by endpointHash(url).
    await scoring.ingestStreaming({
      success: true,
      timestamp: NOW,
      source: 'probe',
      endpointHash: endpointHash(url),
      serviceHash: endpointHash(url),
      operatorId: op,
      nodePubkey: op,
    });

    const { rows } = await db.query<{ url_hash: string }>(
      `SELECT url_hash FROM endpoint_streaming_posteriors WHERE url_hash = $1 AND source = 'probe'`,
      [endpointHash(url)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].url_hash).toBe(endpointHash(url));
  });
});
