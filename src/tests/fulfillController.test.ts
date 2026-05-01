// Phase 1 (2026-05-01) — POST /api/fulfill controller integration tests.
//
// Cover: feature flag (off → 503), NIP-98 enforcement (missing → 401),
// body validation, cap consistency, rate limiting, and the success/refund/
// insufficient-balance branches dispatched from FulfillService.
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import express from 'express';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { FulfillController } from '../controllers/fulfillController';
import type {
  FulfillService,
  FulfillResult,
  FulfillRequest,
} from '../services/fulfillService';
import { errorHandler } from '../middleware/errorHandler';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

let testDb: TestDb;

function signNip98(
  url: string,
  method: string,
  body: string,
  sk?: Uint8Array,
  createdAtSec?: number,
): { auth: string; pubkey: string } {
  const secret = sk ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
  if (body.length > 0) {
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    tags.push(['payload', hash]);
  } else {
    tags.push(['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
  }
  const template = {
    kind: 27235,
    // Distinct created_at per call so the in-process replay cache (keyed
    // by event.id which depends on created_at) doesn't reject burst tests.
    created_at: createdAtSec ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, secret);
  return {
    auth: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`,
    pubkey,
  };
}

const BASE_URL = 'http://127.0.0.1:80';
const FULFILL_URL = `${BASE_URL}/api/fulfill`;

/** Stand-in fulfillService — records the input it received and returns a
 *  preset result so we can assert controller dispatch without exercising
 *  the orchestrator (covered separately in fulfillService.test.ts). */
function makeStubService(
  result: FulfillResult,
): { service: FulfillService; calls: FulfillRequest[] } {
  const calls: FulfillRequest[] = [];
  const service = {
    fulfill: async (req: FulfillRequest) => {
      calls.push(req);
      return result;
    },
  } as unknown as FulfillService;
  return { service, calls };
}

function buildApp(
  service: FulfillService,
  enabled: boolean,
  rateOverride?: { rateBucketSize?: number; rateRefillPerSec?: number },
): express.Express {
  const controller = new FulfillController({
    fulfillService: service,
    enabled,
    ...(rateOverride ?? {}),
  });
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.set('trust proxy', 1);
  app.post('/api/fulfill', controller.handle);
  app.post('/api/fulfill/quote', controller.quote);
  app.post('/api/fulfill/:job_id/execute', controller.executeHold);
  app.use(errorHandler);
  return app;
}

const BASE_BODY = {
  intent: { category: 'data', keywords: ['test'] },
  max_sats: 10,
  max_latency_ms: 5000,
};

describe('/api/fulfill controller', () => {
  let pool: Pool;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('returns 503 when feature flag is off', async () => {
    const { service } = makeStubService({
      status: 'success',
      job_id: 'x',
      body: 'b',
      preimage: 'p',
      candidate_url: 'u',
      attempts: [],
      sats_spent: 0,
      premium_sats: 0,
    });
    const app = buildApp(service, false);
    const res = await request(app).post('/api/fulfill').send(BASE_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('fulfill_disabled');
  });

  it('returns 401 when NIP-98 header is missing', async () => {
    const { service } = makeStubService({
      status: 'success',
      job_id: 'x',
      body: 'b',
      preimage: 'p',
      candidate_url: 'u',
      attempts: [],
      sats_spent: 0,
      premium_sats: 0,
    });
    const app = buildApp(service, true);
    const res = await request(app).post('/api/fulfill').send(BASE_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_auth');
  });

  it('returns 400 when body is malformed (zod validation)', async () => {
    const { service } = makeStubService({
      status: 'success',
      job_id: 'x',
      body: 'b',
      preimage: 'p',
      candidate_url: 'u',
      attempts: [],
      sats_spent: 0,
      premium_sats: 0,
    });
    const app = buildApp(service, true);
    const body = JSON.stringify({ wrong: 'shape' });
    const { auth } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
  });

  it('returns 400 when max_sats exceeds intent.budget_sats', async () => {
    const { service } = makeStubService({
      status: 'success',
      job_id: 'x', body: 'b', preimage: 'p', candidate_url: 'u',
      attempts: [], sats_spent: 0, premium_sats: 0,
    });
    const app = buildApp(service, true);
    const body = JSON.stringify({
      intent: { category: 'data', budget_sats: 5 },
      max_sats: 10,
      max_latency_ms: 5000,
    });
    const { auth } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('caps_inconsistent');
  });

  it('happy path — success response forwards orchestrator result', async () => {
    const { service, calls } = makeStubService({
      status: 'success',
      job_id: 'job-1',
      body: 'hello world',
      preimage: 'p'.repeat(64),
      candidate_url: 'https://op.example/api',
      attempts: [],
      sats_spent: 5,
      premium_sats: 1,
    });
    const app = buildApp(service, true);
    const body = JSON.stringify(BASE_BODY);
    const { auth, pubkey } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.job_id).toBe('job-1');
    expect(res.body.body).toBe('hello world');
    expect(res.body.sats_spent).toBe(5);
    // The agent_pubkey passed to the service must come from NIP-98.
    expect(calls).toHaveLength(1);
    expect(calls[0].agent_pubkey).toBe(pubkey);
  });

  it('refund branch returns 502 with attempts and reason', async () => {
    const { service } = makeStubService({
      status: 'refunded',
      job_id: 'job-r',
      attempts: [],
      reason: 'all_candidates_failed',
    });
    const app = buildApp(service, true);
    const body = JSON.stringify(BASE_BODY);
    const { auth } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(502);
    expect(res.body.status).toBe('refunded');
    expect(res.body.reason).toBe('all_candidates_failed');
  });

  it('insufficient balance branch returns 402 with required + available', async () => {
    const { service } = makeStubService({
      status: 'insufficient_balance',
      required_sats: 11,
      available_sats: 3,
    });
    const app = buildApp(service, true);
    const body = JSON.stringify(BASE_BODY);
    const { auth } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('insufficient_balance');
    expect(res.body.required_sats).toBe(11);
    expect(res.body.available_sats).toBe(3);
  });

  it('Phase 4 — POST /fulfill/quote returns 503 when feature flag is off', async () => {
    const { service } = makeStubService({
      status: 'success', job_id: 'x', body: 'b', preimage: 'p',
      candidate_url: 'u', attempts: [], sats_spent: 0, premium_sats: 0,
    });
    const app = buildApp(service, false);
    const res = await request(app).post('/api/fulfill/quote').send(BASE_BODY);
    expect(res.status).toBe(503);
  });

  it('Phase 4 — POST /fulfill/quote dispatches to service.quote() and forwards data', async () => {
    const calls: Array<{ intent: unknown; max_sats: number }> = [];
    const stub = {
      fulfill: async () => ({}) as never,
      quote: async (req: { intent: unknown; max_sats: number }) => {
        calls.push(req);
        return {
          candidates: [
            {
              rank: 1,
              endpoint_url: 'https://x.example/a',
              operator_pubkey: 'op-' + 'a'.repeat(60),
              invoice_sats_estimate: 7,
              premium_estimate: 1,
              total_estimate: 8,
              p_e2e: 0.7,
              p_e2e_pessimistic: 0.5,
              median_latency_ms: 50,
            },
          ],
          reserve_sats_max: 11,
          circuit_breaker_open: false,
        };
      },
    };
    const app = buildApp(stub as unknown as FulfillService, true);
    const res = await request(app).post('/api/fulfill/quote').send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.candidates).toHaveLength(1);
    expect(res.body.data.candidates[0].total_estimate).toBe(8);
    expect(res.body.data.reserve_sats_max).toBe(11);
    expect(res.body.data.circuit_breaker_open).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].max_sats).toBe(BASE_BODY.max_sats);
  });

  it('Phase 4 — circuit_breaker_open from fulfill maps to 503 with breaker context', async () => {
    const { service } = makeStubService({
      status: 'circuit_breaker_open',
      pool_balance_sats: -42,
      min_pool_sats: 10000,
    });
    const app = buildApp(service, true);
    const body = JSON.stringify(BASE_BODY);
    const { auth } = signNip98(FULFILL_URL, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('circuit_breaker_open');
    expect(res.body.pool_balance_sats).toBe(-42);
    expect(res.body.min_pool_sats).toBe(10000);
  });

  it('rate-limits more than the bucket size of fulfill calls per agent', async () => {
    const { service } = makeStubService({
      status: 'success',
      job_id: 'job-rl',
      body: 'b', preimage: 'p', candidate_url: 'u',
      attempts: [], sats_spent: 1, premium_sats: 1,
    });
    const app = buildApp(service, true, { rateBucketSize: 2, rateRefillPerSec: 0.001 });
    const body = JSON.stringify(BASE_BODY);
    const sk = generateSecretKey();
    // Reuse the same agent pubkey across the burst — we sign 3 fresh events.
    let firstStatus = 0, secondStatus = 0, thirdStatus = 0;
    const baseTs = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i++) {
      const { auth } = signNip98(FULFILL_URL, 'POST', body, sk, baseTs + i);
      const res = await request(app)
        .post('/api/fulfill')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      if (i === 0) firstStatus = res.status;
      if (i === 1) secondStatus = res.status;
      if (i === 2) thirdStatus = res.status;
    }
    expect(firstStatus).toBe(200);
    expect(secondStatus).toBe(200);
    expect(thirdStatus).toBe(429);
  });

  // ----- Audit fixes (Phase 6.1) on /api/fulfill/:job_id/execute -----

  it('audit L2 — non-UUID :job_id is rejected with 400 invalid_job_id', async () => {
    const { service } = makeStubService({ status: 'success' } as unknown as FulfillResult);
    const app = buildApp(service, true);
    const url = `${BASE_URL}/api/fulfill/not-a-uuid-format/execute`;
    const body = JSON.stringify({ intent: { category: 'data' } });
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post('/api/fulfill/not-a-uuid-format/execute')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_job_id');
  });

  it('audit H1 — /execute rate-limits per-agent (token bucket separate from /api/fulfill)', async () => {
    // Stub returns a refunded result quickly so we can hammer the bucket.
    const fakeService = {
      executeHoldFulfill: async () => ({
        status: 'refunded' as const,
        job_id: '00000000-0000-0000-0000-000000000000',
        attempts: [],
        reason: 'job_not_found',
      }),
    } as unknown as FulfillService;
    const app = buildApp(fakeService, true, { rateBucketSize: 2, rateRefillPerSec: 0.001 });
    const jobId = '11111111-2222-3333-4444-555555555555';
    const url = `${BASE_URL}/api/fulfill/${jobId}/execute`;
    const body = JSON.stringify({ intent: { category: 'data' } });
    const sk = generateSecretKey();
    const baseTs = Math.floor(Date.now() / 1000);
    let third = 0;
    for (let i = 0; i < 3; i++) {
      const { auth } = signNip98(url, 'POST', body, sk, baseTs + i);
      const res = await request(app)
        .post(`/api/fulfill/${jobId}/execute`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      if (i === 2) third = res.status;
    }
    expect(third).toBe(429);
  });

  it('audit L1 — hold_mode_unavailable with unknown reason is sanitized to "unavailable"', async () => {
    const fakeService = {
      executeHoldFulfill: async () => ({
        status: 'hold_mode_unavailable' as const,
        reason: 'leaky LND error: rpc error: code=Unavailable desc=...',
      }),
    } as unknown as FulfillService;
    const app = buildApp(fakeService, true);
    const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const url = `${BASE_URL}/api/fulfill/${jobId}/execute`;
    const body = JSON.stringify({ intent: { category: 'data' } });
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post(`/api/fulfill/${jobId}/execute`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('unavailable');
  });
});
