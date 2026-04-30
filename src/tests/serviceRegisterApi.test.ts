// Excellence pass — integration tests for /api/services/register (v57).
//
// Covers:
//   - NIP-98 gate: missing / malformed / mismatched body → 401
//   - First-claim semantics: POST creates operator + claim
//   - Second-claim refusal: 409 ALREADY_CLAIMED on a different npub
//   - PATCH: non-owner 403, owner 200, partial fields
//   - DELETE: non-owner 403, owner 200 (deprecated=true)
//   - Audit log written for every attempt
//   - operator_owns_endpoint mirror written
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import crypto from 'node:crypto';
import request from 'supertest';
import express from 'express';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { ServiceRegisterLogRepository } from '../repositories/serviceRegisterLogRepository';
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
import { ServiceRegisterController } from '../controllers/serviceRegisterController';
import { errorHandler } from '../middleware/errorHandler';
import { endpointHash } from '../utils/urlCanonical';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

let testDb: TestDb;

function signNip98(url: string, method: string, body: string, sk?: Uint8Array, createdAtSec?: number): { auth: string; pubkey: string } {
  const secret = sk ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
  if (body.length > 0) {
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    tags.push(['payload', hash]);
  }
  const template = {
    kind: 27235,
    // Audit Tier 2F (2026-04-30) — event.id depends on created_at; tests
    // that sign multiple events with the same key + body must override
    // created_at to produce distinct ids, otherwise the new replay cache
    // rejects the second one (correctly, since it really is the same event).
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
const REGISTER_URL = `${BASE_URL}/api/services/register`;
const TARGET_URL = 'https://example.com/api/weather';
const OTHER_URL = 'https://other.example/api/data';

interface FakeCrawlerCalls {
  serviceUrl: string;
  meta?: { name?: string; description?: string; category?: string; provider?: string };
}

/** Stand-in for RegistryCrawler that doesn't make HTTP calls. Performs the
 *  same DB-side effects as the real crawler so the controller's downstream
 *  reads find a row to claim. Records invocations for assertions. */
function buildFakeCrawler(serviceEndpointRepo: ServiceEndpointRepository): {
  crawler: ConstructorParameters<typeof ServiceRegisterController>[0]['registryCrawler'];
  calls: FakeCrawlerCalls[];
} {
  const calls: FakeCrawlerCalls[] = [];
  const crawler = {
    async registerSelfSubmitted(serviceUrl: string, meta?: FakeCrawlerCalls['meta']) {
      calls.push({ serviceUrl, meta });
      const agentHash = 'a'.repeat(64);
      await serviceEndpointRepo.upsert(agentHash, serviceUrl, 402, 50, 'self_registered');
      const updated: string[] = [];
      if (meta) {
        const existing = await serviceEndpointRepo.findByUrl(serviceUrl);
        const patch = {
          name: existing?.name ?? (meta.name?.trim() || null),
          description: existing?.description ?? (meta.description?.trim() || null),
          category: existing?.category ?? (meta.category?.trim() || null),
          provider: existing?.provider ?? (meta.provider?.trim() || null),
        };
        if (!existing?.name && patch.name) updated.push('name');
        if (!existing?.description && patch.description) updated.push('description');
        if (!existing?.category && patch.category) updated.push('category');
        if (!existing?.provider && patch.provider) updated.push('provider');
        await serviceEndpointRepo.updateMetadata(serviceUrl, patch);
      }
      return { agentHash, priceSats: 21, fieldsUpdated: updated };
    },
  } as unknown as NonNullable<ConstructorParameters<typeof ServiceRegisterController>[0]['registryCrawler']>;
  return { crawler, calls };
}

describe('/api/services/register (NIP-98 + audit)', () => {
  let pool: Pool;
  let serviceEndpointRepo: ServiceEndpointRepository;
  let registerLogRepo: ServiceRegisterLogRepository;
  let operatorService: OperatorService;
  let ownerships: OperatorOwnershipRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    serviceEndpointRepo = new ServiceEndpointRepository(pool);
    registerLogRepo = new ServiceRegisterLogRepository(pool);
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

  function buildApp(crawler: ConstructorParameters<typeof ServiceRegisterController>[0]['registryCrawler']): express.Express {
    const controller = new ServiceRegisterController({
      registryCrawler: crawler,
      serviceEndpointRepo,
      registerLogRepo,
      operatorService,
    });
    const app = express();
    app.use(express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        if (buf && buf.length > 0) req.rawBody = Buffer.from(buf);
      },
    }));
    app.post('/api/services/register', controller.register);
    app.patch('/api/services/register', controller.update);
    app.delete('/api/services/register', controller.remove);
    app.use(errorHandler);
    return app;
  }

  describe('POST — register', () => {
    it('rejects without Authorization (401 NIP98_INVALID)', async () => {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const res = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .send({ url: TARGET_URL });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('NIP98_INVALID');
    });

    it('rejects body modified after sign (payload_mismatch → 401)', async () => {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const signedBody = JSON.stringify({ url: TARGET_URL });
      const { auth } = signNip98(REGISTER_URL, 'POST', signedBody);
      const res = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(`{"url":"${OTHER_URL}"}`);
      expect(res.status).toBe(401);
    });

    it('first POST claims ownership + writes audit log + creates operator', async () => {
      const { crawler, calls } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL, name: 'Weather API', category: 'weather' });
      const { auth, pubkey } = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.url).toBe(TARGET_URL);
      expect(res.body.data.operator_id).toBe(pubkey);
      expect(res.body.data.url_hash).toBe(endpointHash(TARGET_URL));
      expect(calls).toHaveLength(1);
      expect(calls[0].serviceUrl).toBe(TARGET_URL);

      // operator_id persisted on service_endpoints.
      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.operator_id).toBe(pubkey);

      // operator_owns_endpoint mirror.
      const claimed = await ownerships.listEndpoints(pubkey);
      expect(claimed.map(c => c.url_hash)).toContain(endpointHash(TARGET_URL));

      // Audit-log row.
      const logs = await registerLogRepo.findByNpub(pubkey);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('register');
      expect(logs[0].success).toBe(true);
      expect(logs[0].nip98_event_id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('second POST by a different npub returns 409 ALREADY_CLAIMED + logs the failure', async () => {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL });

      // Operator A claims.
      const { auth: authA, pubkey: pubA } = signNip98(REGISTER_URL, 'POST', body);
      const okRes = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', authA)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(okRes.status).toBe(201);

      // Operator B re-tries.
      const { auth: authB, pubkey: pubB } = signNip98(REGISTER_URL, 'POST', body);
      const conflictRes = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', authB)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.error.code).toBe('ALREADY_CLAIMED');

      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.operator_id).toBe(pubA);

      const logsB = await registerLogRepo.findByNpub(pubB);
      expect(logsB).toHaveLength(1);
      expect(logsB[0].action).toBe('register');
      expect(logsB[0].success).toBe(false);
      expect(logsB[0].reason).toBe('already_claimed_by_another_operator');
    });

    it('idempotent re-POST by the same npub succeeds', async () => {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL, name: 'first' });
      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);
      // Use distinct created_at so the two signed events have distinct ids
      // — otherwise the audit-Tier-2F replay cache would reject the second
      // call as a replay (correctly, since identical inputs produce
      // identical event ids under deterministic Schnorr signing).
      const first = signNip98(REGISTER_URL, 'POST', body, sk, now);
      const r1 = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', first.auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(r1.status).toBe(201);

      const second = signNip98(REGISTER_URL, 'POST', body, sk, now + 1);
      const r2 = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', second.auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(r2.status).toBe(201);
      expect(r2.body.data.operator_id).toBe(first.pubkey);
    });
  });

  describe('PATCH — update', () => {
    async function seedClaim(): Promise<{ pubkey: string; sk: Uint8Array }> {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const sk = generateSecretKey();
      const body = JSON.stringify({ url: TARGET_URL, name: 'before' });
      const { auth, pubkey } = signNip98(REGISTER_URL, 'POST', body, sk);
      const r = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(r.status).toBe(201);
      return { pubkey, sk };
    }

    it('owner can update metadata (200)', async () => {
      const { sk, pubkey } = await seedClaim();
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL, name: 'after', description: 'new desc' });
      const { auth } = signNip98(REGISTER_URL, 'PATCH', body, sk);
      const res = await request(app)
        .patch('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(200);
      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.name).toBe('after');
      expect(ep?.description).toBe('new desc');
      expect(ep?.operator_id).toBe(pubkey);

      const logs = await registerLogRepo.findByNpub(pubkey);
      const updateLogs = logs.filter(l => l.action === 'update');
      expect(updateLogs).toHaveLength(1);
      expect(updateLogs[0].success).toBe(true);
    });

    it('non-owner cannot update (403 NOT_OWNER)', async () => {
      await seedClaim();
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL, name: 'evil' });
      const { auth } = signNip98(REGISTER_URL, 'PATCH', body); // fresh sk
      const res = await request(app)
        .patch('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_OWNER');
      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.name).toBe('before');
    });

    it('returns 404 when the URL is unknown', async () => {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: 'https://nope.example/x', name: 'n' });
      const { auth } = signNip98(REGISTER_URL, 'PATCH', body);
      const res = await request(app)
        .patch('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE — soft-delete', () => {
    async function seedClaim(): Promise<{ pubkey: string; sk: Uint8Array }> {
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const sk = generateSecretKey();
      const body = JSON.stringify({ url: TARGET_URL });
      const { auth, pubkey } = signNip98(REGISTER_URL, 'POST', body, sk);
      const r = await request(app)
        .post('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(r.status).toBe(201);
      return { pubkey, sk };
    }

    it('owner can soft-delete (200, deprecated=true)', async () => {
      const { sk, pubkey } = await seedClaim();
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL, reason: 'shutting down' });
      const { auth } = signNip98(REGISTER_URL, 'DELETE', body, sk);
      const res = await request(app)
        .delete('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(200);
      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.deprecated).toBe(true);
      expect(ep?.deprecated_reason).toContain('shutting down');

      const logs = await registerLogRepo.findByNpub(pubkey);
      const delLogs = logs.filter(l => l.action === 'delete');
      expect(delLogs).toHaveLength(1);
      expect(delLogs[0].success).toBe(true);
    });

    it('non-owner cannot delete (403)', async () => {
      await seedClaim();
      const { crawler } = buildFakeCrawler(serviceEndpointRepo);
      const app = buildApp(crawler);
      const body = JSON.stringify({ url: TARGET_URL });
      const { auth } = signNip98(REGISTER_URL, 'DELETE', body);
      const res = await request(app)
        .delete('/api/services/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(403);
      const ep = await serviceEndpointRepo.findByUrl(TARGET_URL);
      expect(ep?.deprecated).toBe(false);
    });
  });
});
