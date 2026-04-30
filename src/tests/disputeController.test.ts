// Phase 2 (2026-05-01) — POST /api/dispute/:ledger_id integration tests.
//
// Cover: NIP-98 enforcement, ownership verification (signer pubkey ==
// operator owner of the candidate URL), Tier-2-only disputability,
// uniqueness on (ledger_id, operator_pubkey), and not-found / invalid
// id paths.
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
import { DisputeController } from '../controllers/disputeController';
import { RefundLedgerRepository } from '../repositories/refundLedgerRepository';
import { RefundDisputeRepository } from '../repositories/refundDisputeRepository';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { errorHandler } from '../middleware/errorHandler';
import { endpointHash } from '../utils/urlCanonical';
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
    tags.push(['payload', crypto.createHash('sha256').update(body, 'utf8').digest('hex')]);
  } else {
    tags.push(['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
  }
  const template = {
    kind: 27235,
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

describe('/api/dispute (operator NIP-98 contest)', () => {
  let pool: Pool;
  let refundLedgerRepo: RefundLedgerRepository;
  let refundDisputeRepo: RefundDisputeRepository;
  let fulfillJobRepo: FulfillJobRepository;
  let operatorService: OperatorService;
  let ownerships: OperatorOwnershipRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    refundLedgerRepo = new RefundLedgerRepository(pool);
    refundDisputeRepo = new RefundDisputeRepository(pool);
    fulfillJobRepo = new FulfillJobRepository(pool);
    const operators = new OperatorRepository(pool);
    const identities = new OperatorIdentityRepository(pool);
    ownerships = new OperatorOwnershipRepository(pool);
    operatorService = new OperatorService(
      operators,
      identities,
      ownerships,
      new EndpointStreamingPosteriorRepository(pool),
      new NodeStreamingPosteriorRepository(pool),
      new ServiceStreamingPosteriorRepository(pool),
    );
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  function buildApp(): express.Express {
    const controller = new DisputeController({
      refundLedgerRepo,
      refundDisputeRepo,
      operatorService,
    });
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.set('trust proxy', 1);
    app.post('/api/dispute/:ledger_id', controller.open);
    app.use(errorHandler);
    return app;
  }

  async function seedLedger(opts: {
    candidateUrl: string;
    classification: import('../repositories/refundLedgerRepository').RefundClassification;
    agentPubkey?: string;
  }): Promise<number> {
    await fulfillJobRepo.create({
      job_id: 'job-' + Math.random().toString(36).slice(2, 10),
      agent_pubkey: opts.agentPubkey ?? 'agent-x',
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: Math.floor(Date.now() / 1000),
    });
    const last = await pool.query<{ job_id: string }>(
      'SELECT job_id FROM fulfill_jobs ORDER BY created_at DESC LIMIT 1',
    );
    const result = await refundLedgerRepo.record({
      job_id: last.rows[0].job_id,
      candidate_url: opts.candidateUrl,
      agent_pubkey: opts.agentPubkey ?? 'agent-x',
      sats_absorbed: 5,
      classification: opts.classification,
      ts: Math.floor(Date.now() / 1000),
    });
    return result.ledger_id;
  }

  async function seedOperatorOwnsEndpoint(operatorPubkey: string, candidateUrl: string): Promise<void> {
    const urlHash = endpointHash(candidateUrl);
    // Mirror serviceRegisterController pattern: operator_id IS the npub.
    // Register the operator first (FK in operator_owns_endpoint).
    const operators = new OperatorRepository(pool);
    await operators.upsertPending(operatorPubkey);
    await operatorService.claimOwnership(operatorPubkey, 'endpoint', urlHash);
  }

  it('returns 401 when NIP-98 header is missing', async () => {
    const ledgerId = await seedLedger({ candidateUrl: 'https://x.example/a', classification: 'tier2_body_shape' });
    const app = buildApp();
    const res = await request(app).post(`/api/dispute/${ledgerId}`).send({ reason: 'r' });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid ledger_id', async () => {
    const app = buildApp();
    const body = JSON.stringify({ reason: 'r' });
    const url = `${BASE_URL}/api/dispute/abc`;
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post('/api/dispute/abc')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_ledger_id');
  });

  it('returns 404 when ledger row does not exist', async () => {
    const app = buildApp();
    const body = JSON.stringify({ reason: 'r' });
    const url = `${BASE_URL}/api/dispute/9999`;
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post('/api/dispute/9999')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(404);
  });

  it('returns 409 when ledger classification is Tier 1 (not disputable)', async () => {
    const ledgerId = await seedLedger({
      candidateUrl: 'https://x.example/a',
      classification: 'tier1_http_4xx',
    });
    const app = buildApp();
    const body = JSON.stringify({ reason: 'r' });
    const url = `${BASE_URL}/api/dispute/${ledgerId}`;
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_disputable');
  });

  it('returns 403 when no ownership record exists', async () => {
    const ledgerId = await seedLedger({
      candidateUrl: 'https://orphan.example/a',
      classification: 'tier2_body_shape',
    });
    const app = buildApp();
    const body = JSON.stringify({ reason: 'r' });
    const url = `${BASE_URL}/api/dispute/${ledgerId}`;
    const { auth } = signNip98(url, 'POST', body);
    const res = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_ownership_record');
  });

  it('returns 403 when signer is not the registered operator', async () => {
    const candidateUrl = 'https://owned.example/a';
    const ownerSk = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSk);
    const intruderSk = generateSecretKey();
    const ledgerId = await seedLedger({ candidateUrl, classification: 'tier2_body_shape' });
    await seedOperatorOwnsEndpoint(ownerPubkey, candidateUrl);

    const app = buildApp();
    const body = JSON.stringify({ reason: 'I want a dispute even though I do not own it' });
    const url = `${BASE_URL}/api/dispute/${ledgerId}`;
    const { auth } = signNip98(url, 'POST', body, intruderSk);
    const res = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_endpoint_owner');
  });

  it('happy path — owner can open a Tier 2 dispute', async () => {
    const candidateUrl = 'https://owned.example/api';
    const ownerSk = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSk);
    const ledgerId = await seedLedger({ candidateUrl, classification: 'tier2_body_shape' });
    await seedOperatorOwnsEndpoint(ownerPubkey, candidateUrl);

    const app = buildApp();
    const body = JSON.stringify({
      reason: 'response was a valid JSON envelope, heuristic miscount',
      evidence: { schema_url: 'https://example.com/schema.json' },
    });
    const url = `${BASE_URL}/api/dispute/${ledgerId}`;
    const { auth } = signNip98(url, 'POST', body, ownerSk);
    const res = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.dispute_id).toBeGreaterThan(0);
    expect(res.body.ledger_id).toBe(ledgerId);

    // Persisted with the right metadata.
    const dispute = await refundDisputeRepo.findById(res.body.dispute_id);
    expect(dispute?.operator_pubkey).toBe(ownerPubkey);
    expect(dispute?.status).toBe('open');
    expect(dispute?.reason).toContain('miscount');
  });

  it('returns 409 on duplicate dispute by the same operator', async () => {
    const candidateUrl = 'https://owned.example/dup';
    const ownerSk = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSk);
    const ledgerId = await seedLedger({ candidateUrl, classification: 'tier2_empty_body' });
    await seedOperatorOwnsEndpoint(ownerPubkey, candidateUrl);

    const app = buildApp();
    const url = `${BASE_URL}/api/dispute/${ledgerId}`;
    const baseTs = Math.floor(Date.now() / 1000);
    // First dispute — accepted.
    const body1 = JSON.stringify({ reason: 'first' });
    const auth1 = signNip98(url, 'POST', body1, ownerSk, baseTs).auth;
    const r1 = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth1)
      .set('Content-Type', 'application/json')
      .send(body1);
    expect(r1.status).toBe(201);

    // Second dispute by the same operator — refused.
    const body2 = JSON.stringify({ reason: 'second' });
    const auth2 = signNip98(url, 'POST', body2, ownerSk, baseTs + 1).auth;
    const r2 = await request(app)
      .post(`/api/dispute/${ledgerId}`)
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth2)
      .set('Content-Type', 'application/json')
      .send(body2);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('already_disputed');
  });
});
